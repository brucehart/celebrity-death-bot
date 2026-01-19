import type { Env } from '../types.ts';
import { coalesceOutput } from '../utils/json.ts';
import { applyLlmOutput, extractCandidatePathsFromReplicatePayload } from '../services/llm-output.ts';
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
  const candidatePaths = extractCandidatePathsFromReplicatePayload(payload);
  const result = await applyLlmOutput(env, joined, candidatePaths);
  return Response.json({ ok: true, ...result });
}
