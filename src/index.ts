export interface Env {
  DB: D1Database;

  // Secrets / Vars
  REPLICATE_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_IDS: string; // comma-separated chat IDs: "111,222,333"
  BASE_URL: string; // e.g. "https://your-worker.your-subdomain.workers.dev"
  REPLICATE_WEBHOOK_SECRET?: string; // optional: extra safety on callback
  MANUAL_RUN_SECRET: string; // secret required for manual /run endpoint
}

type DeathEntry = {
  name: string;
  wiki_path: string;
  age: number | null;
  description: string | null;
  cause: string | null;
};

const TZ = "America/New_York";

/** UTILITIES */
const stripTags = (html: string) =>
  html.replace(/<sup[^>]*>.*?<\/sup>/gsi, "").replace(/<[^>]+>/g, "");

const toNYYear = () =>
  Number(
    new Date().toLocaleString("en-US", {
      timeZone: TZ,
      year: "numeric",
    })
  );

const dedupeSpaces = (s: string) => s.replace(/\s+/g, " ").trim();

const makeWikiUrl = (path: string) =>
  path.startsWith("http") ? path : `https://en.wikipedia.org${path}`;

/** Parse the Wikipedia HTML into entries.
 *  Heuristic: look for <li> items that include:
 *   <a href="/wiki/..." ...>Person</a>, <age>, <desc>, <cause>.
 *  We tolerate extra links/parentheses in the description.
 */
function parseWikipedia(html: string): DeathEntry[] {
  const results: DeathEntry[] = [];

  // remove references to avoid punctuation confusion
  const sanitized = html.replace(/<sup[^>]*>.*?<\/sup>/gsi, "");

  // Pull every <li>...</li>
  const liMatches = sanitized.matchAll(/<li>(.*?)<\/li>/gsi);
  for (const m of liMatches) {
    const li = m[1];

    // Find first anchor – assumed to be the person's page
    const a = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(li);
    if (!a) continue;

    const href = a[1];
    const personName = dedupeSpaces(stripTags(a[2]));

    // After the first anchor, we expect ", <age>, ..."
    const afterAnchor = li.slice(a.index! + a[0].length);
    const afterText = dedupeSpaces(stripTags(afterAnchor));
    const m2 = /^,\s*(\d{1,3})\s*,\s*(.*?)(?:\.\s*)?$/.exec(afterText);
    if (!m2) continue;

    const ageNum = Number(m2[1]);
    const rest = m2[2] || "";

    // Cause is (heuristically) the final comma-separated segment.
    const lastComma = rest.lastIndexOf(",");
    let description: string | null;
    let cause: string | null;
    
    description = dedupeSpaces(rest);

    // Filter: ensure we truly have "<name>, <age>, ..."
    if (!personName || Number.isNaN(ageNum)) continue;

    results.push({
      name: personName,
      wiki_path: href,
      age: ageNum,
      description: description || null,
      cause: cause || null,
    });
  }

  return results;
}

/** Insert if not exists (by wiki_path). Returns true if inserted. */
async function insertIfNew(env: Env, e: DeathEntry): Promise<boolean> {
  const exists = await env.DB.prepare(
    `SELECT 1 FROM deaths WHERE wiki_path = ? LIMIT 1`
  )
    .bind(e.wiki_path)
    .first<{ 1: number }>();

  if (exists) return false;

  await env.DB.prepare(
    `INSERT INTO deaths (name, wiki_path, age, description, cause, llm_result)
     VALUES (?, ?, ?, ?, ?, 'no')`
  )
    .bind(e.name, e.wiki_path, e.age, e.description, e.cause)
    .run();

  return true;
}

/** Build the Replicate prompt with the exact wording from the user. */
function buildReplicatePrompt(newEntries: DeathEntry[]): string {
  const lines = newEntries.map((e) => {
    const parts = [
      e.name,
      typeof e.age === "number" ? String(e.age) : "",
      e.description ?? "",
      e.cause ?? "",
      `wiki_path=${e.wiki_path}`,
    ].map((x) => x.trim());
    // "Name, age, description, cause, wiki_path=/wiki/..."
    return parts.filter(Boolean).join(", ");
  });

  return [
    `Extract from this list any names that an American might know. Include NFL, NBA, and MLB players, people from the entertainment industry, pop culture, popular music, TV shows, movies and commercials.`,
    `Return a JSON array of objects with fields: "name", "age", "description", "cause of death", and "wiki_path" (the same path provided in the input).`,
    `If no matches are found, return an empty JSON array []. Return only JSON.`,
    `---`,
    lines.join("\n"),
    `----`,
  ].join("\n\n");
}

