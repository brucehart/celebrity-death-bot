import type { Env, DeathEntry } from '../types.ts';
import { toNYYear, parseWikipedia } from './wiki.ts';
import { insertIfNew } from './db.ts';
import { buildReplicatePrompt, callReplicate } from './replicate.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getConfig } from '../config.ts';

export async function runJob(env: Env) {
  const cfg = getConfig(env);
  const year = toNYYear();

  // Always scan the yearly page; during the first 5 days of a month,
  // also scan the previous month's page to catch delayed updates.
  const urls: string[] = [`https://en.wikipedia.org/wiki/Deaths_in_${year}`];

  const dayNY = Number(
    new Date().toLocaleString('en-US', {
      timeZone: cfg.tz,
      day: 'numeric',
    })
  );
  if (!Number.isNaN(dayNY) && dayNY <= 5) {
    const monthNY = Number(
      new Date().toLocaleString('en-US', {
        timeZone: cfg.tz,
        month: 'numeric',
      })
    );
    const prevMonthIndex = monthNY === 1 ? 12 : monthNY - 1; // 1-12
    const prevYear = monthNY === 1 ? year - 1 : year;
    const monthNames = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const prevMonthName = monthNames[prevMonthIndex - 1];
    urls.push(`https://en.wikipedia.org/wiki/Deaths_in_${prevMonthName}_${prevYear}`);
  }

  const parsedAll: DeathEntry[] = [];
  for (const targetUrl of urls) {
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
    parsedAll.push(...parsed);
  }

  // Per-row check and insert: SELECT by wiki_path, then INSERT if new
  const newOnes: DeathEntry[] = [];
  for (const e of parsedAll) {
    try {
      const inserted = await insertIfNew(env, e);
      if (inserted) newOnes.push(e);
    } catch (err2) {
      console.warn('Insert failed', e.wiki_path, err2);
    }
  }

  if (newOnes.length > 0) {
    const prompt = buildReplicatePrompt(newOnes);
    await callReplicate(env, prompt);
  }

  return { scanned: parsedAll.length, inserted: newOnes.length };
}
