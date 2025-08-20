import test from 'node:test';
import assert from 'node:assert/strict';

// Polyfill atob/btoa for Node if missing
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (bin) => Buffer.from(bin, 'binary').toString('base64');
}

// Ensure Web Crypto is available (Node >= 16.5 has webcrypto)
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  globalThis.crypto = webcrypto;
}

import { computeReplicateSignature, verifyReplicateSignatureParts } from '../src/utils/replicate-webhook.ts';

test('verifyReplicateSignatureParts accepts valid signature', async () => {
  const rawSecret = 'supersecretkey123';
  const secret = 'whsec_' + Buffer.from(rawSecret).toString('base64');
  const webhookId = 'evt_123';
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ id: 'pred_abc', status: 'succeeded', output: '[]' });
  const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
  const sig = await computeReplicateSignature(secret, signedContent);
  const header = `v1,${sig}`;

  const ok = await verifyReplicateSignatureParts(secret, webhookId, webhookTimestamp, header, body, 300);
  assert.equal(ok, true);
});

test('verifyReplicateSignatureParts rejects invalid signature', async () => {
  const rawSecret = 'supersecretkey123';
  const secret = 'whsec_' + Buffer.from(rawSecret).toString('base64');
  const webhookId = 'evt_456';
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ id: 'pred_def', status: 'succeeded', output: '[]' });
  const badHeader = `v1,not-a-valid-signature`;

  const ok = await verifyReplicateSignatureParts(secret, webhookId, webhookTimestamp, badHeader, body, 300);
  assert.equal(ok, false);
});

test('verifyReplicateSignatureParts rejects stale timestamp beyond tolerance', async () => {
  const rawSecret = 'supersecretkey123';
  const secret = 'whsec_' + Buffer.from(rawSecret).toString('base64');
  const webhookId = 'evt_789';
  const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60); // 1 hour old
  const body = JSON.stringify({ id: 'pred_ghi', status: 'succeeded', output: '[]' });
  const signedContent = `${webhookId}.${staleTs}.${body}`;
  const sig = await computeReplicateSignature(secret, signedContent);
  const header = `v1,${sig}`;

  const ok = await verifyReplicateSignatureParts(secret, webhookId, staleTs, header, body, 5 * 60); // 5 minutes window
  assert.equal(ok, false);
});