/** Trigger a Replicate prediction with webhook callback. */
async function callReplicate(env: Env, prompt: string) {
  const body = {
    stream: false,
    input: {
      prompt,
      system_prompt:
        "Return only valid JSON or an empty JSON object as instructed. No extra commentary.",
      verbosity: "low",
      reasoning_effort: "minimal",
      max_completion_tokens: 4096,
    },
    webhook: env.REPLICATE_WEBHOOK_SECRET
      ? `${env.BASE_URL}/replicate/callback?secret=${encodeURIComponent(
          env.REPLICATE_WEBHOOK_SECRET
        )}`
      : `${env.BASE_URL}/replicate/callback`,
    webhook_events_filter: ["completed"],
  };

  const res = await fetch(
    "https://api.replicate.com/v1/models/openai/gpt-5-mini/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Replicate error ${res.status}: ${t}`);
  }
  return res.json();
}

/** Send a Telegram message to all configured chat IDs. */
async function notifyTelegram(env: Env, text: string) {
  const ids = env.TELEGRAM_CHAT_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (const chat_id of ids) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json"},
      body: JSON.stringify({ chat_id, text, parse_mode: "HTML" }),
    });
    // Best-effort; don't throw the whole batch on a single failure.
    if (!res.ok) {
      console.warn("Telegram send failed", chat_id, await res.text());
    }
  }
}

