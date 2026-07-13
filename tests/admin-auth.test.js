import test from 'node:test';
import assert from 'node:assert/strict';

import { signSession, verifySession } from '../src/session.ts';
import { verifyCsrfRequest } from '../src/auth.ts';

const env = {
	SESSION_HMAC_KEY: 'test-only-session-key-that-is-long-enough',
	BASE_URL: 'https://example.com',
};

test('sessions carry unique server-authenticated CSRF and session identifiers', async () => {
	const first = await verifySession(await signSession('admin@example.com', env), env);
	const second = await verifySession(await signSession('admin@example.com', env), env);
	assert.equal(first.email, 'admin@example.com');
	assert.notEqual(first.sessionId, second.sessionId);
	assert.notEqual(first.csrfToken, second.csrfToken);
});

test('tampered sessions are rejected', async () => {
	const token = await signSession('admin@example.com', env);
	const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
	assert.equal(await verifySession(tampered, env), null);
});

test('CSRF requires both the exact token and canonical same origin', async () => {
	const auth = await verifySession(await signSession('admin@example.com', env), env);
	const good = new Request('https://example.com/llm-debug', { method: 'POST', headers: { Origin: 'https://example.com' } });
	const crossSite = new Request('https://example.com/llm-debug', { method: 'POST', headers: { Origin: 'https://attacker.example' } });
	assert.equal(await verifyCsrfRequest(good, env, auth, auth.csrfToken), true);
	assert.equal(await verifyCsrfRequest(good, env, auth, 'wrong'), false);
	assert.equal(await verifyCsrfRequest(crossSite, env, auth, auth.csrfToken), false);
});
