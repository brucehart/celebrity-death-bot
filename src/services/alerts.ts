import type { Env } from '../types.ts';
import type { JobResult } from './job.ts';
import { getJobFreshness } from './db.ts';
import { notifyTelegramSingle } from './telegram.ts';

const ALERT_KEY_PREFIX = 'job-alert:';
const DEFAULT_MIN_SCANNED = 1;
const DEFAULT_STALE_HOURS = 24;
const DEFAULT_COOLDOWN_MINUTES = 360;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function alertChatIds(env: Env): string[] {
	const raw = [env.TELEGRAM_ALERT_CHAT_ID, env.TELEGRAM_CHAT_IDS].filter(Boolean).join(',');
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const part of raw.split(/[,;\s]+/)) {
		const id = part.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}

function parseSqliteUtc(value: string | null): number | null {
	if (!value) return null;
	const ts = Date.parse(`${value.replace(' ', 'T')}Z`);
	return Number.isFinite(ts) ? ts : null;
}

async function sendAlert(env: Env, key: string, text: string): Promise<void> {
	const ids = alertChatIds(env);
	if (!ids.length) {
		console.warn('Job alert skipped: TELEGRAM_ALERT_CHAT_ID is not configured', { key });
		return;
	}

	const cooldownMinutes = parsePositiveInt(env.JOB_ALERT_COOLDOWN_MINUTES, DEFAULT_COOLDOWN_MINUTES);
	const cooldownKey = `${ALERT_KEY_PREFIX}${key}`;
	const existing = await env.celebrity_death_bot_kv.get(cooldownKey, 'text');
	if (existing) return;

	let sent = 0;
	for (const id of ids) {
		await notifyTelegramSingle(env, id, text);
		sent++;
	}

	if (sent > 0) {
		await env.celebrity_death_bot_kv.put(cooldownKey, String(Date.now()), { expirationTtl: cooldownMinutes * 60 });
	}
}

async function trySendAlert(env: Env, key: string, text: string): Promise<void> {
	try {
		await sendAlert(env, key, text);
	} catch (alertErr) {
		console.error('Job alert failed', { key, error: formatError(alertErr) });
	}
}

export async function alertOnJobError(env: Env, err: unknown): Promise<void> {
	await trySendAlert(
		env,
		'error',
		['Celebrity Death Bot job failed.', `Time: ${new Date().toISOString()}`, `Error: ${formatError(err)}`].join('\n'),
	);
}

export async function alertOnJobResult(env: Env, result: JobResult): Promise<void> {
	const minScanned = parsePositiveInt(env.JOB_ALERT_MIN_SCANNED, DEFAULT_MIN_SCANNED);
	if (result.scanned < minScanned) {
		await trySendAlert(
			env,
			'low-scan',
			[
				'Celebrity Death Bot job parsed suspiciously few rows.',
				`Time: ${new Date().toISOString()}`,
				`Scanned: ${result.scanned}`,
				`Inserted: ${result.inserted}`,
				`Retried: ${result.retried}`,
				`Months: ${result.months.map((m) => `${m.year}-${String(m.month).padStart(2, '0')} scanned=${m.scanned} new=${m.newPaths}`).join(', ')}`,
			].join('\n'),
		);
	}

	const staleHours = parsePositiveInt(env.JOB_ALERT_STALE_HOURS, DEFAULT_STALE_HOURS);
	let freshness;
	try {
		freshness = await getJobFreshness(env);
	} catch (err) {
		await trySendAlert(
			env,
			'freshness-check-error',
			[
				'Celebrity Death Bot completed a job, but the post-run freshness check failed.',
				`Time: ${new Date().toISOString()}`,
				`Error: ${formatError(err)}`,
			].join('\n'),
		);
		return;
	}
	const latestCreatedMs = parseSqliteUtc(freshness.latest_created_at);
	if (!latestCreatedMs) return;

	const staleMs = staleHours * 60 * 60 * 1000;
	const ageMs = Date.now() - latestCreatedMs;
	if (ageMs > staleMs) {
		await trySendAlert(
			env,
			'stale-created-at',
			[
				'Celebrity Death Bot has not inserted a new death row recently.',
				`Time: ${new Date().toISOString()}`,
				`Latest created_at: ${freshness.latest_created_at}`,
				`Latest llm_date_time: ${freshness.latest_llm_date_time || 'none'}`,
				`Rows: ${freshness.count}`,
				`Threshold hours: ${staleHours}`,
			].join('\n'),
		);
	}
}
