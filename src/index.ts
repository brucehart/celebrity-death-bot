import type { Env } from './types';
import { Router } from './router';
import { replicateCallback } from './routes/replicate-callback';
import { manualRun } from './routes/run';
import { telegramWebhook } from './routes/telegram-webhook';
import { health } from './routes/health';
import { runJob } from './services/job';

const router = new Router()
  .on('POST', '/replicate/callback', (req, env) => replicateCallback(req, env))
  .on('POST', '/telegram/webhook', (req, env) => telegramWebhook(req, env))
  .on('POST', '/run', (req, env) => manualRun(req, env))
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
    if (url.pathname === '/privacy' && request.method === 'GET') {
      return env.ASSETS.fetch(new Request('privacy.html', request));
    }
    return router.handle(request, env, ctx);
  },
};
