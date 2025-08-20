import type { Env } from '../types';

export type RateWindow = { windowSeconds: number; limit: number };

export type RateLimitResult = {
  allowed: boolean;
  exceeded?: {
    windowSeconds: number;
    limit: number;
    count: number;
    resetSeconds: number; // seconds until the window resets
  };
};

function makeKey(scope: string, identifier: string, windowSeconds: number): string {
  return `rl:${scope}:${identifier}:${windowSeconds}`;
}

async function incrementAndGet(env: Env, key: string, windowSeconds: number): Promise<{ count: number; windowStart: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / windowSeconds) * windowSeconds;

  // Upsert row for this key; if same window, increment, else reset
  await env.DB.prepare(
    `INSERT INTO rate_limits(key, window_start, count)
     VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN excluded.window_start = rate_limits.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = CASE WHEN excluded.window_start = rate_limits.window_start THEN rate_limits.window_start ELSE excluded.window_start END`
  )
    .bind(key, windowStart)
    .run();

  const row = await env.DB.prepare('SELECT count, window_start as windowStart FROM rate_limits WHERE key = ?1')
    .bind(key)
    .first<{ count: number; windowStart: number }>();

  return { count: row?.count ?? 1, windowStart: row?.windowStart ?? windowStart };
}

export async function checkRateLimits(env: Env, scope: string, identifier: string, windows: RateWindow[]): Promise<RateLimitResult> {
  let firstExceeded: RateLimitResult['exceeded'];
  for (const w of windows) {
    const key = makeKey(scope, identifier, w.windowSeconds);
    const { count, windowStart } = await incrementAndGet(env, key, w.windowSeconds);
    if (count > w.limit) {
      const nowSec = Math.floor(Date.now() / 1000);
      const resetSeconds = Math.max(0, windowStart + w.windowSeconds - nowSec);
      // Keep the first exceeded window; it will have the shortest reset in most cases
      if (!firstExceeded) {
        firstExceeded = { windowSeconds: w.windowSeconds, limit: w.limit, count, resetSeconds };
      }
    }
  }
  return firstExceeded ? { allowed: false, exceeded: firstExceeded } : { allowed: true };
}

