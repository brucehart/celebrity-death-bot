import type { Env } from '../types.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getConfig } from '../config.ts';

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

export function normalizeOpenAIModel(raw?: string): string {
	const trimmed = String(raw || '').trim();
	if (!trimmed) return DEFAULT_OPENAI_MODEL;
	if (trimmed.startsWith('openai/')) return trimmed.slice('openai/'.length);
	return trimmed;
}

export function extractOpenAIOutputText(payload: any): string {
	if (!payload) return '';
	const direct = typeof payload.output_text === 'string' ? payload.output_text : '';
	if (direct) return direct;

	const output = Array.isArray(payload.output) ? payload.output : [];
	const parts: string[] = [];
	for (const item of output) {
		if (!item) continue;
		if (typeof item === 'string') {
			parts.push(item);
			continue;
		}
		const content = Array.isArray(item.content) ? item.content : [];
		for (const piece of content) {
			if (!piece) continue;
			if (typeof piece === 'string') {
				parts.push(piece);
				continue;
			}
			const text = typeof piece.text === 'string' ? piece.text : '';
			if (text) parts.push(text);
		}
	}

	if (parts.length) return parts.join('');

	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	for (const choice of choices) {
		const message = choice?.message?.content;
		if (typeof message === 'string') parts.push(message);
		const text = choice?.text;
		if (typeof text === 'string') parts.push(text);
	}

	return parts.join('');
}

type OpenAIRequestOptions = {
	model?: string;
	background?: boolean;
	metadata?: Record<string, unknown>;
};

export async function callOpenAI(env: Env, prompt: string, opts?: OpenAIRequestOptions) {
	if (!env.OPENAI_API_KEY) {
		throw new Error('OPENAI_API_KEY is not configured');
	}
	const cfg = getConfig(env);
	const model = normalizeOpenAIModel(opts?.model);
	const timeoutMs = (() => {
		const raw = Number(env.OPENAI_TIMEOUT_MS);
		if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
		return Math.max(cfg.limits.fetchTimeoutMs, 120000);
	})();

	const body: Record<string, unknown> = {
		model,
		input: prompt,
		max_output_tokens: 16384,
		background: opts?.background === true,
	};
	if (opts?.metadata && Object.keys(opts.metadata).length) {
		body.metadata = opts.metadata;
	}

	const res = await fetchWithRetry(
		'https://api.openai.com/v1/responses',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		},
		{ retries: 1, timeoutMs }
	);

	if (!res.ok) {
		const t = await res.text();
		throw new Error(`OpenAI error ${res.status}: ${t}`);
	}

	const payload = await res.json();
	const outputText = extractOpenAIOutputText(payload).trim();

	return { outputText, raw: payload, model, id: payload?.id, status: payload?.status, background: opts?.background === true };
}

export async function retrieveOpenAIResponse(env: Env, responseId: string) {
	if (!env.OPENAI_API_KEY) {
		throw new Error('OPENAI_API_KEY is not configured');
	}
	const cfg = getConfig(env);
	const timeoutMs = (() => {
		const raw = Number(env.OPENAI_TIMEOUT_MS);
		if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
		return Math.max(cfg.limits.fetchTimeoutMs, 120000);
	})();

	const res = await fetchWithRetry(
		`https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}`,
		{
			method: 'GET',
			headers: {
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
		},
		{ retries: 1, timeoutMs }
	);

	if (!res.ok) {
		const t = await res.text();
		throw new Error(`OpenAI error ${res.status}: ${t}`);
	}

	const payload = await res.json();
	const outputText = extractOpenAIOutputText(payload).trim();
	return { outputText, raw: payload, id: payload?.id, status: payload?.status };
}
