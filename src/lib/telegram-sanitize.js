// Telegram HTML message helpers
// - Escapes unsafe characters in text and attribute contexts
// - Truncates to Telegram's 4096 char limit without breaking <a> tag

export const MAX_TELEGRAM_LEN = 4096;

const CTRL_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function escapeHtmlText(s) {
  if (s == null) return '';
  return String(s)
    .replace(CTRL_REGEX, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(s) {
  if (s == null) return '';
  return String(s)
    .replace(CTRL_REGEX, '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildSafeUrl(wikiPath) {
  try {
    // Ensure we stick to wikipedia.org and properly resolve/encode the path
    const base = new URL('https://www.wikipedia.org');
    // Accept absolute paths or full URLs; fallback to base
    if (typeof wikiPath === 'string' && wikiPath.trim()) {
      if (wikiPath.startsWith('http')) return new URL(wikiPath).href;
      if (!wikiPath.startsWith('/')) wikiPath = '/' + wikiPath;
      return new URL(wikiPath, base).href;
    }
    return base.href;
  } catch {
    return 'https://www.wikipedia.org/';
  }
}

export function truncateTelegramHTML(html, maxLen = MAX_TELEGRAM_LEN) {
  if (!html) return '';
  if (html.length <= maxLen) return html;

  const ellipsis = '…';
  let allowed = maxLen - ellipsis.length;
  if (allowed <= 0) return html.slice(0, maxLen);

  const anchorEnd = html.indexOf('</a>');
  if (anchorEnd !== -1 && allowed <= anchorEnd + 4) {
    return html.slice(0, anchorEnd + 4) + ellipsis;
  }

  // Try to avoid cutting inside a tag or entity
  let cut = allowed;
  const lastLt = html.lastIndexOf('<', allowed);
  const lastGt = html.lastIndexOf('>', allowed);
  if (lastLt > lastGt) {
    // We are inside a tag; back up before '<'
    cut = lastLt - 1;
  }
  // Prefer cutting at whitespace
  const ws = html.lastIndexOf(' ', cut);
  if (ws > 0 && (anchorEnd === -1 || ws > anchorEnd + 4)) {
    cut = ws;
  }
  if (cut < 0) cut = allowed;
  return html.slice(0, cut) + ellipsis;
}

export function buildTelegramMessage({ name, age, description, cause, wiki_path }) {
  const safeName = escapeHtmlText(name || '');
  const safeAge = typeof age === 'string' ? escapeHtmlText(age) : (age != null ? escapeHtmlText(String(age)) : '');
  const safeDesc = escapeHtmlText(description || '');
  const safeCause = escapeHtmlText(cause || '');
  const url = buildSafeUrl(wiki_path);
  const safeHref = escapeHtmlAttr(url);

  let parts = [];
  parts.push('🚨💀');
  parts.push(`<a href="${safeHref}">${safeName}</a>`);
  if (safeAge) parts.push(` (${safeAge})`);
  if (safeDesc) parts.push(` : ${safeDesc}`);
  if (safeCause) parts.push(` - ${safeCause}`);
  parts.push('💀🚨');

  const msg = parts.join('');
  return truncateTelegramHTML(msg, MAX_TELEGRAM_LEN);
}

