import type { Env, DeathEntry } from '../types.ts';
import { toNYYear, parseWikipedia } from './wiki.ts';
import { insertBatchReturningNew } from './db.ts';
import { buildReplicatePrompt, callReplicate } from './replicate.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getConfig } from '../config.ts';
import { YearMonth, getMonthlyPaths, putMonthlyPaths, diffSorted, mergeSortedUnique, uniqueSorted, tryAcquireMonthLock, releaseMonthLock } from './kv-monthly.ts';
import { selectDeathsByIds, selectDeathsByWikiPaths } from './db.ts';

// Orchestrates a single scan-and-notify run:
// 1) Fetch the current (and early-month previous) Wikipedia "Deaths in <Month> <Year>" pages.
// 2) Parse entries, compare with a monthly KV cache to identify truly new wiki_paths.
// 3) Insert new rows into D1 in a safe batch and enqueue LLM filtering via Replicate.

export async function runJob(env: Env) {
  const cfg = getConfig(env);
  const year = toNYYear();

  // Determine target months in America/New_York tz
  // Allow configurable lookback window (in days) for including the previous month
  const rawLookback = env.LOOKBACK_DAYS;
  const parsedLookback = rawLookback !== undefined ? Number(rawLookback) : NaN;
  const lookbackDays = Number.isFinite(parsedLookback) && parsedLookback > 0 ? Math.floor(parsedLookback) : 5;

  const monthNY = Number(
    new Date().toLocaleString('en-US', {
      timeZone: cfg.tz,
      month: 'numeric',
    })
  );
  const dayNY = Number(
    new Date().toLocaleString('en-US', {
      timeZone: cfg.tz,
      day: 'numeric',
    })
  );
  const targets: YearMonth[] = [{ year, month: monthNY }];
  if (!Number.isNaN(dayNY) && dayNY <= lookbackDays) {
    const prevMonth = monthNY === 1 ? 12 : monthNY - 1;
    const prevYear = monthNY === 1 ? year - 1 : year;
    targets.push({ year: prevYear, month: prevMonth });
  }

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

  const allNewEntries: DeathEntry[] = [];
  let totalParsed = 0;

  for (const ym of targets) {
    const monthName = monthNames[ym.month - 1];
    const targetUrl = `https://en.wikipedia.org/wiki/Deaths_in_${monthName}_${ym.year}`;

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
    totalParsed += parsed.length;

    // Build sorted sets for KV comparison
    const scrapedSorted = uniqueSorted(parsed.map((e) => e.wiki_path));
    const existingSorted = uniqueSorted(await getMonthlyPaths(env, ym));
    const newPaths = diffSorted(existingSorted, scrapedSorted);

    if (newPaths.length) {
      // Map wiki_path -> entry for quick filter
      const map: Record<string, DeathEntry> = {};
      for (const e of parsed) {
        if (!map[e.wiki_path]) map[e.wiki_path] = e;
      }
      for (const p of newPaths) {
        const row = map[p];
        if (row) allNewEntries.push(row);
      }

      // Try to update month KV under a short-lived lock
      const gotLock = await tryAcquireMonthLock(env, ym);
      try {
        if (gotLock) {
          const latestExisting = uniqueSorted(await getMonthlyPaths(env, ym));
          const merged = mergeSortedUnique(latestExisting, uniqueSorted(newPaths));
          await putMonthlyPaths(env, ym, merged);
        }
      } finally {
        if (gotLock) await releaseMonthLock(env, ym);
      }
    }
  }

  // Insert into D1 with a single batched operation that returns the newly inserted rows
  const insertedRows = await insertBatchReturningNew(env, allNewEntries);

  if (insertedRows.length > 0) {
    const prompt = buildReplicatePrompt(insertedRows);
    await callReplicate(env, prompt);
  }

  return { scanned: totalParsed, inserted: insertedRows.length };
}

// Re-enqueue specific existing rows (by D1 ids) for LLM filtering & summary.
// This builds a prompt only for the requested rows and calls Replicate. The
// standard /replicate/callback will process results and send notifications.
export async function runJobForIds(env: Env, ids: number[]) {
  const rows = await selectDeathsByIds(env, ids);
  if (!rows.length) return { queued: 0, message: 'No matching ids' } as const;
  const forcedPaths = Array.from(new Set(rows.map((r) => String(r.wiki_path || '').trim()).filter(Boolean)));
  const prompt = buildReplicatePrompt(rows, forcedPaths);
  await callReplicate(env, prompt, { forcedPaths });
  return { queued: rows.length } as const;
}

export async function runJobForWikiPaths(env: Env, wikiPaths: string[]) {
  const rows = await selectDeathsByWikiPaths(env, wikiPaths);
  if (!rows.length) return { queued: 0, message: 'No matching wiki_paths' } as const;
  const forcedPaths = Array.from(new Set(rows.map((r) => String(r.wiki_path || '').trim()).filter(Boolean)));
  const prompt = buildReplicatePrompt(rows, forcedPaths);
  await callReplicate(env, prompt, { forcedPaths });
  return { queued: rows.length } as const;
}
