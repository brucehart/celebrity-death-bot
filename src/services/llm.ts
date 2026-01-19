import type { Env, DeathEntry } from '../types.ts';
import { applyLlmOutput } from './llm-output.ts';
import { callOpenAI, DEFAULT_OPENAI_MODEL, normalizeOpenAIModel } from './openai.ts';
import { buildReplicatePrompt, callReplicate, DEFAULT_REPLICATE_MODEL } from './replicate.ts';

export type LlmProvider = 'openai' | 'replicate';

export function getDefaultLlmProvider(env: Env): LlmProvider {
	const raw = String(env.LLM_PROVIDER || '').trim().toLowerCase();
	return raw === 'replicate' ? 'replicate' : 'openai';
}

export function normalizeLlmProvider(raw: string | undefined, fallback: LlmProvider): LlmProvider {
	const trimmed = String(raw || '').trim().toLowerCase();
	if (trimmed === 'replicate') return 'replicate';
	if (trimmed === 'openai') return 'openai';
	return fallback;
}

export function getDefaultLlmModel(provider: LlmProvider): string {
	return provider === 'replicate' ? DEFAULT_REPLICATE_MODEL : DEFAULT_OPENAI_MODEL;
}

export function normalizeModelForProvider(provider: LlmProvider, raw?: string): string {
	if (provider === 'replicate') {
		const trimmed = String(raw || '').trim();
		if (!trimmed) return DEFAULT_REPLICATE_MODEL;
		if (!trimmed.includes('/')) return `openai/${trimmed}`;
		return trimmed;
	}
	return normalizeOpenAIModel(raw);
}

export async function evaluateDeaths(
	env: Env,
	entries: DeathEntry[],
	opts?: { forcedPaths?: string[]; model?: string; provider?: LlmProvider | string }
) {
	if (!entries.length) return { provider: getDefaultLlmProvider(env), queued: 0, mode: 'skipped' } as const;
	const provider = normalizeLlmProvider(opts?.provider, getDefaultLlmProvider(env));
	const prompt = buildReplicatePrompt(entries, opts?.forcedPaths);
	const candidatePaths = entries.map((e) => String(e.wiki_path || '').trim()).filter(Boolean);

	if (provider === 'replicate') {
		const model = normalizeModelForProvider(provider, opts?.model);
		await callReplicate(env, prompt, { forcedPaths: opts?.forcedPaths, model });
		return { provider, queued: entries.length, mode: 'queued', model } as const;
	}

	const model = normalizeModelForProvider(provider, opts?.model);
	const useBackground = !!env.OPENAI_WEBHOOK_SECRET;
	const metadata = candidatePaths.length ? { candidates: JSON.stringify(candidatePaths) } : undefined;
	const { outputText, id, status } = await callOpenAI(env, prompt, { model, background: useBackground, metadata });
	if (useBackground) {
		return { provider, queued: entries.length, mode: 'queued', model, response_id: id, status } as const;
	}
	const applied = await applyLlmOutput(env, outputText, candidatePaths);
	return { provider, mode: 'completed', model, ...applied } as const;
}
