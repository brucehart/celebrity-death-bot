// Cloudflare Worker entrypoint
// - Exposes HTTP routes and a scheduled cron job
// - Serves a minimal static asset (privacy policy) via the ASSETS binding
// - All business logic lives in small, focused route/service modules
import type { Env } from './types.ts';
import { Router } from './router.ts';
import { replicateCallback } from './routes/replicate-callback.ts';
import { manualRun } from './routes/run.ts';
import { telegramWebhook } from './routes/telegram-webhook.ts';
import { health } from './routes/health.ts';
import { runJob } from './services/job.ts';
import { xOauthStart, xOauthCallback, xOauthStatus } from './services/x.ts';

const router = new Router()
  .on('POST', '/replicate/callback', (req, env) => replicateCallback(req, env))
  .on('POST', '/telegram/webhook', (req, env) => telegramWebhook(req, env))
  .on('POST', '/run', (req, env) => manualRun(req, env))
  .on('GET', '/x/oauth/start', (_req, env) => xOauthStart(env, env.BASE_URL))
  .on('GET', '/x/oauth/callback', (req, env) => xOauthCallback(env, req.url, env.BASE_URL))
  .on('GET', '/x/oauth/status', (_req, env) => xOauthStatus(env))
  .on('GET', '/health', () => health());

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const res = await runJob(env);
          console.log('Job complete', res);
        } catch (err) {
          console.error('Job error', err);
        }
      })()
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Serve privacy policy via Workers Assets when explicitly requested
    if (url.pathname === '/privacy' && request.method === 'GET') {
      return env.ASSETS.fetch(new Request('privacy.html', request));
    }
    return router.handle(request, env, ctx);
  },
};
