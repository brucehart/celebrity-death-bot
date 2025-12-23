import type { Env } from '../types.ts';
import { extractAndParseJSON, coalesceOutput, normalizeToArray, isObject } from '../utils/json.ts';
import { toStr } from '../utils/strings.ts';
import { getLinkTypeMap, markDeathsAsError, markDeathsAsNo, updateDeathLLM } from '../services/db.ts';
import { buildTelegramMessage, notifyTelegram } from '../services/telegram.ts';
import { buildXStatus, postToXIfConfigured } from '../services/x.ts';
import { verifyReplicateWebhook } from '../utils/replicate-webhook.ts';

type SelectedRejected = {
  selected?: Array<Record<string, unknown>>;
  rejected?: Array<Record<string, unknown> | string>;
};

type Rejection = { wiki_path: string; reason?: string | null };

const MAX_REASON_CHARS = 200;

function normalizeRejected(raw: SelectedRejected['rejected']): Rejection[] {
  const out: Rejection[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        const wiki_path = item.trim();
        if (wiki_path) out.push({ wiki_path, reason: null });
        continue;
      }
      if (isObject(item)) {
        const wiki_path = toStr((item as any)['wiki_path']);
        if (!wiki_path) continue;
        const reason = sanitizeReason((item as any)['reason']);
        out.push({ wiki_path, reason });
      }
    }
  } else if (isObject(raw)) {
    const wiki_path = toStr((raw as any)['wiki_path']);
    if (wiki_path) {
      const reason = sanitizeReason((raw as any)['reason']);
      out.push({ wiki_path, reason });
    }
  }
  return out;
}

function sanitizeReason(value: unknown): string | null {
  const raw = toStr(value);
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_REASON_CHARS);
}

function extractCandidatePaths(payload: any): string[] {
  const fromMeta = Array.isArray(payload?.metadata?.candidates) ? payload.metadata.candidates : [];
  const metaPaths = fromMeta.map((s: unknown) => String(s || '').trim()).filter(Boolean);
  if (metaPaths.length) return metaPaths;
  const prompt = payload?.input?.prompt;
  if (typeof prompt !== 'string') return [];
  return extractWikiPathsFromPrompt(prompt);
}

function extractWikiPathsFromPrompt(prompt: string): string[] {
  const m = /Input \(each line:[\s\S]*?----\n([\s\S]*?)\n----/m.exec(prompt);
  if (!m || !m[1]) return [];
  return m[1]
    .split(/\n\n+/)
    .map((line) => line.trim())
    .map((line) => line.split(',').pop() || '')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function replicateCallback(request: Request, env: Env): Promise<Response> {
  // Read raw body text once for signature verification and JSON parsing
  let bodyText = '';
  try {
    bodyText = await request.clone().text();
  } catch {
    return new Response('Invalid body', { status: 400 });
  }

  const manualOverride = (() => {
    const raw = request.headers.get('Authorization') || '';
    const trimmed = raw.trim();
    if (!trimmed || !env.MANUAL_RUN_SECRET) return false;
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    const token = (bearer ? bearer[1] : trimmed).trim();
    return token === env.MANUAL_RUN_SECRET;
  })();

  // If configured, verify Replicate webhook HMAC signature and timestamp
  if (env.REPLICATE_WEBHOOK_SECRET && !manualOverride) {
    const res = await verifyReplicateWebhook(request, env.REPLICATE_WEBHOOK_SECRET, bodyText);
    if (!res.ok) return new Response(res.error, { status: res.code });
  }

  // Parse JSON payload only after signature verification
  let payload: any;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if ((payload?.status ?? '').toLowerCase() !== 'succeeded') {
    return Response.json({ ok: true, message: `Ignored status=${payload?.status ?? 'unknown'}` });
  }

  const rawOutput = payload?.output;
  const joined = coalesceOutput(rawOutput).trim();
  const candidatePaths = extractCandidatePaths(payload);
  if (!joined) {
    if (candidatePaths.length) await markDeathsAsError(env, candidatePaths);
    return Response.json({ ok: true, message: 'No output', errored: candidatePaths.length });
  }

  const parsed = extractAndParseJSON(joined);
  if (parsed == null) {
    console.warn('Callback received non-JSON output:', joined.slice(0, 500));
    if (candidatePaths.length) await markDeathsAsError(env, candidatePaths);
    return Response.json({ ok: true, message: 'Non-JSON output ignored', errored: candidatePaths.length });
  }

  let selectedItems: Array<Record<string, unknown>> = [];
  let rejectedItems: Rejection[] = [];

  if (Array.isArray(parsed)) {
    selectedItems = normalizeToArray(parsed);
  } else if (isObject(parsed)) {
    const parsedObj = parsed as SelectedRejected;
    if ('selected' in parsedObj || 'rejected' in parsedObj) {
      selectedItems = normalizeToArray(parsedObj.selected);
      rejectedItems = normalizeRejected(parsedObj.rejected);
    } else {
      selectedItems = normalizeToArray(parsed);
    }
  }

  let notified = 0;
  if (selectedItems.length) {
    const selectedPaths: string[] = selectedItems.map((it) => toStr(it['wiki_path'])).filter(Boolean);
    const linkTypeMap = selectedPaths.length ? await getLinkTypeMap(env, selectedPaths) : {};
    for (const it of selectedItems) {
      const name = toStr(it['name']);
      if (!name) continue;
      const age = toStr(it['age']);
      const desc = toStr(it['description']);
      const cause = toStr(it['cause of death'] ?? it['cause_of_death'] ?? (it as any).causeOfDeath ?? it['cause']);
      const wiki_path = toStr(it['wiki_path']);
      const link_type = wiki_path ? (linkTypeMap[wiki_path] || 'active') : 'active';

      const msg = buildTelegramMessage({ name, age, description: desc, cause, wiki_path, link_type });
      await notifyTelegram(env, msg);
      // Post to X.com if credentials are configured; mirrors Telegram format
      const xText = buildXStatus({ name, age, description: desc, cause, wiki_path, link_type });
      await postToXIfConfigured(env, xText);
      notified++;

      if (wiki_path) {
        await updateDeathLLM(env, wiki_path, cause, desc);
      }
    }
  }

  if (rejectedItems.length) {
    const selectedSet = new Set(selectedItems.map((it) => toStr(it['wiki_path'])).filter(Boolean));
    const filtered = rejectedItems.filter((item) => !selectedSet.has(item.wiki_path));
    await markDeathsAsNo(env, filtered);
  }
  return Response.json({ ok: true, notified, rejected: rejectedItems.length });
}