/** The core cron job: scrape, parse, insert new rows, call Replicate if any. */
async function runJob(env: Env) {
  const year = toNYYear();
  const targetUrl = `https://en.wikipedia.org/wiki/Deaths_in_${year}`;
  const res = await fetch(targetUrl, {
    headers: {
      "User-Agent":
        "cf-worker-celeb-deaths/1.0 (+https://workers.cloudflare.com/)",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${targetUrl}`);

  const html = await res.text();
  const parsed = parseWikipedia(html);

  // Insert new-only
  const newOnes: DeathEntry[] = [];
  for (const e of parsed) {
    try {
      const inserted = await insertIfNew(env, e);
      if (inserted) newOnes.push(e);
    } catch (err) {
      // Uniqueness race? ignore safely
      console.warn("Insert failed", e.wiki_path, err);
    }
  }

  // If any new entries, evaluate via Replicate
  if (newOnes.length > 0) {
    const prompt = buildReplicatePrompt(newOnes);
    await callReplicate(env, prompt);
  }

  return {
    scanned: parsed.length,
    inserted: newOnes.length,
  };
}

/** Replicate webhook handler: parse output and notify via Telegram. */
async function handleReplicateCallback(req: Request, env: Env): Promise<Response> {
  // Optional secret check via ?secret=... on the webhook URL you registered with Replicate
  if (env.REPLICATE_WEBHOOK_SECRET) {
    const url = new URL(req.url);
    const s = url.searchParams.get("secret");
    if (s !== env.REPLICATE_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Only act on succeeded predictions
  if ((payload?.status ?? "").toLowerCase() !== "succeeded") {
    return Response.json({ ok: true, message: `Ignored status=${payload?.status ?? "unknown"}` });
  }

  // Replicate "prediction" payload includes output that may be:
  // - a single string; or
  // - an array of token strings (as in your example).
  const rawOutput = payload?.output;

  const joined = coalesceOutput(rawOutput).trim();
  if (!joined) {
    return Response.json({ ok: true, message: "No output" });
  }

  // Try to parse JSON. If the model added code fences or stray text,
  // extract the JSON substring between the first {..} or [..].
  const parsed = extractAndParseJSON(joined);
  if (parsed == null) {
    console.warn("Callback received non-JSON output:", joined.slice(0, 500));
    return Response.json({ ok: true, message: "Non-JSON output ignored" });
  }

  // Normalize to an array of items
  const items: Array<Record<string, unknown>> = normalizeToArray(parsed);

  // Nothing to notify on empty object `{}` or empty array `[]`
  if (!items.length) {
    return Response.json({ ok: true, notified: 0 });
  }

  // Build and send notifications
  let notified = 0;
  for (const it of items) {
    const name = toStr(it["name"]);
    if (!name) continue;

    const age = toStr(it["age"]);
    const desc = toStr(it["description"]);
    const cause = toStr(
      it["cause of death"] ??
      it["cause_of_death"] ??
      (it as any).causeOfDeath ??
      it["cause"]
    );
    const wiki_path = toStr(it["wiki_path"]);

    const msg =
      `🚨💀<a href="https://www.wikipedia.org${wiki_path}">${name}</a>` +
      (age ? ` (${age})` : "") +
      (desc ? ` : ${desc}` : "") +
      (cause ? ` - ${cause}` : "") + `💀🚨`;

    await notifyTelegram(env, msg);
    notified++;

    if (wiki_path) {
      await env.DB.prepare(
        `UPDATE deaths
           SET cause = ?,
               llm_date_time = CURRENT_TIMESTAMP,
               llm_result = 'yes'
         WHERE wiki_path = ?`
      ).bind(cause, wiki_path).run();
    }
  }

  return Response.json({ ok: true, notified });

  // ---------- helpers ----------

  // Coalesce string or nested array-of-strings into one string
  function coalesceOutput(raw: unknown): string {
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return flattenStrings(raw).join("");
    return "";
  }

  function flattenStrings(x: unknown): string[] {
    if (typeof x === "string") return [x];
    if (Array.isArray(x)) {
      const out: string[] = [];
      for (const el of x) out.push(...flattenStrings(el));
      return out;
    }
    return [];
  }

  // Parse JSON from a possibly wrapped string (code fences or leading/trailing text)
  function extractAndParseJSON(s: string): any | null {
    const trimmed = stripCodeFences(s).trim();

    // Try direct parse first
    try { return JSON.parse(trimmed); } catch {}

    // Try object slice
    const objStart = trimmed.indexOf("{");
    const objEnd = trimmed.lastIndexOf("}");
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
      const slice = trimmed.slice(objStart, objEnd + 1);
      try { return JSON.parse(slice); } catch {}
    }

    // Try array slice
    const arrStart = trimmed.indexOf("[");
    const arrEnd = trimmed.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
      const slice = trimmed.slice(arrStart, arrEnd + 1);
      try { return JSON.parse(slice); } catch {}
    }

    return null;
  }

  function stripCodeFences(s: string): string {
    // Remove ```...``` wrappers if present
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
    const m = s.match(fence);
    return m ? m[1] : s;
  }

  function normalizeToArray(parsed: any): Array<Record<string, unknown>> {
    if (Array.isArray(parsed)) return parsed.filter(isObject);
    if (isObject(parsed)) {
      // Treat {} as empty; otherwise wrap single object
      return Object.keys(parsed).length ? [parsed] : [];
    }
    return [];
  }

  function isObject(x: any): x is Record<string, unknown> {
    return !!x && typeof x === "object" && !Array.isArray(x);
  }

  function toStr(v: unknown): string {
    if (v == null) return "";
    // Avoid "null"/"undefined" strings
    const s = String(v).trim();
    return s === "null" || s === "undefined" ? "" : s;
  }
}

/** Router */
export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const res = await runJob(env);
          console.log("Job complete", res);
        } catch (err) {
          console.error("Job error", err);
        }
      })()
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/replicate/callback" && request.method === "POST") {
      return handleReplicateCallback(request, env);
    }

    // Manual trigger for testing
    if (pathname === "/run" && request.method === "POST") {
      // Expect: Authorization: Bearer <MANUAL_RUN_SECRET>
      const auth = request.headers.get("authorization") || request.headers.get("Authorization");
      const token = (() => {
        if (!auth) return "";
        // Allow both "Bearer <token>" and raw "<token>" for ergonomics
        const maybeBearer = auth.trim();
        const m = /^Bearer\s+(.+)$/i.exec(maybeBearer);
        return m ? m[1].trim() : maybeBearer;
      })();

      if (!token || token !== env.MANUAL_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const res = await runJob(env);
        return Response.json({ ok: true, ...res });
      } catch (e: any) {
        return Response.json(
          { ok: false, error: e?.message ?? String(e) },
          { status: 500 }
        );
      }
    }

    if (pathname === "/privacy" && request.method === "GET") {
      return env.ASSETS.fetch(new Request("privacy.html", request));
    }

    if (pathname === "/health") {
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  },
};
