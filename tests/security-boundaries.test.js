import test from 'node:test';
import assert from 'node:assert/strict';

import { openaiWebhook } from '../src/routes/openai-webhook.ts';
import { replicateCallback } from '../src/routes/replicate-callback.ts';
import { BodyTooLargeError, readRequestTextBounded } from '../src/utils/request.ts';
import { secureCompareStrings } from '../src/utils/security.ts';

test('provider webhooks fail closed before reading the body when secrets are absent', async () => {
	const body = JSON.stringify({ id: 'event', status: 'succeeded' });
	const replicate = await replicateCallback(new Request('https://example.com/replicate/callback', { method: 'POST', body }), {});
	const openai = await openaiWebhook(new Request('https://example.com/openai/webhook', { method: 'POST', body }), {});
	assert.equal(replicate.status, 503);
	assert.equal(openai.status, 503);
});

test('bounded body reader rejects declared and streamed bodies over the cap', async () => {
	const declared = new Request('https://example.com', { headers: { 'Content-Length': '100' }, body: 'small', method: 'POST' });
	await assert.rejects(() => readRequestTextBounded(declared, 10), BodyTooLargeError);

	const streamed = new Request('https://example.com', { body: '01234567890', method: 'POST' });
	await assert.rejects(() => readRequestTextBounded(streamed, 10), BodyTooLargeError);
});

test('secret comparison accepts only exact values', async () => {
	assert.equal(await secureCompareStrings('correct', 'correct'), true);
	assert.equal(await secureCompareStrings('correct', 'incorrect'), false);
	assert.equal(await secureCompareStrings('', 'correct'), false);
});
