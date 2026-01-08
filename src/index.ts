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
import { getRecentPosts } from './routes/posts.ts';
import { getMeta } from './routes/meta.ts';
import { llmDebug } from './routes/llm-debug.ts';
import { login, oauthCallback } from './routes/auth.ts';

const router = new Router()
  .on('POST', '/replicate/callback', (req, env) => replicateCallback(req, env))
  .on('POST', '/telegram/webhook', (req, env) => telegramWebhook(req, env))
  .on('POST', '/run', (req, env) => manualRun(req, env))
  // Serve homepage via Workers Assets. Pass the original request for headers/method consistency.
  .on('GET', '/', (req, env) => env.ASSETS.fetch(new Request('index.html', req)))
  .on('GET', '/api/posts', (req, env) => getRecentPosts(req, env))
  .on('GET', '/api/meta', (_req, env) => getMeta(env))
  .on('GET', '/llm-debug', (req, env, ctx) => llmDebug(req, env, ctx))
  .on('POST', '/llm-debug', (req, env, ctx) => llmDebug(req, env, ctx))
  .on('GET', '/login', (req, env) => login(req, env))
  .on('GET', '/oauth/callback', (req, env) => oauthCallback(req, env))
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
    // Route first
    const res = await router.handle(request, env, ctx);
    // Fallback to static assets (images, CSS, etc.) only when no route matched
    if (res.status === 404) {
      const asset = await env.ASSETS.fetch(request);
      return asset;
    }
    return res;
  },
};
