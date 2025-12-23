import type { Env, DeathEntry } from '../types.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getConfig } from '../config.ts';

const DEFAULT_MODEL = 'openai/gpt-5-mini';

export function buildReplicatePrompt(newEntries: DeathEntry[], forcedWikiPaths?: string[]): string {
	const lines = newEntries.map((e) => {
		const parts = [
			e.name,
			typeof e.age === 'number' ? String(e.age) : '',
			e.description ?? '',
			e.cause ?? '',
			e.wiki_path,
		].map((x) =>
			x.trim()
		);
		return parts.filter(Boolean).join(', ');
	});
	const forceNote = (forcedWikiPaths || []).map((s) => s.trim()).filter(Boolean);
	return [
		'You are a filter for notable deaths for a U.S. audience. Input is a list of people with `name`, `age`, `description`, `cause of death`, and `wiki_path`.',
		'',
		'**Task:** Return only JSON. Include people if they are: ',
		'',
		'* Major U.S. pro or college athletes (NFL, NBA, MLB, NHL, WWE, PGA, NCAA, FIFA), Olympic medalists or notable Olympic athletes, or global stars with strong U.S. coverage.',
		'',
		'* Widely known in film, TV, pop music, Internet media including YouTube, entertainment, media or commercials.',
		'',
		'* High-profile business leaders, artists, peformers, scientists, technologists, politicians, or notorious criminals.',
		'',
		'Exclude obscure or regional figures. Prefer U.S. relevance; lower weight if fame is outside U.S.',
		'',
		...(forceNote.length
			? [
					'',
					'**Important override:** The following `wiki_path` IDs MUST be included in the output regardless of typical notability criteria. If they appear in the input, include them with a concise description and cause of death: ',
					'',
					forceNote.join(', '),
			  ]
			: []),
		'',
		'**Output format:** JSON object with fields:',
		'',
		'* `selected`: array of objects with fields `name`, `age`, `description` (10–25 words, why notable to U.S. public), `cause_of_death` (or "unknown"), `wiki_path`',
		'* `rejected`: array of objects with fields `wiki_path` and optional `reason` (<= 10 words)',
		'',
		'Place every input line into exactly one of `selected` or `rejected`.',
		'If no matches, return `{"selected":[],"rejected":[...]}`. Output strictly JSON, nothing else.',
		'',
		'----',
		'Input (each line: name, age, description, cause of death, wiki_path):',
		'',
		lines.join('\n\n'),
		'----',
	].join('\n');
}

export async function callReplicate(env: Env, prompt: string, opts?: { forcedPaths?: string[]; model?: string }) {
	const cfg = getConfig(env);
	const model = (opts?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
	// Some hosted models (e.g., OpenAI GPT-5 endpoints) reject unknown top-level fields such as `metadata`.
	// Only attach metadata when the model is known to tolerate it.
	const allowMetadata = !model.startsWith('openai/');

	const body: any = {
		stream: false,
		input: {},
		// Replicate will sign webhooks; verification happens in the callback route.
		webhook: `${cfg.baseUrl}/replicate/callback`,
		webhook_events_filter: ['completed'],
	};

	if (model.startsWith('openai/')) {
		body.input = {
			prompt,
			system_prompt: 'Output strictly JSON and nothing else. Return an object with selected/rejected arrays.',
			verbosity: 'low',
			reasoning_effort: 'minimal',
			max_completion_tokens: 12288,
		};
	} else if (model.includes('gemini')) {
		body.input = {
			prompt,
			images: [],
			videos: [],
			temperature: 0.8,
			top_p: 0.95,
			thinking_level: 'low',
			max_output_tokens: 12288,
		};
	} else {
		body.input = {
			prompt,
		};
	}
	// Attach minimal metadata to identify the batch candidates by wiki_path when allowed.
	if (
		allowMetadata &&
		(prompt || '').includes('Input (each line:')
	) {
		// Best-effort extraction of wiki_paths from prompt for metadata redundancy.
		const m = /Input \(each line:[\s\S]*?----\n([\s\S]*?)\n----/m.exec(prompt);
		if (m && m[1]) {
			const candidates = m[1]
				.split(/\n\n+/)
				.map((line) => line.trim())
				.map((line) => line.split(',').pop() || '')
				.map((s) => s.trim())
				.filter(Boolean);
			(body as any).metadata = { candidates };
		}
	}
	// Include forced list in metadata so the callback can avoid marking them as 'no'
	if (allowMetadata && opts?.forcedPaths && opts.forcedPaths.length) {
		(body as any).metadata = {
			...(body as any).metadata,
			forcedPaths: opts.forcedPaths.map((s) => String(s || '').trim()).filter(Boolean),
		};
	}

	const res = await fetchWithRetry(`https://api.replicate.com/v1/models/${model}/predictions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	}, { retries: 1, timeoutMs: cfg.limits.fetchTimeoutMs });

	if (!res.ok) {
		const t = await res.text();
		throw new Error(`Replicate error ${res.status}: ${t}`);
	}
	return res.json();
}
