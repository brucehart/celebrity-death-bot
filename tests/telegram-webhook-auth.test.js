import test from 'node:test';
import assert from 'node:assert/strict';

import { telegramWebhook } from '../src/routes/telegram-webhook.ts';

const makeEnv = (secret) => ({
	TELEGRAM_WEBHOOK_SECRET: secret,
	DB: /** @type any */ ({
		prepare: () => ({
			bind() {
				return this;
			},
			async first() {
				return { claimed: 1 };
			},
			async run() {
				return { meta: { changes: 1 } };
			},
		}),
	}),
	TELEGRAM_BOT_TOKEN: 'dummy',
	BASE_URL: 'https://example.com',
	REPLICATE_API_TOKEN: 'dummy',
	MANUAL_RUN_SECRET: 'dummy',
	ASSETS: /** @type any */ ({}),
});

const makeRequest = (headers = {}) =>
	new Request('https://example.com/telegram/webhook', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ update_id: 123 }), // no message triggers the ignored path
	});

test('fails closed when the webhook secret is not configured', async () => {
	const env = makeEnv(undefined);
	const req = makeRequest();
	const res = await telegramWebhook(req, env);
	assert.equal(res.status, 503);
});

test('rejects when header is missing', async () => {
	const env = makeEnv('s3cret');
	const req = makeRequest();
	const res = await telegramWebhook(req, env);
	assert.equal(res.status, 401);
});

test('rejects when header mismatches', async () => {
	const env = makeEnv('s3cret');
	const req = makeRequest({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong' });
	const res = await telegramWebhook(req, env);
	assert.equal(res.status, 401);
});

test('accepts when header matches and returns ignored for empty body', async () => {
	const env = makeEnv('s3cret');
	const req = makeRequest({ 'X-Telegram-Bot-Api-Secret-Token': 's3cret' });
	const res = await telegramWebhook(req, env);
	assert.equal(res.status, 200);
	const json = await res.json();
	assert.equal(json.ignored, true);
});

test('replayed update IDs are acknowledged without processing twice', async () => {
	let claimed = false;
	const env = makeEnv('s3cret');
	env.DB = {
		prepare(sql) {
			return {
				bind() {
					return this;
				},
				async first() {
					if (!sql.includes('INSERT INTO processed_webhooks') || claimed) return null;
					claimed = true;
					return { claimed: 1 };
				},
				async run() {
					return { meta: { changes: 1 } };
				},
			};
		},
	};
	const headers = { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' };
	assert.equal((await telegramWebhook(makeRequest(headers), env)).status, 200);
	const replay = await telegramWebhook(makeRequest(headers), env);
	assert.equal(replay.status, 200);
	assert.equal((await replay.json()).duplicate, true);
});
