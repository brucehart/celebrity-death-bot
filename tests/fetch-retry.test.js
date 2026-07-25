import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithRetry, UpstreamFetchError } from '../src/utils/fetch.ts';

test('fetchWithRetry recovers from transient server errors with bounded retries', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return calls < 3 ? new Response('temporary failure', { status: 500 }) : Response.json({ ok: true });
	};

	try {
		const response = await fetchWithRetry('https://api.example.com/jobs', {}, { retries: 3, backoffMs: 0, service: 'Example API' });
		assert.equal(response.status, 200);
		assert.equal(calls, 3);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchWithRetry retries rate limits but returns non-retryable client errors', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return calls === 1
			? new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
			: new Response('bad request', { status: 400 });
	};

	try {
		const response = await fetchWithRetry('https://api.example.com/jobs', {}, { retries: 2, backoffMs: 0 });
		assert.equal(response.status, 400);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchWithRetry reports the upstream, attempts, status, and request id without leaking URL paths', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response('failure', { status: 500, headers: { 'x-request-id': 'req_test_123' } });

	try {
		await assert.rejects(
			() => fetchWithRetry('https://api.telegram.org/bot-secret-token/sendMessage', {}, { retries: 1, backoffMs: 0 }),
			(error) => {
				assert.ok(error instanceof UpstreamFetchError);
				assert.equal(error.status, 500);
				assert.equal(error.attempts, 2);
				assert.match(error.message, /api\.telegram\.org returned HTTP 500 after 2 attempts; request id req_test_123/);
				assert.doesNotMatch(error.message, /secret-token/);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
