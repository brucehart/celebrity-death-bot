import type { Env } from '../types.ts';
import { extractAndParseJSON, coalesceOutput, normalizeToArray } from '../utils/json.ts';
import { toStr } from '../utils/strings.ts';
import { getLinkTypeMap, setLLMNoFor, updateDeathLLM } from '../services/db.ts';
import { buildTelegramMessage, notifyTelegram } from '../services/telegram.ts';
import { buildXStatus, postToXIfConfigured } from '../services/x.ts';
import { verifyReplicateWebhook } from '../utils/replicate-webhook.ts';

export async function replicateCallback(request: Request, env: Env): Promise<Response> {
  // Read raw body text once for signature verification and JSON parsing
  let bodyText = '';
  try {
    bodyText = await request.clone().text();
  } catch {
    return new Response('Invalid body', { status: 400 });
  }

  // If configured, verify Replicate webhook HMAC signature and timestamp
  if (env.REPLICATE_WEBHOOK_SECRET) {
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
  if (!joined) {
    return Response.json({ ok: true, message: 'No output' });
  }

  const parsed = extractAndParseJSON(joined);
  if (parsed == null) {
    console.warn('Callback received non-JSON output:', joined.slice(0, 500));
    return Response.json({ ok: true, message: 'Non-JSON output ignored' });
  }

  const items: Array<Record<string, unknown>> = normalizeToArray(parsed);
  if (!items.length) {
    // If we can detect candidates, mark them as 'no' except any that were forced.
    const metaCandidates: string[] = Array.isArray(payload?.metadata?.candidates) ? (payload.metadata.candidates as any[]).map(String) : [];
    const forcedPaths: string[] = Array.isArray(payload?.metadata?.forcedPaths)
      ? (payload.metadata.forcedPaths as any[]).map(String)
      : Array.isArray(payload?.metadata?.forced)
      ? (payload.metadata.forced as any[]).map(String)
      : [];
    if (metaCandidates.length) {
      const forcedSet = new Set(forcedPaths);
      const toNo = metaCandidates.filter((c) => !forcedSet.has(String(c)));
      if (toNo.length) await setLLMNoFor(env, toNo);
    }
    return Response.json({ ok: true, notified: 0 });
  }

  let notified = 0;
  const selectedPaths: string[] = items.map((it) => toStr(it['wiki_path'])).filter(Boolean);
  const linkTypeMap = await getLinkTypeMap(env, selectedPaths);
  for (const it of items) {
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

  // Mark any candidates not selected as 'no' for this callback only
  const candidates: string[] = Array.isArray(payload?.metadata?.candidates) ? (payload.metadata.candidates as any[]).map(String) : [];
  if (candidates.length) {
    const forcedPaths: string[] = Array.isArray(payload?.metadata?.forcedPaths)
      ? (payload.metadata.forcedPaths as any[]).map(String)
      : Array.isArray(payload?.metadata?.forced)
      ? (payload.metadata.forced as any[]).map(String)
      : [];
    const forcedSet = new Set(forcedPaths.map(String));
    const notSelected = candidates.filter((c: string) => !selectedPaths.includes(c) && !forcedSet.has(String(c)));
    if (notSelected.length) await setLLMNoFor(env, notSelected);
  }
  return Response.json({ ok: true, notified });
}
