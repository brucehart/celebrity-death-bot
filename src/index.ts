// Cloudflare Worker entrypoint
// - Exposes HTTP routes and a scheduled cron job
// - Serves a minimal static asset (privacy policy) via the ASSETS binding
// - All business logic lives in small, focused route/service modules
import type { Env } from './types.ts';
import { Router } from './router.ts';
import { replicateCallback } from './routes/replicate-callback.ts';
import { openaiWebhook } from './routes/openai-webhook.ts';
import { manualRun } from './routes/run.ts';
import { telegramWebhook } from './routes/telegram-webhook.ts';
import { health } from './routes/health.ts';
import { runJob } from './services/job.ts';
import { xOauthStart, xOauthCallback, xOauthStatus } from './routes/x-oauth.ts';
import { getRecentPosts } from './routes/posts.ts';
import { getMeta } from './routes/meta.ts';
import { llmDebug } from './routes/llm-debug.ts';
import { login, logout, oauthCallback } from './routes/auth.ts';
import { alertOnJobError, alertOnJobResult } from './services/alerts.ts';
import { withSecurityHeaders } from './utils/response.ts';

const router = new Router()
	.on('POST', '/replicate/callback', (req, env) => replicateCallback(req, env))
	.on('POST', '/openai/webhook', (req, env) => openaiWebhook(req, env))
	.on('POST', '/telegram/webhook', (req, env) => telegramWebhook(req, env))
	.on('POST', '/run', (req, env) => manualRun(req, env))
	// Serve homepage via Workers Assets. Pass the original request for headers/method consistency.
	.on('GET', '/', (req, env) => env.ASSETS.fetch(new Request('index.html', req)))
	.on('GET', '/api/posts', (req, env) => getRecentPosts(req, env))
	.on('GET', '/api/meta', (_req, env) => getMeta(env))
	.on('GET', '/llm-debug', (req, env, ctx) => llmDebug(req, env, ctx))
	.on('POST', '/llm-debug', (req, env, ctx) => llmDebug(req, env, ctx))
	.on('GET', '/login', (req, env) => login(req, env))
	.on('POST', '/logout', (req, env) => logout(req, env))
	.on('GET', '/oauth/callback', (req, env) => oauthCallback(req, env))
	.on('GET', '/x/oauth/start', (req, env) => xOauthStart(req, env))
	.on('POST', '/x/oauth/start', (req, env) => xOauthStart(req, env))
	.on('GET', '/x/oauth/callback', (req, env) => xOauthCallback(req, env))
	.on('GET', '/x/oauth/status', (req, env) => xOauthStatus(req, env))
	.on('GET', '/health', () => health());

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			(async () => {
				try {
					const res = await runJob(env);
					console.log('Job complete', res);
					await alertOnJobResult(env, res);
				} catch (err) {
					console.error('Job error', err);
					await alertOnJobError(env, err);
				}
			})(),
		);
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		// Serve privacy policy via Workers Assets when explicitly requested
		if (url.pathname === '/privacy' && request.method === 'GET') {
			return withSecurityHeaders(await env.ASSETS.fetch(new Request('privacy.html', request)));
		}
		// Route first
		const res = await router.handle(request, env, ctx);
		// Fallback to static assets (images, CSS, etc.) only when no route matched
		if (res.status === 404 && (request.method === 'GET' || request.method === 'HEAD')) {
			const asset = await env.ASSETS.fetch(request);
			return withSecurityHeaders(asset);
		}
		return withSecurityHeaders(res);
	},
} satisfies ExportedHandler<Env>;
