import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyGoogleToken } from '../src/auth.ts';

function encodePart(value) {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('Google ID tokens require a valid signature, audience, expiry, and nonce', async () => {
	const keys = await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	);
	const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
	const now = Math.floor(Date.now() / 1000);
	const header = encodePart({ alg: 'RS256', kid: 'test-key' });
	const payload = encodePart({
		iss: 'https://accounts.google.com',
		aud: 'google-client-id',
		exp: now + 300,
		iat: now,
		nonce: 'expected-nonce',
		email: 'admin@example.com',
		email_verified: true,
	});
	const input = `${header}.${payload}`;
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input));
	const token = `${input}.${Buffer.from(signature).toString('base64url')}`;

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
	try {
		const env = { GOOGLE_CLIENT_ID: 'google-client-id' };
		assert.equal(await verifyGoogleToken(token, env, 'expected-nonce'), 'admin@example.com');
		assert.equal(await verifyGoogleToken(token, env, 'wrong-nonce'), null);
		assert.equal(await verifyGoogleToken(token, { GOOGLE_CLIENT_ID: 'other-client' }, 'expected-nonce'), null);
		assert.equal(await verifyGoogleToken(`${input}.AAAA`, env, 'expected-nonce'), null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
