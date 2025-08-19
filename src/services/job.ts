import type { Env, DeathEntry } from '../types';
import { toNYYear, parseWikipedia } from './wiki';
import { insertIfNew } from './db';
import { buildReplicatePrompt, callReplicate } from './replicate';
import { fetchWithRetry } from '../utils/fetch';
import { getConfig } from '../config';

export async function runJob(env: Env) {
  const cfg = getConfig(env);
  const year = toNYYear();
  const targetUrl = `https://en.wikipedia.org/wiki/Deaths_in_${year}`;
  const res = await fetchWithRetry(
    targetUrl,
    {
      headers: {
        'User-Agent': 'cf-worker-celeb-deaths/1.0 (+https://workers.cloudflare.com/)',
      },
    },
    { timeoutMs: cfg.limits.fetchTimeoutMs, retries: cfg.limits.fetchRetries }
  );
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${targetUrl}`);

  const html = await res.text();
  const parsed = parseWikipedia(html);

  const newOnes: DeathEntry[] = [];
  for (const e of parsed) {
    try {
      const inserted = await insertIfNew(env, e);
      if (inserted) newOnes.push(e);
    } catch (err) {
      console.warn('Insert failed', e.wiki_path, err);
    }
  }

  if (newOnes.length > 0) {
    const prompt = buildReplicatePrompt(newOnes);
    await callReplicate(env, prompt);
  }

  return { scanned: parsed.length, inserted: newOnes.length };
}

