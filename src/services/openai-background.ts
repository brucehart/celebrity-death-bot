import type { Env } from '../types.ts';
import { applyLlmOutput } from './llm-output.ts';
import { retrieveOpenAIResponse } from './openai.ts';
import {
	claimWebhookEvent,
	completeOpenAIBackgroundResponse,
	completeWebhookEvent,
	failWebhookEvent,
	getOpenAIBackgroundResponse,
	getWebhookEventStatus,
	listPendingOpenAIBackgroundResponses,
	markDeathsAsError,
	parseOpenAICandidatePaths,
	pruneOpenAIBackgroundResponses,
	updateOpenAIBackgroundResponseCheck,
} from './db.ts';

export type OpenAIResponseEventType = 'response.completed' | 'response.failed' | 'response.cancelled';
type RetrievedOpenAIResponse = Awaited<ReturnType<typeof retrieveOpenAIResponse>>;
type RetrieveOpenAIResponse = (env: Env, responseId: string) => Promise<RetrievedOpenAIResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedErrorField(value: unknown): string | null {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	return String(value).replace(/\s+/g, ' ').trim() || null;
}

export function formatOpenAIResponseError(raw: unknown): string | null {
	if (!isRecord(raw)) return null;
	const responseError = raw.error;
	if (typeof responseError === 'string') return normalizedErrorField(responseError)?.slice(0, 500) || null;
	if (!isRecord(responseError)) return null;

	const fields = [
		['code', normalizedErrorField(responseError.code)],
		['type', normalizedErrorField(responseError.type)],
		['message', normalizedErrorField(responseError.message)],
	] as const;
	const parts: string[] = [];
	for (const [name, value] of fields) {
		if (value !== null) parts.push(`${name}=${value}`);
	}
	const message = parts.join('; ');
	return message.slice(0, 500) || null;
}

export function extractOpenAICandidatesFromMetadata(metadata: unknown): string[] {
	if (!isRecord(metadata)) return [];
	const raw = metadata.candidates;
	if (Array.isArray(raw)) {
		return raw
			.map((value) => String(value || '').trim())
			.filter((path) => path.length > 0 && path.length <= 512)
			.slice(0, 400);
	}
	if (typeof raw !== 'string') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed
				.map((value) => String(value || '').trim())
				.filter((path) => path.length > 0 && path.length <= 512)
				.slice(0, 400);
		}
	} catch {}
	return raw
		.split(',')
		.map((value) => value.trim())
		.filter((path) => path.length > 0 && path.length <= 512)
		.slice(0, 400);
}

async function getTrustedCandidatePaths(env: Env, responseId: string, response: RetrievedOpenAIResponse): Promise<string[]> {
	const tracked = await getOpenAIBackgroundResponse(env, responseId);
	const storedCandidates = tracked ? parseOpenAICandidatePaths(tracked.candidate_paths_json) : [];
	if (storedCandidates.length) return storedCandidates;
	const metadata = isRecord(response.raw) ? response.raw.metadata : null;
	return extractOpenAICandidatesFromMetadata(metadata);
}

