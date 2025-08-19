import type { Env } from '../types';
import { fetchWithRetry } from '../utils/fetch';
import { getTelegramChatIds } from './db';
import { getConfig } from '../config';
import { buildTelegramMessage, truncateTelegramHTML, escapeHtmlText } from '../lib/telegram-sanitize.js';

export { buildTelegramMessage };

export async function notifyTelegram(env: Env, text: string) {
  const ids = await getTelegramChatIds(env);
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const cfg = getConfig(env);
  for (const chat_id of ids) {
    const bounded = truncateTelegramHTML(text);
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text: bounded, parse_mode: 'HTML' }),
      },
      { retries: 1, timeoutMs: cfg.limits.fetchTimeoutMs }
    );
    if (!res.ok) {
      console.warn('Telegram send failed', chat_id, await res.text());
    }
  }
}

export async function notifyTelegramSingle(env: Env, chat_id: string | number, text: string) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const cfg = getConfig(env);
  const safe = truncateTelegramHTML(escapeHtmlText(text));
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: safe, parse_mode: 'HTML' }),
    },
    { retries: 1, timeoutMs: cfg.limits.fetchTimeoutMs }
  );
  if (!res.ok) {
    console.warn('Telegram reply failed', chat_id, await res.text());
  }
}

