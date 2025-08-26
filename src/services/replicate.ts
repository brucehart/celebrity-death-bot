import type { Env, DeathEntry } from '../types.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getConfig } from '../config.ts';

export function buildReplicatePrompt(newEntries: DeathEntry[]): string {
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
  return [
    'You are a filter for notable deaths for a U.S. audience. Input is a list of people with `name`, `age`, `description`, `cause of death`, and `wiki_path`.',
    '',
    '**Task:** Return only JSON. Include people if they are:',
    '',
    '* Major U.S. pro or college athletes (NFL, NBA, MLB, NHL, WWE, PGA, NCAA, FIFA), Olympic medalists or notable Olympic athletes, or global stars with strong U.S. coverage.',
    '',
    '* Widely known in film, TV, pop music, entertainment, media or commercials.',
    '',
    '* High-profile business leaders, artists, peformers, scientists, technologists, politicians, or notorious criminals.',
    '',
    'Exclude obscure or regional figures. Prefer U.S. relevance; lower weight if fame is outside U.S.',
    '',
    '**Output format:** JSON array of objects with fields:',
    '',
    '* `name`',
    '* `age`',
    '* `description` (10–25 words, why notable to U.S. public)',
    '* `cause_of_death` (or "unknown")',
    '* `wiki_path`',
    '',
    'If no matches, return `[]`. Output strictly JSON, nothing else.',
    '',
    '----',
    'Input (each line: name, age, description, cause of death, wiki_path):',
    '',
    lines.join('\n\n'),
    '----',
  ].join('\n');
}

export async function callReplicate(env: Env, prompt: string) {
  const cfg = getConfig(env);
  const body: any = {
    stream: false,
    input: {
      prompt,
      system_prompt: 'Output strictly JSON and nothing else. If no matches, return an empty JSON array [].',
      verbosity: 'low',
      reasoning_effort: 'minimal',
      max_completion_tokens: 4096,
    },
    // Replicate will sign webhooks; verification happens in the callback route.
    webhook: `${cfg.baseUrl}/replicate/callback`,
    webhook_events_filter: ['completed'],
  };
  // Attach minimal metadata to identify the batch candidates by wiki_path.
  if ((prompt || '').includes('Input (each line:')) {
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