export async function processOpenAIResponseEvent(
	env: Env,
	eventType: OpenAIResponseEventType,
	responseId: string,
	retrievedResponse?: RetrievedOpenAIResponse,
) {
	const eventId = `${responseId}:${eventType}`;
	const responseError = retrievedResponse ? formatOpenAIResponseError(retrievedResponse.raw) : null;
	const claimed = await claimWebhookEvent(env, 'openai', eventId);
	if (!claimed) {
		const ledgerStatus = await getWebhookEventStatus(env, 'openai', eventId);
		if (ledgerStatus === 'completed') {
			await completeOpenAIBackgroundResponse(env, responseId, eventType.slice('response.'.length), responseError);
		}
		return { ok: true, duplicate: true } as const;
	}

	try {
		const response = retrievedResponse || (await retrieveOpenAIResponse(env, responseId));
		const candidatePaths = await getTrustedCandidatePaths(env, responseId, response);

		if (eventType !== 'response.completed') {
			const terminalError =
				formatOpenAIResponseError(response.raw) ||
				(eventType === 'response.failed' ? 'OpenAI response failed without provider error details' : null);
			if (eventType === 'response.failed') {
				console.error('OpenAI background response failed', {
					responseId,
					status: eventType,
					error: terminalError,
				});
			}
			if (candidatePaths.length) await markDeathsAsError(env, candidatePaths);
			await completeWebhookEvent(env, 'openai', eventId, claimed);
			await completeOpenAIBackgroundResponse(env, responseId, eventType.slice('response.'.length), terminalError);
			return { ok: true, status: eventType, errored: candidatePaths.length } as const;
		}

		const result = await applyLlmOutput(env, response.outputText || '', candidatePaths, {
			beforeSideEffects: () => completeWebhookEvent(env, 'openai', eventId, claimed),
		});
		await completeWebhookEvent(env, 'openai', eventId, claimed);
		await completeOpenAIBackgroundResponse(env, responseId, 'completed');
		return { ok: true, response_id: responseId, ...result } as const;
	} catch (error) {
		try {
			await failWebhookEvent(env, 'openai', eventId, claimed, error);
		} catch (ledgerError) {
			console.error('OpenAI response ledger failure recording failed', {
				responseId,
				error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
			});
		}
		try {
			await updateOpenAIBackgroundResponseCheck(env, responseId, 'processing_error', error);
		} catch (recordError) {
			console.error('OpenAI background response failure recording failed', {
				responseId,
				error: recordError instanceof Error ? recordError.message : String(recordError),
			});
		}
		throw error;
	}
}

function eventTypeForTerminalStatus(status: string): OpenAIResponseEventType {
	if (status === 'completed') return 'response.completed';
	if (status === 'cancelled') return 'response.cancelled';
	return 'response.failed';
}

export async function pollOpenAIBackgroundResponses(env: Env, options: { limit?: number; retrieve?: RetrieveOpenAIResponse } = {}) {
	if (!env.OPENAI_API_KEY && !options.retrieve) {
		return { checked: 0, active: 0, completed: 0, failed: 0, errors: 0, skipped: 'OpenAI API key is not configured' } as const;
	}

	try {
		await pruneOpenAIBackgroundResponses(env);
	} catch (error) {
		console.warn('OpenAI background response cleanup failed', error instanceof Error ? error.message : String(error));
	}

	const pending = await listPendingOpenAIBackgroundResponses(env, options.limit);
	const retrieve = options.retrieve || retrieveOpenAIResponse;
	let checked = 0;
	let active = 0;
	let completed = 0;
	let failed = 0;
	let errors = 0;

	for (const tracked of pending) {
		checked++;
		try {
			const response = await retrieve(env, tracked.response_id);
			const status =
				String(response.status || 'unknown')
					.trim()
					.toLowerCase() || 'unknown';
			if (status === 'queued' || status === 'in_progress') {
				await updateOpenAIBackgroundResponseCheck(env, tracked.response_id, status);
				active++;
				continue;
			}

			const eventType = eventTypeForTerminalStatus(status);
			const result = await processOpenAIResponseEvent(env, eventType, tracked.response_id, response);
			if (eventType === 'response.completed') completed++;
			else failed++;
			console.log('OpenAI background response recovered by polling', {
				responseId: tracked.response_id,
				status,
				duplicate: 'duplicate' in result && result.duplicate === true,
			});
		} catch (error) {
			errors++;
			try {
				await updateOpenAIBackgroundResponseCheck(env, tracked.response_id, tracked.status, error);
			} catch (recordError) {
				console.error('OpenAI polling error recording failed', {
					responseId: tracked.response_id,
					error: recordError instanceof Error ? recordError.message : String(recordError),
				});
			}
			console.error('OpenAI background response polling failed', {
				responseId: tracked.response_id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { checked, active, completed, failed, errors } as const;
}
