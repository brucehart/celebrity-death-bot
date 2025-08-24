import type { Env } from '../types.ts';
import { fetchWithRetry } from '../utils/fetch.ts';
import { buildSafeUrl } from './telegram.ts';

// OAuth 2.0 (PKCE) based X (Twitter) posting support.
// - Token storage is encrypted at rest using AES-GCM with a symmetric key from X_ENC_KEY (base64).
// - If no token is stored, posting is skipped. Use the OAuth routes to authorize once.

const AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const API_TWEETS_URL = 'https://api.twitter.com/2/tweets';
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

const LINK_WEIGHT = 23; // t.co link length
const TWEET_MAX = 280;

// ---------- Utilities ----------

function toBytes(s: string): Uint8Array { return new TextEncoder().encode(s); }
function fromBytes(b: ArrayBuffer | Uint8Array): string {
  const v = b instanceof Uint8Array ? b : new Uint8Array(b);
  let bin = '';
  for (let i = 0; i < v.length; i++) bin += String.fromCharCode(v[i]);
  return btoa(bin);
}
function toB64Url(bytes: ArrayBuffer): string {
  return fromBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function randB64Url(len = 32): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return toB64Url(buf.buffer);
}
function nowSec() { return Math.floor(Date.now() / 1000); }

async function sha256B64Url(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBytes(s));
  return toB64Url(digest);
}

// ---------- AES-GCM encryption for tokens at rest ----------

async function importAesKeyFromBase64(b64: string): Promise<CryptoKey> {
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptJson(env: Env, obj: any): Promise<{ iv: string; ct: string } | null> {
  const keyB64 = env.X_ENC_KEY;
  if (!keyB64) return null;
  const key = await importAesKeyFromBase64(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = toBytes(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: fromBytes(iv), ct: fromBytes(ct) };
}

async function decryptJson(env: Env, payload: { iv: string; ct: string }): Promise<any | null> {
  const keyB64 = env.X_ENC_KEY;
  if (!keyB64) return null;
  const key = await importAesKeyFromBase64(keyB64);
  const ivBin = atob(payload.iv);
  const iv = new Uint8Array(ivBin.length);
  for (let i = 0; i < iv.length; i++) iv[i] = ivBin.charCodeAt(i);
  const ctBin = atob(payload.ct);
  const ct = new Uint8Array(ctBin.length);
  for (let i = 0; i < ct.length; i++) ct[i] = ctBin.charCodeAt(i);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const dec = new TextDecoder().decode(new Uint8Array(pt));
  return JSON.parse(dec);
}

// ---------- D1 helpers ----------
// Tables are created via D1 migrations (see migrations/004_create_x_oauth.sql).
// We no longer attempt to create tables at request time to avoid exec/parse issues.

async function saveSession(env: Env, state: string, codeVerifier: string) {
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_sessions(state, code_verifier, created_at) VALUES(?, ?, CURRENT_TIMESTAMP)`).bind(state, codeVerifier).run();
}

async function loadAndDeleteSession(env: Env, state: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT code_verifier FROM oauth_sessions WHERE state = ?`).bind(state).first<{ code_verifier: string }>();
  if (row) await env.DB.prepare(`DELETE FROM oauth_sessions WHERE state = ?`).bind(state).run();
  return row?.code_verifier ?? null;
}

type TokenPayload = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token_expires_in?: number;
};

async function saveTokens(env: Env, t: TokenPayload) {
  const expiresAt = t.expires_in ? nowSec() + Math.max(1, t.expires_in - 60) : null; // subtract 60s as buffer
  const enc = await encryptJson(env, t);
  if (!enc) throw new Error('X_ENC_KEY not set; cannot store tokens securely');
  const data = JSON.stringify(enc);
  await env.DB.prepare(
    `INSERT INTO oauth_tokens(provider, data, expires_at, created_at, updated_at)
     VALUES('x', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP`
  ).bind(data, expiresAt).run();
}

