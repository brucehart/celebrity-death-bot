import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/types.ts';
import { getActiveOpenAICandidatePaths, getOpenAIBackgroundResponse, recordOpenAIBackgroundResponse } from '../../src/services/db.ts';
import { pollOpenAIBackgroundResponses, processOpenAIResponseEvent } from '../../src/services/openai-background.ts';
import { runPending } from '../../src/services/job.ts';

const testEnv = Object.assign(env, {
	TELEGRAM_BOT_TOKEN: '',
	MANUAL_RUN_SECRET: 'test-manual-secret',
	GOOGLE_CLIENT_ID: 'test-google-client',
	GOOGLE_CLIENT_SECRET: 'test-google-secret',
	SESSION_HMAC_KEY: 'test-session-key',
}) satisfies Env;

const candidatePath = 'Polling_Test_Person';
const responseId = 'resp_polling_test';

function completedResponse() {
	return {
		id: responseId,
		status: 'completed',
		outputText: JSON.stringify({
			selected: [],
			rejected: [{ wiki_path: candidatePath, reason: 'Not within the configured criteria' }],
		}),
		raw: {
			id: responseId,
			status: 'completed',
			metadata: { candidates: JSON.stringify([candidatePath]) },
		},
	};
}

function failedResponse() {
	return {
		id: responseId,
		status: 'failed',
		outputText: '',
		raw: {
			id: responseId,
			status: 'failed',
			metadata: { candidates: JSON.stringify([candidatePath]) },
			error: {
				code: 'insufficient_quota',
				type: 'insufficient_quota',
				message: 'Credit balance exhausted.\nAdd credits and retry.',
			},
		},
	};
}

describe('OpenAI background response polling', () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM openai_background_responses'),
			env.DB.prepare("DELETE FROM processed_webhooks WHERE provider = 'openai'"),
			env.DB.prepare('DELETE FROM deaths'),
		]);
		await env.DB.prepare(
			`INSERT INTO deaths(name, wiki_path, link_type, age, description, cause, llm_result)
			 VALUES('Polling Test Person', ?1, 'active', 80, 'Test person', NULL, 'pending')`,
		)
			.bind(candidatePath)
			.run();
	});

	it('recovers a completed response and shares webhook idempotency', async () => {
		await recordOpenAIBackgroundResponse(testEnv, responseId, [candidatePath], 'queued');

		const polling = await pollOpenAIBackgroundResponses(testEnv, {
			retrieve: async () => completedResponse(),
		});

		expect(polling).toEqual({ checked: 1, active: 0, completed: 1, failed: 0, errors: 0 });
		const death = await env.DB.prepare('SELECT llm_result, llm_rejection_reason FROM deaths WHERE wiki_path = ?1')
			.bind(candidatePath)
			.first<{ llm_result: string; llm_rejection_reason: string | null }>();
		expect(death).toEqual({ llm_result: 'no', llm_rejection_reason: 'Not within the configured criteria' });

		const tracked = await getOpenAIBackgroundResponse(testEnv, responseId);
		expect(tracked?.status).toBe('completed');
		expect(tracked?.completed_at).toBeTruthy();
		const ledger = await env.DB.prepare(
			`SELECT status FROM processed_webhooks
			  WHERE provider = 'openai' AND event_id = ?1`,
		)
			.bind(`${responseId}:response.completed`)
			.first<{ status: string }>();
		expect(ledger?.status).toBe('completed');

		const lateWebhook = await processOpenAIResponseEvent(testEnv, 'response.completed', responseId, completedResponse());
		expect(lateWebhook).toEqual({ ok: true, duplicate: true });
	});

	it('keeps an in-progress response active and prevents duplicate submission', async () => {
		await recordOpenAIBackgroundResponse(testEnv, responseId, [candidatePath], 'queued');

		const polling = await pollOpenAIBackgroundResponses(testEnv, {
			retrieve: async () => ({ id: responseId, status: 'in_progress', outputText: '', raw: { id: responseId, status: 'in_progress' } }),
		});

		expect(polling).toEqual({ checked: 1, active: 1, completed: 0, failed: 0, errors: 0 });
		expect(await getActiveOpenAICandidatePaths(testEnv)).toEqual([candidatePath]);
		const tracked = await getOpenAIBackgroundResponse(testEnv, responseId);
		expect(tracked?.status).toBe('in_progress');
		expect(tracked?.last_checked_at).toBeTruthy();

		const retry = await runPending(testEnv, { provider: 'openai', limit: 20 });
		expect(retry.queued).toBe(0);
	});

	it('persists and logs a failed response error without letting duplicate delivery erase it', async () => {
		await recordOpenAIBackgroundResponse(testEnv, responseId, [candidatePath], 'queued');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const polling = await pollOpenAIBackgroundResponses(testEnv, {
				retrieve: async () => failedResponse(),
			});

			expect(polling).toEqual({ checked: 1, active: 0, completed: 0, failed: 1, errors: 0 });
			const expectedError = 'code=insufficient_quota; type=insufficient_quota; message=Credit balance exhausted. Add credits and retry.';
			const tracked = await getOpenAIBackgroundResponse(testEnv, responseId);
			expect(tracked?.status).toBe('failed');
			expect(tracked?.completed_at).toBeTruthy();
			expect(tracked?.error).toBe(expectedError);
			const death = await env.DB.prepare('SELECT llm_result FROM deaths WHERE wiki_path = ?1')
				.bind(candidatePath)
				.first<{ llm_result: string }>();
			expect(death?.llm_result).toBe('error');
			expect(consoleError).toHaveBeenCalledWith('OpenAI background response failed', {
				responseId,
				status: 'response.failed',
				error: expectedError,
			});

			const lateWebhook = await processOpenAIResponseEvent(testEnv, 'response.failed', responseId, failedResponse());
			expect(lateWebhook).toEqual({ ok: true, duplicate: true });
			expect((await getOpenAIBackgroundResponse(testEnv, responseId))?.error).toBe(expectedError);
		} finally {
			consoleError.mockRestore();
		}
	});
});
