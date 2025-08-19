import type { Env } from '../types';
import { extractAndParseJSON, coalesceOutput, normalizeToArray } from '../utils/json';
import { toStr } from '../utils/strings';
import { updateDeathLLM } from '../services/db';
import { buildTelegramMessage, notifyTelegram } from '../services/telegram';

export async function replicateCallback(request: Request, env: Env): Promise<Response> {
  if (env.REPLICATE_WEBHOOK_SECRET) {
    const url = new URL(request.url);
    const s = url.searchParams.get('secret');
    if (s !== env.REPLICATE_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = await request.json();
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
    notified++;

    if (wiki_path) {
      await updateDeathLLM(env, wiki_path, cause);
    }
  }

  return Response.json({ ok: true, notified });
}

