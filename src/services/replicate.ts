import type { Env, DeathEntry } from '../types';
import { fetchWithRetry } from '../utils/fetch';
import { getConfig } from '../config';

export function buildReplicatePrompt(newEntries: DeathEntry[]): string {
  const lines = newEntries.map((e) => {
    const parts = [e.name, typeof e.age === 'number' ? String(e.age) : '', e.description ?? '', e.cause ?? '', `wiki_path=${e.wiki_path}`].map((x) =>
      x.trim()
    );
    return parts.filter(Boolean).join(', ');
  });
  return [
    'Extract from this list any names that an American might know. Include NFL, NBA, NHL, WWE, PGA and MLB players, notorious people, Olympians, successful business people and scientists, people from the entertainment industry, pop culture, popular music, television, movies and commercials.',
    'Return a JSON array of objects with fields: "name", "age", "description", "cause of death", and "wiki_path" (the same path provided in the input).',
    'If no matches are found, return an empty JSON array []. Return only JSON.',
    '---',
    lines.join('\n'),
    '----',
  ].join('\n\n');
}

export async function callReplicate(env: Env, prompt: string) {
  const cfg = getConfig(env);
  const body = {
    stream: false,
    input: {
      prompt,
      system_prompt: 'Return only valid JSON or an empty JSON object as instructed. No extra commentary.',
      verbosity: 'low',
      reasoning_effort: 'minimal',
      max_completion_tokens: 4096,
    },
    webhook: env.REPLICATE_WEBHOOK_SECRET
      ? `${cfg.baseUrl}/replicate/callback?secret=${encodeURIComponent(env.REPLICATE_WEBHOOK_SECRET)}`
      : `${cfg.baseUrl}/replicate/callback`,
    webhook_events_filter: ['completed'],
  };

  const res = await fetchWithRetry('https://api.replicate.com/v1/models/openai/gpt-5-mini/predictions', {
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

