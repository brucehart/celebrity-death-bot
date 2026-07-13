import type { Env } from '../types.ts';
import { coalesceOutput } from '../utils/json.ts';
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readRequestTextBounded } from '../utils/request.ts';
import { applyLlmOutput, extractCandidatePathsFromReplicatePayload } from '../services/llm-output.ts';
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from '../services/db.ts';
import { verifyReplicateWebhook } from '../utils/replicate-webhook.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function replicateCallback(request: Request, env: Env): Promise<Response> {
	if (!env.REPLICATE_WEBHOOK_SECRET) return new Response('Webhook is not configured', { status: 503 });

	let bodyText: string;
	try {
		bodyText = await readRequestTextBounded(request, MAX_WEBHOOK_BODY_BYTES);
	} catch (error) {
		return new Response(error instanceof BodyTooLargeError ? 'Request too large' : 'Invalid body', {
			status: error instanceof BodyTooLargeError ? 413 : 400,
		});
	}

	const verification = await verifyReplicateWebhook(request, env.REPLICATE_WEBHOOK_SECRET, bodyText);
	if (!verification.ok) return new Response(verification.error, { status: verification.code });

	let payload: unknown;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}
	if (!isRecord(payload)) return new Response('Invalid payload', { status: 400 });

	const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
	if (status !== 'succeeded') return Response.json({ ok: true, ignored: status || 'unknown' });
	const predictionId = typeof payload.id === 'string' && payload.id.length <= 200 ? payload.id.trim() : '';
	if (!predictionId) return new Response('Missing prediction id', { status: 400 });
	const eventId = `${predictionId}:${status}`;
	let claimToken: string;
	try {
		const claimed = await claimWebhookEvent(env, 'replicate', eventId);
		if (!claimed) return Response.json({ ok: true, duplicate: true });
		claimToken = claimed;
	} catch (error) {
		console.error('Replicate webhook claim failed', error instanceof Error ? error.message : String(error));
		return new Response('Webhook processing failed', { status: 500 });
	}

	try {
		const joined = coalesceOutput(payload.output).trim();
		const candidatePaths = extractCandidatePathsFromReplicatePayload(payload);
		const result = await applyLlmOutput(env, joined, candidatePaths, {
			beforeSideEffects: () => completeWebhookEvent(env, 'replicate', eventId, claimToken),
		});
		await completeWebhookEvent(env, 'replicate', eventId, claimToken);
		return Response.json({ ok: true, ...result });
	} catch (error) {
		console.error('Replicate webhook processing failed', error instanceof Error ? error.message : String(error));
		try {
			await failWebhookEvent(env, 'replicate', eventId, claimToken, error);
		} catch (recordError) {
			console.error('Replicate webhook failure recording failed', recordError instanceof Error ? recordError.message : String(recordError));
		}
		return new Response('Webhook processing failed', { status: 500 });
	}
}
