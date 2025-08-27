import type { Env } from '../types.ts';

const MONTH_KEY_PREFIX = 'wiki_paths:'; // e.g., wiki_paths:2025-08
const LOCK_KEY_PREFIX = 'lock:'; // e.g., lock:2025-08

export type YearMonth = { year: number; month: number }; // month: 1-12

// Use a delimiter that cannot appear in Wikipedia titles.
const DELIM = '|';

export function monthKey({ year, month }: YearMonth) {
  const mm = month.toString().padStart(2, '0');
  return `${MONTH_KEY_PREFIX}${year}-${mm}`;
}

export function monthLockKey({ year, month }: YearMonth) {
  const mm = month.toString().padStart(2, '0');
  return `${LOCK_KEY_PREFIX}${year}-${mm}`;
}

export async function getMonthlyPaths(env: Env, ym: YearMonth): Promise<string[]> {
  const key = monthKey(ym);
  const raw = await env.celebrity_death_bot_kv.get(key, 'text');
  if (!raw) return [];
  // Split and filter empty strings defensively
  return raw.split(DELIM).map((s) => s.trim()).filter(Boolean);
}

export async function putMonthlyPaths(env: Env, ym: YearMonth, paths: string[]): Promise<void> {
  const key = monthKey(ym);
  const cleaned = uniqueSorted(paths);
  const serialized = cleaned.join(DELIM);
  await env.celebrity_death_bot_kv.put(key, serialized);
}

export async function tryAcquireMonthLock(env: Env, ym: YearMonth): Promise<boolean> {
  const key = monthLockKey(ym);
  // Best-effort: check then set with a TTL to auto-expire.
  const existing = await env.celebrity_death_bot_kv.get(key);
  if (existing) return false;
  try {
    await env.celebrity_death_bot_kv.put(
      key,
      String(Date.now()),
      { expirationTtl: 300, metadata: { createdAt: Date.now(), scope: 'monthly-update' } as any }
    );
    return true;
  } catch {
    return false;
  }
}

export async function releaseMonthLock(env: Env, ym: YearMonth): Promise<void> {
  const key = monthLockKey(ym);
  try {
    await env.celebrity_death_bot_kv.delete(key);
  } catch {
    // Ignore
  }
}

export function uniqueSorted(items: string[]): string[] {
  // Ensure stable, binary-order sort without locale variance
  const set = new Set<string>();
  for (const s of items) {
    const v = (s ?? '').toString().trim();
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function diffSorted(existingSorted: string[], scrapedSorted: string[]): string[] {
  // Return items present in scrapedSorted but not in existingSorted
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < existingSorted.length && j < scrapedSorted.length) {
    const a = existingSorted[i];
    const b = scrapedSorted[j];
    if (a === b) {
      i++;
      j++;
    } else if (a < b) {
      i++;
    } else {
      out.push(b);
      j++;
    }
  }
  while (j < scrapedSorted.length) {
    out.push(scrapedSorted[j++]);
  }
  return out;
}

export function mergeSortedUnique(aSorted: string[], bSorted: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < aSorted.length && j < bSorted.length) {
    const a = aSorted[i];
    const b = bSorted[j];
    if (a === b) {
      out.push(a);
      i++;
      j++;
    } else if (a < b) {
      out.push(a);
      i++;
    } else {
      out.push(b);
      j++;
    }
  }
  while (i < aSorted.length) out.push(aSorted[i++]);
  while (j < bSorted.length) out.push(bSorted[j++]);
  return out;
}

