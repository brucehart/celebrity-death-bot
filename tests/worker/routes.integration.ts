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
		const claimTokens = await Promise.all([
			claimWebhookEvent(env, 'replicate', 'delivery-1'),
			claimWebhookEvent(env, 'replicate', 'delivery-1'),
			claimWebhookEvent(env, 'replicate', 'delivery-1'),
		]);
		expect(claimTokens.filter(Boolean)).toHaveLength(1);
		const claimToken = claimTokens.find(Boolean);

		await completeWebhookEvent(env, 'replicate', 'delivery-1', claimToken!);
		await completeWebhookEvent(env, 'replicate', 'delivery-1', claimToken!);
		await failWebhookEvent(env, 'replicate', 'delivery-1', claimToken!, new Error('post-effect failure'));
		expect(await claimWebhookEvent(env, 'replicate', 'delivery-1')).toBeNull();
		const completed = await env.DB.prepare(
			`SELECT status, error FROM processed_webhooks
			  WHERE provider = 'replicate' AND event_id = 'delivery-1'`,
		).first<{ status: string; error: string | null }>();
		expect(completed).toEqual({ status: 'completed', error: null });
	});

	it('allows a failed delivery to be claimed again', async () => {
		const firstClaim = await claimWebhookEvent(env, 'openai', 'delivery-2');
		expect(firstClaim).toBeTruthy();
		await failWebhookEvent(env, 'openai', 'delivery-2', firstClaim!, new Error('temporary failure'));

		const retryClaims = await Promise.all([claimWebhookEvent(env, 'openai', 'delivery-2'), claimWebhookEvent(env, 'openai', 'delivery-2')]);
		expect(retryClaims.filter(Boolean)).toHaveLength(1);
		expect(await claimWebhookEvent(env, 'openai', 'delivery-2')).toBeNull();

		const row = await env.DB.prepare(
			`SELECT status, error, completed_at FROM processed_webhooks
			  WHERE provider = 'openai' AND event_id = 'delivery-2'`,
		).first<{ status: string; error: string | null; completed_at: string | null }>();
		expect(row).toEqual({ status: 'processing', error: null, completed_at: null });
	});

	it('allows a stale processing delivery to be claimed again', async () => {
		const staleClaim = await claimWebhookEvent(env, 'telegram', 'delivery-3');
		expect(staleClaim).toBeTruthy();
		await env.DB.prepare(
			`UPDATE processed_webhooks
			    SET created_at = datetime('now', '-16 minutes')
			  WHERE provider = 'telegram' AND event_id = 'delivery-3'`,
		).run();

		const reclaimedClaim = await claimWebhookEvent(env, 'telegram', 'delivery-3');
		expect(reclaimedClaim).toBeTruthy();
		expect(reclaimedClaim).not.toBe(staleClaim);
		await expect(completeWebhookEvent(env, 'telegram', 'delivery-3', staleClaim!)).rejects.toThrow('claim lost');
		await completeWebhookEvent(env, 'telegram', 'delivery-3', reclaimedClaim!);
		expect(await claimWebhookEvent(env, 'telegram', 'delivery-3')).toBeNull();
	});
});
