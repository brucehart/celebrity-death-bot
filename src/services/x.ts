import type { Env } from '../types.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { buildSafeUrl } from './telegram.ts';

// Lightweight OAuth 1.0a signer using Web Crypto (HMAC-SHA1) for Cloudflare Workers

const OAUTH_SIGNATURE_METHOD = 'HMAC-SHA1';
const OAUTH_VERSION = '1.0';
const LINK_WEIGHT = 23; // X t.co link weight
const TWEET_MAX = 280;

function hasAllXCreds(env: Env): env is Env & Required<Pick<Env, 'X_API_KEY' | 'X_API_SECRET' | 'X_ACCESS_TOKEN' | 'X_ACCESS_TOKEN_SECRET'>> {
  return !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_TOKEN_SECRET);
}

function toUint8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function base64FromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

function percentEncode(v: string): string {
  return encodeURIComponent(v)
    .replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildBaseString(method: string, url: URL, params: Record<string, string>): string {
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const pairs: Array<[string, string]> = [];
  // Include query params
  url.searchParams.forEach((value, key) => {
    pairs.push([key, value]);
  });
  // Include OAuth params (except signature)
  for (const [k, v] of Object.entries(params)) {
    if (k === 'oauth_signature') continue;
    pairs.push([k, v]);
  }
  // Percent-encode, sort, and join
  const encoded = pairs
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(encoded)].join('&');
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', toUint8(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, toUint8(message));
  return base64FromBytes(sig);
}

async function oauth1Header(method: string, urlStr: string, consumerKey: string, consumerSecret: string, token: string, tokenSecret: string): Promise<string> {
  const url = new URL(urlStr);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),
    oauth_signature_method: OAUTH_SIGNATURE_METHOD,
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: OAUTH_VERSION,
  };
  const baseString = buildBaseString(method, url, oauthParams);
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = await hmacSha1Base64(signingKey, baseString);
  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const header =
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(', ');
  return header;
}

// Build X post matching Telegram content, but with the Wikipedia link appended at the end.
type PostInput = { name?: string | null; age?: string | number | null; description?: string | null; cause?: string | null; wiki_path?: string | null };

export function buildXStatus({ name, age, description, cause, wiki_path }: PostInput): string {
  const safeName = (name ?? '').toString().trim();
  const safeAge = age == null || age === '' ? '' : ` (${String(age).trim()})`;
  const safeDesc = (description ?? '').toString().trim();
  const causeRaw = (cause ?? '').toString().trim();
  const hasCause = causeRaw && causeRaw.toLowerCase() !== 'unknown';
  const url = buildSafeUrl(wiki_path || '');

  const bodyParts: string[] = [];
  bodyParts.push('🚨💀');
  bodyParts.push(safeName);
  if (safeAge) bodyParts.push(safeAge);
  if (safeDesc) bodyParts.push(` : ${safeDesc}`);
  if (hasCause) bodyParts.push(` - ${causeRaw}`);
  bodyParts.push(' 💀🚨');
  const body = bodyParts.join('');

  // Respect 280-char limit using t.co link weighting.
  const maxBody = TWEET_MAX - 1 - LINK_WEIGHT; // newline + link
  const truncatedBody = truncateToCodepoints(body, maxBody);
  return `${truncatedBody}\n${url}`;
}

function truncateToCodepoints(s: string, max: number): string {
  if (s.length <= max) return s;
  const cps = Array.from(s); // code points
  if (cps.length <= max) return cps.join('');
  return cps.slice(0, Math.max(0, max - 1)).join('') + '…';
}

export async function postToXIfConfigured(env: Env, text: string): Promise<void> {
  if (!hasAllXCreds(env)) return; // silently skip when not configured
  const url = 'https://api.twitter.com/2/tweets';
  try {
    const auth = await oauth1Header('POST', url, env.X_API_KEY!, env.X_API_SECRET!, env.X_ACCESS_TOKEN!, env.X_ACCESS_TOKEN_SECRET!);
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      },
      { retries: 1, timeoutMs: 15000 }
    );
    if (!res.ok) {
      const t = await res.text();
      console.warn('X post failed', res.status, t.slice(0, 500));
    }
  } catch (err) {
    console.warn('X post error', (err as any)?.message || String(err));
  }
}
