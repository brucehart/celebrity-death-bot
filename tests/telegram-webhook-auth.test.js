import test from 'node:test';
import assert from 'node:assert/strict';

import { telegramWebhook } from '../src/routes/telegram-webhook.ts';

const makeEnv = (secret) => ({
  TELEGRAM_WEBHOOK_SECRET: secret,
  // Unused in these tests, but required by Env type:
  DB: /** @type any */ ({}),
  TELEGRAM_BOT_TOKEN: 'dummy',
  BASE_URL: 'https://example.com',
  REPLICATE_API_TOKEN: 'dummy',
  MANUAL_RUN_SECRET: 'dummy',
  ASSETS: /** @type any */ ({}),
});

const makeRequest = (headers = {}) => new Request('https://example.com/telegram/webhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({}), // empty body to trigger ignored path when authorized
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

