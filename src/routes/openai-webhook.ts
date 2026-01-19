import type { Env } from '../types.ts';
import { applyLlmOutput } from '../services/llm-output.ts';
import { retrieveOpenAIResponse } from '../services/openai.ts';
import { markDeathsAsError } from '../services/db.ts';
import { verifyOpenAIWebhook } from '../utils/openai-webhook.ts';

function extractCandidatesFromMetadata(metadata: any): string[] {
	const raw = metadata?.candidates;
	if (Array.isArray(raw)) return raw.map((s: unknown) => String(s || '').trim()).filter(Boolean);
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.map((s: unknown) => String(s || '').trim()).filter(Boolean);
		} catch {}
		if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
		const trimmed = raw.trim();
		return trimmed ? [trimmed] : [];
	}
	return [];
}

export async function openaiWebhook(request: Request, env: Env): Promise<Response> {
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

	if (env.OPENAI_WEBHOOK_SECRET && !manualOverride) {
		const res = await verifyOpenAIWebhook(request, env.OPENAI_WEBHOOK_SECRET, bodyText);
		if (!res.ok) return new Response(res.error, { status: res.code });
	}

	let payload: any;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}

	const eventType = String(payload?.type || '').trim();
	if (!eventType) return Response.json({ ok: true, message: 'Missing event type' });
	if (!eventType.startsWith('response.')) {
		return Response.json({ ok: true, ignored: eventType });
	}

	const responseId = String(payload?.data?.id || '').trim();
	if (!responseId) return new Response('Missing response id', { status: 400 });

	const handledEvents = new Set(['response.completed', 'response.failed', 'response.cancelled']);
	if (!handledEvents.has(eventType)) {
		return Response.json({ ok: true, ignored: eventType });
	}

	let response;
	try {
		response = await retrieveOpenAIResponse(env, responseId);
	} catch (err) {
		console.error('OpenAI webhook retrieve failed', (err as any)?.message || String(err));
		return new Response('Failed to retrieve response', { status: 500 });
	}

	const candidatePaths = extractCandidatesFromMetadata(response.raw?.metadata || null);

	if (eventType !== 'response.completed') {
		if (candidatePaths.length) await markDeathsAsError(env, candidatePaths);
		return Response.json({ ok: true, status: eventType, errored: candidatePaths.length });
	}

	const result = await applyLlmOutput(env, response.outputText || '', candidatePaths);
	return Response.json({ ok: true, response_id: responseId, ...result });
}
