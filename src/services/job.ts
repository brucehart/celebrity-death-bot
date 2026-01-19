import type { Env, DeathEntry } from '../types.ts';
import { toNYYear, parseWikipedia } from './wiki.ts';
import { insertBatchReturningNew, selectDeathsByIds, selectDeathsByWikiPaths, selectPendingDeaths } from './db.ts';
import { evaluateDeaths, getDefaultLlmProvider, normalizeLlmProvider } from './llm.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getConfig } from '../config.ts';
import { YearMonth, getMonthlyPaths, putMonthlyPaths, diffSorted, mergeSortedUnique, uniqueSorted, tryAcquireMonthLock, releaseMonthLock } from './kv-monthly.ts';

// Orchestrates a single scan-and-notify run:
// 1) Fetch the current (and early-month previous) Wikipedia "Deaths in <Month> <Year>" pages.
// 2) Parse entries, compare with a monthly KV cache to identify truly new wiki_paths.
// 3) Insert new rows into D1 in a safe batch and enqueue LLM filtering via the configured provider.

export async function runJob(env: Env, opts?: { model?: string; provider?: string; pendingLimit?: number }) {
	const cfg = getConfig(env);
	const provider = normalizeLlmProvider(opts?.provider, getDefaultLlmProvider(env));
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
		if (provider === 'openai' && insertedRows.length > 20) {
			for (let i = 0; i < insertedRows.length; i += 20) {
				const chunk = insertedRows.slice(i, i + 20);
				await evaluateDeaths(env, chunk, { model: opts?.model, provider });
			}
		} else {
			await evaluateDeaths(env, insertedRows, { model: opts?.model, provider });
		}
	}

	const excludePaths = insertedRows
		.map((row) => String(row.wiki_path || '').trim())
		.filter(Boolean);
	const pendingResult = await runPending(env, { limit: opts?.pendingLimit, model: opts?.model, provider, excludePaths });

	return { scanned: totalParsed, inserted: insertedRows.length, retried: pendingResult.queued };
}

// Re-run any existing rows still marked as pending (no LLM decision yet).
// Batches requests to keep prompts reasonably small and avoid token overflows.
export async function runPending(
	env: Env,
	opts?: { limit?: number; model?: string; excludePaths?: string[]; provider?: string; drain?: boolean }
) {
	const provider = normalizeLlmProvider(opts?.provider, getDefaultLlmProvider(env));
	const drain = provider === 'openai' && opts?.drain === true;
	const limitRaw = Number(opts?.limit);
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : drain ? Number.POSITIVE_INFINITY : 120;
	const maxTotal = provider === 'replicate' && Number.isFinite(limit) ? Math.min(limit, 400) : limit;
	const excludeSet = new Set((opts?.excludePaths || []).map((s) => String(s || '').trim()).filter(Boolean));

	const CHUNK = provider === 'openai' ? 20 : 30;
	let queued = 0;
	let batches = 0;
	let notified = 0;
	let rejected = 0;
	let errored = 0;
	let sawRows = false;

	while (queued < maxTotal) {
		const remaining = Number.isFinite(maxTotal) ? Math.max(0, maxTotal - queued) : 400;
		if (Number.isFinite(maxTotal) && remaining <= 0) break;
		const extra = excludeSet.size ? Math.min(excludeSet.size, 400) : 0;
		const fetchLimit = Math.min(400, remaining + extra);

		const rows = await selectPendingDeaths(env, fetchLimit);
		if (!rows.length) {
			if (!sawRows) return { queued: 0, message: 'No pending rows', provider } as const;
			break;
		}
		sawRows = true;

		const filtered = excludeSet.size ? rows.filter((row) => !excludeSet.has(String(row.wiki_path || '').trim())) : rows;
		const sliceLimit = Number.isFinite(maxTotal) ? Math.min(filtered.length, maxTotal - queued) : filtered.length;
		const selected = filtered.slice(0, sliceLimit);
		if (!selected.length) return { queued: 0, message: 'No pending rows', provider } as const;

		for (let i = 0; i < selected.length; i += CHUNK) {
			const chunk = selected.slice(i, i + CHUNK);
			const res = await evaluateDeaths(env, chunk, { model: opts?.model, provider });
			queued += chunk.length;
			batches++;
			if (provider === 'openai' && 'notified' in res) {
				notified += res.notified;
				rejected += res.rejected;
				errored += res.errored;
			}
		}

		if (provider === 'replicate') break;
		if (rows.length < fetchLimit) break;
	}

	const limited = Number.isFinite(maxTotal) ? queued >= maxTotal : false;
	return { queued, batches, limited, notified, rejected, errored, provider } as const;
}

// Re-enqueue specific existing rows (by D1 ids) for LLM filtering & summary.
// For Replicate, results are processed later by /replicate/callback.
export async function runJobForIds(env: Env, ids: number[], opts?: { model?: string; provider?: string }) {
	const rows = await selectDeathsByIds(env, ids);
	if (!rows.length) return { queued: 0, message: 'No matching ids' } as const;
	const forcedPaths = Array.from(new Set(rows.map((r) => String(r.wiki_path || '').trim()).filter(Boolean)));
	const res = await evaluateDeaths(env, rows, { forcedPaths, model: opts?.model, provider: opts?.provider });
	return { queued: rows.length, ...res } as const;
}

export async function runJobForWikiPaths(env: Env, wikiPaths: string[], opts?: { model?: string; provider?: string }) {
	const rows = await selectDeathsByWikiPaths(env, wikiPaths);
	if (!rows.length) return { queued: 0, message: 'No matching wiki_paths' } as const;
	const forcedPaths = Array.from(new Set(rows.map((r) => String(r.wiki_path || '').trim()).filter(Boolean)));
	const res = await evaluateDeaths(env, rows, { forcedPaths, model: opts?.model, provider: opts?.provider });
	return { queued: rows.length, ...res } as const;
}
