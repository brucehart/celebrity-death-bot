import type { Env } from '../types.ts';
import { extractAndParseJSON, coalesceOutput, normalizeToArray, isObject } from '../utils/json.ts';
import { toStr } from '../utils/strings.ts';
import { getLinkTypeMap, markDeathsAsNo, updateDeathLLM } from '../services/db.ts';
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
  if (!joined) {
    return Response.json({ ok: true, message: 'No output' });
  }

  const parsed = extractAndParseJSON(joined);
  if (parsed == null) {
    console.warn('Callback received non-JSON output:', joined.slice(0, 500));
    return Response.json({ ok: true, message: 'Non-JSON output ignored' });
  }

  let selectedItems: Array<Record<string, unknown>> = [];
  let rejectedPaths: string[] = [];

  if (Array.isArray(parsed)) {
    selectedItems = normalizeToArray(parsed);
  } else if (isObject(parsed)) {
    if ('selected' in parsed || 'rejected' in parsed) {
      selectedItems = normalizeToArray((parsed as any).selected);
      const rawRejected = (parsed as any).rejected;
      if (Array.isArray(rawRejected)) {
        for (const item of rawRejected) {
          if (typeof item === 'string') {
            const p = item.trim();
            if (p) rejectedPaths.push(p);
            continue;
          }
          if (isObject(item)) {
            const p = toStr((item as any)['wiki_path']);
            if (p) rejectedPaths.push(p);
          }
        }
      } else if (isObject(rawRejected)) {
        const p = toStr((rawRejected as any)['wiki_path']);
        if (p) rejectedPaths.push(p);
      }
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

  if (rejectedPaths.length) {
    const selectedSet = new Set(selectedItems.map((it) => toStr(it['wiki_path'])).filter(Boolean));
    const filtered = rejectedPaths.filter((p) => !selectedSet.has(p));
    await markDeathsAsNo(env, filtered);
  }
  return Response.json({ ok: true, notified, rejected: rejectedPaths.length });
}
