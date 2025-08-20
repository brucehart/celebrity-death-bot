import type { Env } from '../types';
import { getSubscriberStatus, subscribeTelegram, unsubscribeTelegram } from '../services/db';
import { notifyTelegramSingle } from '../services/telegram';

export async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!header || header !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let update: any;
  try {
    update = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = (message?.text ?? '').trim();
  if (!chatId || !text) {
    return Response.json({ ok: true, ignored: true });
  }

  const cmd = text.split(/\s+/)[0].toLowerCase();
  const isSub = cmd === '/start' || cmd === '/subscribe' || cmd == '/join';
  const isUnsub = cmd === '/stop' || cmd === '/unsubscribe' || cmd == '/leave';
  const isStatus = cmd === '/status';
  const isCommands = cmd === '/commands' || cmd == '/help';

  try {
    if (isSub) {
      const current = await getSubscriberStatus(env, String(chatId));
      await subscribeTelegram(env, String(chatId));
      await notifyTelegramSingle(env, chatId, current === 1 ? 'You are already subscribed.' : 'Subscribed. You will receive alerts here.');
      return Response.json({ ok: true });
    } else if (isUnsub) {
      const current = await getSubscriberStatus(env, String(chatId));
      await unsubscribeTelegram(env, String(chatId));
      await notifyTelegramSingle(env, chatId, current === 0 || current === null ? 'You are already unsubscribed.' : 'Unsubscribed. You will no longer receive alerts.');
      return Response.json({ ok: true });
    } else if (isStatus) {
      const s = await getSubscriberStatus(env, String(chatId));
      const msg = s === 1 ? 'Status: subscribed.' : 'Status: not subscribed.';
      await notifyTelegramSingle(env, chatId, msg);
      return Response.json({ ok: true });
    } else if (isCommands) {
      const help = [
        'Available commands:',
        '/subscribe – Subscribe to alerts',
        '/unsubscribe – Unsubscribe from alerts',
        '/status – Show current subscription status',
        '/help – Show this list',
      ].join('\n');
      await notifyTelegramSingle(env, chatId, help);
      return Response.json({ ok: true });
    } else {
      await notifyTelegramSingle(env, chatId, 'Unknown command. Try /subscribe, /unsubscribe, /status, or /commands.');
      return Response.json({ ok: true });
    }
  } catch (e: any) {
    console.error('Telegram webhook error', e);
    try {
      await notifyTelegramSingle(env, chatId, 'Sorry, something went wrong. Please try again.');
    } catch {}
    return new Response('Server error', { status: 500 });
  }
}
