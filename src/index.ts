export interface Env {
  DB: D1Database;

  // Secrets / Vars
  REPLICATE_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_IDS: string; // comma-separated chat IDs: "111,222,333"
  BASE_URL: string; // e.g. "https://your-worker.your-subdomain.workers.dev"
  REPLICATE_WEBHOOK_SECRET?: string; // optional: extra safety on callback
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

    if (lastComma !== -1) {
      description = dedupeSpaces(rest.slice(0, lastComma));
      cause = dedupeSpaces(rest.slice(lastComma + 1));
    } else {
      description = dedupeSpaces(rest);
      cause = null;
    }

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

/** Ensure D1 schema exists. */
async function ensureSchema(env: Env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS deaths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      wiki_path TEXT NOT NULL UNIQUE,
      age INTEGER,
      description TEXT,
      cause TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
    `INSERT INTO deaths (name, wiki_path, age, description, cause)
     VALUES (?, ?, ?, ?, ?)`
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
    ].map((x) => x.trim());
    // "Name, age, description, cause"
    return parts.filter(Boolean).join(", ");
  });

  return [
    `Extract from this list any names that an American might know. Include NFL, NBA, and MLB players, people from the entertainment industry, pop culture, popular music, TV shows, movies and commercials. Structure the result as a JSON file with fields "name", "age", "description" and "cause of death". If no matches are found, return an empty Json structure with no fields.`,
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text }),
    });
    // Best-effort; don't throw the whole batch on a single failure.
    if (!res.ok) {
      console.warn("Telegram send failed", chat_id, await res.text());
    }
  }
}

/** The core cron job: scrape, parse, insert new rows, call Replicate if any. */
async function runJob(env: Env) {
  await ensureSchema(env);

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
  // Optional secret check
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

  // Replicate "prediction" payload typically includes output and status
  // Output schema (per prompt/model) is "array of strings" (iterator/concatenate) OR a single string.
  const rawOutput = payload?.output;

  // Coalesce into a single string.
  const joined =
    typeof rawOutput === "string"
      ? rawOutput
      : Array.isArray(rawOutput)
      ? rawOutput.join("")
      : "";

  if (!joined) {
    // Nothing to do
    return Response.json({ ok: true, message: "No output" });
  }

  // We asked the model to return JSON (either [] or {} when empty).
  let parsed: any;
  try {
    parsed = JSON.parse(joined);
  } catch (e) {
    // If bad JSON, just ignore quietly (or log)
    console.warn("Callback received non-JSON output:", joined);
    return Response.json({ ok: true, message: "Non-JSON output ignored" });
  }

  // Normalize to an array of items with expected fields
  const items: Array<{
    name?: string;
    age?: number | string;
    description?: string;
    ["cause of death"]?: string;
    cause?: string; // tolerate if model returns 'cause' instead
  }> = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
    ? // If they returned an empty object, do nothing.
      []
    : [];

  for (const it of items) {
    const name = (it.name ?? "").toString().trim();
    const age = (it.age ?? "").toString().trim();
    const desc = (it.description ?? "").toString().trim();
    const cause =
      (it["cause of death"] ?? it.cause ?? "").toString().trim();

    if (!name) continue;

    const msg = `Celebrity death: ${name}${age ? ` (${age})` : ""} : ${desc}${
      cause ? ` - ${cause}` : ""
    }`;

    await notifyTelegram(env, msg);
  }

  return Response.json({ ok: true, notified: items.length });
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

    if (pathname === "/health") {
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  },
};
