import type { Env } from '../types.ts';
import { runJob } from '../services/job.ts';
import { getConfig } from '../config.ts';
import { checkRateLimits } from '../services/rate-limit.ts';

export async function manualRun(request: Request, env: Env): Promise<Response> {
  // Apply rate limiting per IP (covers both authorized and unauthorized attempts)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const cfg = getConfig(env);
  const rl = await checkRateLimits(env, 'run', ip, cfg.rateLimit.run.windows);
  if (!rl.allowed) {
    console.warn(`Rate limit exceeded for /run from ${ip}; window=${rl.exceeded!.windowSeconds}s count=${rl.exceeded!.count} limit=${rl.exceeded!.limit}`);
    return new Response('Too Many Requests', {
      status: 429,
      headers: {
        'Retry-After': String(rl.exceeded!.resetSeconds || 60),
      },
    });
  }
  // Authorization header is case-insensitive; fetch once and parse optional Bearer prefix
  const auth = request.headers.get('Authorization') || '';
  const token = (() => {
    const maybe = auth.trim();
    if (!maybe) return '';
    const m = /^Bearer\s+(.+)$/i.exec(maybe);
    return m ? m[1].trim() : maybe;
  })();
  if (!token || token !== env.MANUAL_RUN_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const res = await runJob(env);
    return Response.json({ ok: true, ...res });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
