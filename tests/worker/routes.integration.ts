import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from '../../src/services/db.ts';

describe('Worker security boundaries', () => {
	it('serves health with the global security headers', async () => {
		const response = await SELF.fetch('https://celebritydeathbot.com/health');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
		expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
	});

	it('fails closed for an unconfigured provider webhook', async () => {
		const response = await SELF.fetch('https://celebritydeathbot.com/replicate/callback', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'prediction-id', status: 'succeeded' }),
		});
		expect(response.status).toBe(503);
		expect(await response.text()).toBe('Webhook is not configured');
	});

	it('does not expose X OAuth controls to unauthenticated callers', async () => {
		for (const path of ['/x/oauth/start', '/x/oauth/status']) {
			const response = await SELF.fetch(`https://celebritydeathbot.com${path}`, { redirect: 'manual' });
			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toMatch(/^\/login\?return_to=/);
		}
	});
});

describe('Webhook replay ledger', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM processed_webhooks').run();
	});

	it('deduplicates active and completed deliveries', async () => {
		const claims = await Promise.all([
			claimWebhookEvent(env, 'replicate', 'delivery-1'),
			claimWebhookEvent(env, 'replicate', 'delivery-1'),
			claimWebhookEvent(env, 'replicate', 'delivery-1'),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);

		await completeWebhookEvent(env, 'replicate', 'delivery-1');
		expect(await claimWebhookEvent(env, 'replicate', 'delivery-1')).toBe(false);
	});

	it('allows a failed delivery to be claimed again', async () => {
		expect(await claimWebhookEvent(env, 'openai', 'delivery-2')).toBe(true);
		await failWebhookEvent(env, 'openai', 'delivery-2', new Error('temporary failure'));

		const retryClaims = await Promise.all([claimWebhookEvent(env, 'openai', 'delivery-2'), claimWebhookEvent(env, 'openai', 'delivery-2')]);
		expect(retryClaims.filter(Boolean)).toHaveLength(1);
		expect(await claimWebhookEvent(env, 'openai', 'delivery-2')).toBe(false);

		const row = await env.DB.prepare(
			`SELECT status, error, completed_at FROM processed_webhooks
			  WHERE provider = 'openai' AND event_id = 'delivery-2'`,
		).first<{ status: string; error: string | null; completed_at: string | null }>();
		expect(row).toEqual({ status: 'processing', error: null, completed_at: null });
	});

	it('allows a stale processing delivery to be claimed again', async () => {
		expect(await claimWebhookEvent(env, 'telegram', 'delivery-3')).toBe(true);
		await env.DB.prepare(
			`UPDATE processed_webhooks
			    SET created_at = datetime('now', '-16 minutes')
			  WHERE provider = 'telegram' AND event_id = 'delivery-3'`,
		).run();

		expect(await claimWebhookEvent(env, 'telegram', 'delivery-3')).toBe(true);
		expect(await claimWebhookEvent(env, 'telegram', 'delivery-3')).toBe(false);
	});
});
