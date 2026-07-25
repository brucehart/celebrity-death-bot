type RetryOptions = {
	retries?: number;
	backoffMs?: number;
	maxBackoffMs?: number;
	timeoutMs?: number;
	service?: string;
};

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeUpstreamName(input: RequestInfo): string {
	const raw = typeof input === 'string' ? input : input.url;
	try {
		return new URL(raw).hostname || 'upstream';
	} catch {
		return 'upstream';
	}
}

function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUSES.has(status) || status >= 500;
}

function parseRetryAfterMs(response: Response): number | null {
	const raw = response.headers.get('Retry-After')?.trim();
	if (!raw) return null;

	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

	const dateMs = Date.parse(raw);
	if (!Number.isFinite(dateMs)) return null;
	return Math.max(0, dateMs - Date.now());
}

function getRetryDelayMs(response: Response | null, attempt: number, backoffMs: number, maxBackoffMs: number): number {
	const retryAfterMs = response ? parseRetryAfterMs(response) : null;
	if (retryAfterMs !== null) return Math.min(retryAfterMs, maxBackoffMs);
	return Math.min(backoffMs * 2 ** Math.max(0, attempt - 1), maxBackoffMs);
}

async function discardResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The response is already unusable; failure to cancel it should not block the retry.
	}
}

export class UpstreamFetchError extends Error {
	readonly attempts: number;
	readonly status?: number;
	readonly requestId?: string;

	constructor(service: string, attempts: number, options?: { status?: number; requestId?: string; error?: unknown }) {
		const requestIdSuffix = options?.requestId ? `; request id ${options.requestId}` : '';
		const detail =
			options?.status !== undefined
				? `returned HTTP ${options.status}`
				: `request failed: ${errorMessage(options?.error ?? 'unknown error')}`;
		super(`${service} ${detail} after ${attempts} attempts${requestIdSuffix}`);
		this.name = 'UpstreamFetchError';
		this.attempts = attempts;
		this.status = options?.status;
		this.requestId = options?.requestId;
	}
}

export async function fetchWithRetry(input: RequestInfo, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
	const retries = Number.isFinite(opts.retries) && Number(opts.retries) > 0 ? Math.floor(Number(opts.retries)) : 0;
	const backoffMs = Number.isFinite(opts.backoffMs) && Number(opts.backoffMs) >= 0 ? Number(opts.backoffMs) : 400;
	const maxBackoffMs = Number.isFinite(opts.maxBackoffMs) && Number(opts.maxBackoffMs) >= 0 ? Number(opts.maxBackoffMs) : 8_000;
	const maxAttempts = retries + 1;
	const service = opts.service?.trim() || safeUpstreamName(input);
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const controller = new AbortController();
		const timeoutId = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
		let response: Response | null = null;

		try {
			response = await fetch(input, { ...init, signal: controller.signal });
		} catch (error) {
			lastError = error;
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
		}

		if (response) {
			if (response.ok || !isRetryableStatus(response.status)) return response;

			lastError = new UpstreamFetchError(service, attempt, {
				status: response.status,
				requestId: response.headers.get('x-request-id') || response.headers.get('cf-ray') || undefined,
			});
		}

		if (attempt === maxAttempts) {
			if (response) await discardResponse(response);
			break;
		}
		const delayMs = getRetryDelayMs(response, attempt, backoffMs, maxBackoffMs);
		if (response) await discardResponse(response);
		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	}

	if (lastError instanceof UpstreamFetchError) {
		throw new UpstreamFetchError(service, maxAttempts, { status: lastError.status, requestId: lastError.requestId });
	}
	throw new UpstreamFetchError(service, maxAttempts, { error: lastError });
}