async function getTokens(env: Env): Promise<{ payload: TokenPayload; expires_at: number | null } | null> {
  const row = await env.DB.prepare(`SELECT data, expires_at FROM oauth_tokens WHERE provider = 'x'`).first<{ data: string; expires_at: number | null }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data || '{}');
    const dec = await decryptJson(env, parsed);
    if (!dec) return null;
    return { payload: dec as TokenPayload, expires_at: row.expires_at ?? null };
  } catch {
    return null;
  }
}

async function refreshIfNeeded(env: Env): Promise<string | null> {
  const rec = await getTokens(env);
  if (!rec) return null;
  const access = rec.payload.access_token;
  const refresh = rec.payload.refresh_token;
  const expiresAt = rec.expires_at ?? 0;
  if (access && nowSec() < expiresAt) return access;
  if (!refresh) return null;
  // Refresh token
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', refresh);
  params.set('client_id', env.X_CLIENT_ID || '');
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_ID && env.X_CLIENT_SECRET) {
    const creds = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
    headers['Authorization'] = `Basic ${creds}`;
  }
  const res = await fetchWithRetry(TOKEN_URL, { method: 'POST', headers, body: params.toString() }, { retries: 1, timeoutMs: 15000 });
  if (!res.ok) {
    console.warn('X refresh failed', res.status, await res.text());
    return null;
  }
  const json = (await res.json()) as TokenPayload;
  await saveTokens(env, json);
  return json.access_token;
}

// ---------- Public: OAuth routes ----------

export async function xOauthStart(env: Env, baseUrl: string): Promise<Response> {
  if (!env.X_CLIENT_ID) return new Response('X_CLIENT_ID not configured', { status: 500 });
  if (!env.X_ENC_KEY) return new Response('X_ENC_KEY must be set to securely store tokens', { status: 500 });
  const redirectUri = new URL('/x/oauth/callback', baseUrl).toString();
  const state = randB64Url(24);
  const verifier = randB64Url(64);
  const challenge = await sha256B64Url(verifier);
  await saveSession(env, state, verifier);
  const url = new URL(AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.X_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return Response.redirect(url.toString(), 302);
}

export async function xOauthCallback(env: Env, requestUrl: string, baseUrl: string): Promise<Response> {
  const url = new URL(requestUrl);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  if (!code || !state) return new Response('Missing code/state', { status: 400 });
  const verifier = await loadAndDeleteSession(env, state);
  if (!verifier) return new Response('Invalid session state', { status: 400 });
  if (!env.X_CLIENT_ID) return new Response('X_CLIENT_ID not configured', { status: 500 });
  if (!env.X_ENC_KEY) return new Response('X_ENC_KEY must be set', { status: 500 });
  const redirectUri = new URL('/x/oauth/callback', baseUrl).toString();

  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', code);
  params.set('redirect_uri', redirectUri);
  params.set('client_id', env.X_CLIENT_ID);
  params.set('code_verifier', verifier);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_ID && env.X_CLIENT_SECRET) {
    const creds = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
    headers['Authorization'] = `Basic ${creds}`;
  }
  const res = await fetchWithRetry(TOKEN_URL, { method: 'POST', headers, body: params.toString() }, { retries: 1, timeoutMs: 15000 });
  if (!res.ok) {
    const t = await res.text();
    return new Response(`Token exchange failed: ${res.status} ${t}`, { status: 500 });
  }
  const json = (await res.json()) as TokenPayload;
  await saveTokens(env, json);
  return new Response('X OAuth connected. You can close this window.', { status: 200 });
}

export async function xOauthStatus(env: Env): Promise<Response> {
  const rec = await getTokens(env);
  const ok = !!rec?.payload?.access_token;
  const exp = rec?.expires_at ?? null;
  return Response.json({ connected: ok, expires_at: exp });
}

// ---------- Posting ----------

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
  // Ensure we have an access token (refresh if needed)
  const token = await refreshIfNeeded(env);
  if (!token) {
    console.warn('X OAuth not connected; visit /x/oauth/start to connect');
    return;
  }
  try {
    const res = await fetchWithRetry(
      API_TWEETS_URL,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) },
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
