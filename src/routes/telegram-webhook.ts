import type { Env } from '../types.ts';
import {
	claimWebhookEvent,
	completeWebhookEvent,
	failWebhookEvent,
	getSubscriberStatus,
	subscribeTelegram,
	unsubscribeTelegram,
} from '../services/db.ts';
import { notifyTelegramSingle } from '../services/telegram.ts';
import { BodyTooLargeError, MAX_WEBHOOK_BODY_BYTES, readRequestTextBounded } from '../utils/request.ts';
import { secureCompareStrings } from '../utils/security.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function telegramWebhook(request: Request, env: Env): Promise<Response> {
	if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response('Webhook is not configured', { status: 503 });
	const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
	if (!header || !(await secureCompareStrings(header, env.TELEGRAM_WEBHOOK_SECRET))) return new Response('Unauthorized', { status: 401 });

	let update: unknown;
	try {
		update = JSON.parse(await readRequestTextBounded(request, MAX_WEBHOOK_BODY_BYTES));
	} catch (error) {
		return new Response(error instanceof BodyTooLargeError ? 'Request too large' : 'Invalid JSON', {
			status: error instanceof BodyTooLargeError ? 413 : 400,
		});
	}
	if (!isRecord(update)) return new Response('Invalid payload', { status: 400 });
	const updateId = typeof update.update_id === 'number' && Number.isSafeInteger(update.update_id) ? String(update.update_id) : '';
	if (!updateId) return new Response('Missing update id', { status: 400 });
	try {
		if (!(await claimWebhookEvent(env, 'telegram', updateId))) return Response.json({ ok: true, duplicate: true });
	} catch (error) {
		console.error('Telegram webhook claim failed', error instanceof Error ? error.message : String(error));
		return new Response('Webhook processing failed', { status: 500 });
	}

	try {
		const message = isRecord(update.message) ? update.message : null;
		const chat = message && isRecord(message.chat) ? message.chat : null;
		const chatIdValue = chat?.id;
		const chatId = typeof chatIdValue === 'string' || typeof chatIdValue === 'number' ? String(chatIdValue) : '';
		const text = message && typeof message.text === 'string' ? message.text.trim() : '';
		if (!chatId || !text) {
			await completeWebhookEvent(env, 'telegram', updateId);
			return Response.json({ ok: true, ignored: true });
		}

		const command = text.split(/\s+/)[0].toLowerCase();
		if (command === '/start' || command === '/subscribe' || command === '/join') {
			const current = await getSubscriberStatus(env, chatId);
			await subscribeTelegram(env, chatId);
			await notifyTelegramSingle(env, chatId, current === 1 ? 'You are already subscribed.' : 'Subscribed. You will receive alerts here.');
		} else if (command === '/stop' || command === '/unsubscribe' || command === '/leave') {
			const current = await getSubscriberStatus(env, chatId);
			await unsubscribeTelegram(env, chatId);
			await notifyTelegramSingle(
				env,
				chatId,
				current === 0 || current === null ? 'You are already unsubscribed.' : 'Unsubscribed. You will no longer receive alerts.',
			);
		} else if (command === '/status') {
			const status = await getSubscriberStatus(env, chatId);
			await notifyTelegramSingle(env, chatId, status === 1 ? 'Status: subscribed.' : 'Status: not subscribed.');
		} else if (command === '/commands' || command === '/help') {
			await notifyTelegramSingle(
				env,
				chatId,
				[
					'Available commands:',
					'/subscribe – Subscribe to alerts',
					'/unsubscribe – Unsubscribe from alerts',
					'/status – Show current subscription status',
					'/help – Show this list',
				].join('\n'),
			);
		} else {
			await notifyTelegramSingle(env, chatId, 'Unknown command. Try /subscribe, /unsubscribe, /status, or /commands.');
		}

		await completeWebhookEvent(env, 'telegram', updateId);
		return Response.json({ ok: true });
	} catch (error) {
		console.error('Telegram webhook processing failed', error instanceof Error ? error.message : String(error));
		try {
			await failWebhookEvent(env, 'telegram', updateId, error);
		} catch (recordError) {
			console.error('Telegram webhook failure recording failed', recordError instanceof Error ? recordError.message : String(recordError));
		}
		return new Response('Webhook processing failed', { status: 500 });
	}
}
