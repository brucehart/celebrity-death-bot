import type { Env } from '../types.ts';
import { processOpenAIResponseEvent, type OpenAIResponseEventType } from '../services/openai-background.ts';
import { verifyOpenAIWebhook } from '../utils/openai-webhook.ts';
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readRequestTextBounded } from '../utils/request.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function openaiWebhook(request: Request, env: Env): Promise<Response> {
	if (!env.OPENAI_WEBHOOK_SECRET) return new Response('Webhook is not configured', { status: 503 });

	let bodyText: string;
	try {
		bodyText = await readRequestTextBounded(request, MAX_WEBHOOK_BODY_BYTES);
	} catch (error) {
		return new Response(error instanceof BodyTooLargeError ? 'Request too large' : 'Invalid body', {
			status: error instanceof BodyTooLargeError ? 413 : 400,
		});
	}

	const verification = await verifyOpenAIWebhook(request, env.OPENAI_WEBHOOK_SECRET, bodyText);
	if (!verification.ok) return new Response(verification.error, { status: verification.code });

	let payload: unknown;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}
	if (!isRecord(payload)) return new Response('Invalid payload', { status: 400 });

	const eventType = typeof payload.type === 'string' ? payload.type.trim() : '';
	if (!eventType.startsWith('response.')) return Response.json({ ok: true, ignored: eventType || 'missing_type' });
	const handledEvents = new Set(['response.completed', 'response.failed', 'response.cancelled']);
	if (!handledEvents.has(eventType)) return Response.json({ ok: true, ignored: eventType });
	const data = isRecord(payload.data) ? payload.data : null;
	const responseId = data && typeof data.id === 'string' && data.id.length <= 200 ? data.id.trim() : '';
	if (!responseId) return new Response('Missing response id', { status: 400 });

	try {
		return Response.json(await processOpenAIResponseEvent(env, eventType as OpenAIResponseEventType, responseId));
	} catch (error) {
		console.error('OpenAI webhook processing failed', error instanceof Error ? error.message : String(error));
		return new Response('Webhook processing failed', { status: 500 });
	}
}
