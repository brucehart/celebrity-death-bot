import type { Env } from '../types.ts';
import { applyLlmOutput } from '../services/llm-output.ts';
import { retrieveOpenAIResponse } from '../services/openai.ts';
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent, markDeathsAsError } from '../services/db.ts';
import { verifyOpenAIWebhook } from '../utils/openai-webhook.ts';
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readRequestTextBounded } from '../utils/request.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractCandidatesFromMetadata(metadata: unknown): string[] {
	if (!isRecord(metadata)) return [];
	const raw = metadata.candidates;
	if (Array.isArray(raw)) {
		return raw
			.map((value) => String(value || '').trim())
			.filter((path) => path.length > 0 && path.length <= 512)
			.slice(0, 400);
	}
	if (typeof raw !== 'string') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed
				.map((value) => String(value || '').trim())
				.filter((path) => path.length > 0 && path.length <= 512)
				.slice(0, 400);
		}
	} catch {}
	return raw
		.split(',')
		.map((value) => value.trim())
		.filter((path) => path.length > 0 && path.length <= 512)
		.slice(0, 400);
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

	const eventId = `${responseId}:${eventType}`;
	try {
		if (!(await claimWebhookEvent(env, 'openai', eventId))) return Response.json({ ok: true, duplicate: true });
	} catch (error) {
		console.error('OpenAI webhook claim failed', error instanceof Error ? error.message : String(error));
		return new Response('Webhook processing failed', { status: 500 });
	}

	try {
		const response = await retrieveOpenAIResponse(env, responseId);
		const metadata = isRecord(response.raw) ? response.raw.metadata : null;
		const candidatePaths = extractCandidatesFromMetadata(metadata);

		if (eventType !== 'response.completed') {
			if (candidatePaths.length) await markDeathsAsError(env, candidatePaths);
			await completeWebhookEvent(env, 'openai', eventId);
			return Response.json({ ok: true, status: eventType, errored: candidatePaths.length });
		}

		const result = await applyLlmOutput(env, response.outputText || '', candidatePaths);
		await completeWebhookEvent(env, 'openai', eventId);
		return Response.json({ ok: true, response_id: responseId, ...result });
	} catch (error) {
		console.error('OpenAI webhook processing failed', error instanceof Error ? error.message : String(error));
		try {
			await failWebhookEvent(env, 'openai', eventId, error);
		} catch (recordError) {
			console.error('OpenAI webhook failure recording failed', recordError instanceof Error ? recordError.message : String(recordError));
		}
		return new Response('Webhook processing failed', { status: 500 });
	}
}
