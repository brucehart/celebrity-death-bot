import type { Env } from '../types.ts';
import { runJob, runJobForIds, runJobForWikiPaths, runPending } from '../services/job.ts';
import { getConfig } from '../config.ts';
import { checkRateLimits } from '../services/rate-limit.ts';
import { BodyTooLargeError, MAX_ADMIN_FORM_BYTES, readRequestTextBounded } from '../utils/request.ts';
import { secureCompareStrings } from '../utils/security.ts';

type RunOptions = {
	ids?: number[];
	wikiPaths?: string[];
	retryPending: boolean;
	pendingLimit?: number;
	model?: string;
	provider?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseOptions(value: unknown): RunOptions {
	const options: RunOptions = { retryPending: false };
	if (!isRecord(value)) return options;

	const ids = Array.isArray(value.ids) ? value.ids : typeof value.id === 'number' ? [value.id] : [];
	options.ids = ids
		.map(Number)
		.filter((id) => Number.isSafeInteger(id) && id > 0)
		.slice(0, 100);
	const paths = Array.isArray(value.wiki_paths) ? value.wiki_paths : typeof value.wiki_path === 'string' ? [value.wiki_path] : [];
	options.wikiPaths = paths
		.filter((path): path is string => typeof path === 'string')
		.map((path) => path.trim())
		.filter((path) => path.length > 0 && path.length <= 512)
		.slice(0, 100);
	options.retryPending = value.retry_pending === true;
	const parsedLimit = Number(value.pending_limit ?? value.limit);
	if (Number.isFinite(parsedLimit) && parsedLimit > 0) options.pendingLimit = Math.min(Math.floor(parsedLimit), 400);
	if (typeof value.model === 'string' && value.model.trim()) options.model = value.model.trim().slice(0, 200);
	const providerValue = typeof value.provider === 'string' ? value.provider : value.llm_provider;
	if (typeof providerValue === 'string' && providerValue.trim()) options.provider = providerValue.trim().slice(0, 50);
	return options;
}

export async function manualRun(request: Request, env: Env): Promise<Response> {
	const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
	const cfg = getConfig(env);
	const rateLimit = await checkRateLimits(env, 'run', ip, cfg.rateLimit.run.windows);
	if (!rateLimit.allowed) {
		console.warn('Rate limit exceeded for /run', { ip, window: rateLimit.exceeded?.windowSeconds });
		return new Response('Too Many Requests', {
			status: 429,
			headers: { 'Retry-After': String(rateLimit.exceeded?.resetSeconds || 60) },
		});
	}

	if (!env.MANUAL_RUN_SECRET) return new Response('Manual run is not configured', { status: 503 });
	const rawAuthorization = request.headers.get('Authorization')?.trim() || '';
	const bearer = /^Bearer\s+(.+)$/i.exec(rawAuthorization);
	const token = (bearer?.[1] || '').trim();
	if (!token || !(await secureCompareStrings(token, env.MANUAL_RUN_SECRET))) return new Response('Unauthorized', { status: 401 });

	let options: RunOptions = { retryPending: false };
	if ((request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
		try {
			options = parseOptions(JSON.parse(await readRequestTextBounded(request, MAX_ADMIN_FORM_BYTES)));
		} catch (error) {
			return new Response(error instanceof BodyTooLargeError ? 'Request too large' : 'Invalid JSON', {
				status: error instanceof BodyTooLargeError ? 413 : 400,
			});
		}
	}

	try {
		if (options.ids?.length) return Response.json({ ok: true, mode: 'ids', ...(await runJobForIds(env, options.ids, options)) });
		if (options.wikiPaths?.length) {
			return Response.json({ ok: true, mode: 'wiki_paths', ...(await runJobForWikiPaths(env, options.wikiPaths, options)) });
		}
		if (options.retryPending) {
			return Response.json({
				ok: true,
				mode: 'retry_pending',
				...(await runPending(env, { ...options, limit: options.pendingLimit, drain: options.pendingLimit == null })),
			});
		}
		return Response.json({ ok: true, mode: 'full', ...(await runJob(env, options)) });
	} catch (error) {
		console.error('Manual run failed', error instanceof Error ? error.message : String(error));
		return Response.json({ ok: false, error: 'Job failed' }, { status: 500 });
	}
}
