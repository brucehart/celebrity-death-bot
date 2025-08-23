import type { Env } from '../types.ts';
import { extractAndParseJSON, coalesceOutput, normalizeToArray } from '../utils/json.ts';
import { toStr } from '../utils/strings.ts';
import { updateDeathLLM } from '../services/db.ts';
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
    return Response.json({ ok: true, notified: 0 });
  }

  let notified = 0;
  for (const it of items) {
    const name = toStr(it['name']);
    if (!name) continue;
    const age = toStr(it['age']);
    const desc = toStr(it['description']);
    const cause = toStr(it['cause of death'] ?? it['cause_of_death'] ?? (it as any).causeOfDeath ?? it['cause']);
    const wiki_path = toStr(it['wiki_path']);

    const msg = buildTelegramMessage({ name, age, description: desc, cause, wiki_path });
    await notifyTelegram(env, msg);
    // Post to X.com if credentials are configured; mirrors Telegram format
    const xText = buildXStatus({ name, age, description: desc, cause, wiki_path });
    await postToXIfConfigured(env, xText);
    notified++;

    if (wiki_path) {
      await updateDeathLLM(env, wiki_path, cause);
    }
  }

  return Response.json({ ok: true, notified });
}
