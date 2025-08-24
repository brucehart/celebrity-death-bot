import type { Env } from '../types.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { getTelegramChatIds } from './db.ts';
import { getConfig } from '../config.ts';

// Telegram HTML message helpers (TypeScript)
// - Escapes unsafe characters in text and attribute contexts
// - Truncates to Telegram's 4096 char limit without breaking <a> tag

export const MAX_TELEGRAM_LEN = 4096;

const CTRL_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function escapeHtmlText(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .replace(CTRL_REGEX, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .replace(CTRL_REGEX, '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildSafeUrl(wikiPath: string): string {
  try {
    const base = new URL('https://www.wikipedia.org');
    if (typeof wikiPath === 'string' && wikiPath.trim()) {
      if (wikiPath.startsWith('http')) return new URL(wikiPath).href;
      const path = wikiPath.startsWith('/') ? wikiPath : `/${wikiPath}`;
      return new URL(path, base).href;
    }
    return base.href;
  } catch {
    return 'https://www.wikipedia.org/';
  }
}

export function truncateTelegramHTML(html: string, maxLen: number = MAX_TELEGRAM_LEN): string {
  if (!html) return '';
  if (html.length <= maxLen) return html;

  const ellipsis = '…';
  let allowed = maxLen - ellipsis.length;
  if (allowed <= 0) return html.slice(0, maxLen);

  const anchorEnd = html.indexOf('</a>');
  if (anchorEnd !== -1 && allowed <= anchorEnd + 4) {
    return html.slice(0, anchorEnd + 4) + ellipsis;
  }

  let cut = allowed;
  const lastLt = html.lastIndexOf('<', allowed);
  const lastGt = html.lastIndexOf('>', allowed);
  if (lastLt > lastGt) {
    cut = lastLt - 1;
  }
  const ws = html.lastIndexOf(' ', cut);
  if (ws > 0 && (anchorEnd === -1 || ws > anchorEnd + 4)) {
    cut = ws;
  }
  if (cut < 0) cut = allowed;
  return html.slice(0, cut) + ellipsis;
}

type TelegramMessageInput = {
  name?: string | null;
  age?: string | number | null;
  description?: string | null;
  cause?: string | null;
  wiki_path?: string | null;
};

export function buildTelegramMessage({ name, age, description, cause, wiki_path }: TelegramMessageInput): string {
  const safeName = escapeHtmlText(name || '');
  const safeAge = typeof age === 'string' ? escapeHtmlText(age) : age != null ? escapeHtmlText(String(age)) : '';
  const safeDesc = escapeHtmlText(description || '');
  const causeRaw = (cause ?? '').toString();
  const isUnknown = causeRaw.trim().toLowerCase() === 'unknown';
  const safeCause = isUnknown ? '' : escapeHtmlText(causeRaw);
  const url = buildSafeUrl(wiki_path || '');
  const safeHref = escapeHtmlAttr(url);

  const parts: string[] = [];
  parts.push('🚨💀 ');
  parts.push(`<a href="${safeHref}">${safeName}</a>`);
  if (safeAge) parts.push(` (${safeAge})`);
  if (safeDesc) parts.push(` : ${safeDesc}`);
  if (safeCause) parts.push(` - ${safeCause}`);
  parts.push('💀🚨');

  const msg = parts.join('');
  return truncateTelegramHTML(msg, MAX_TELEGRAM_LEN);
}

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
