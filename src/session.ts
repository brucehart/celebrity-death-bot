import type { Env } from './types.ts';

const SESSION_DAYS = 180;
export const SESSION_MAXAGE = 60 * 60 * 24 * SESSION_DAYS;

let hmacKeyPromise: Promise<CryptoKey> | null = null;

function getHmacKey(env: Env): Promise<CryptoKey> {
	if (!hmacKeyPromise) {
		hmacKeyPromise = crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(env.SESSION_HMAC_KEY),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify']
		);
	}
	return hmacKeyPromise;
}

function base64UrlEncode(raw: string): string {
	return btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(raw: string): string {
	return atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
}

export async function signSession(email: string, env: Env): Promise<string> {
	const header = base64UrlEncode('{"alg":"HS256","typ":"JWT"}');
	const now = Math.floor(Date.now() / 1000);
	const payload = base64UrlEncode(JSON.stringify({ email, iat: now, exp: now + SESSION_MAXAGE }));
	const data = new TextEncoder().encode(`${header}.${payload}`);
	const sig = await crypto.subtle.sign('HMAC', await getHmacKey(env), data);
	const sigB64 = base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
	return `${header}.${payload}.${sigB64}`;
}

export async function verifySession(jwt: string, env: Env): Promise<string | null> {
	const [h, p, s] = jwt.split('.');
	if (!h || !p || !s) return null;
	const data = new TextEncoder().encode(`${h}.${p}`);
	const sig = Uint8Array.from(base64UrlDecode(s), (c) => c.charCodeAt(0));
	const ok = await crypto.subtle.verify('HMAC', await getHmacKey(env), sig, data);
	if (!ok) return null;
	const parsed = JSON.parse(base64UrlDecode(p));
	return Date.now() / 1000 < Number(parsed?.exp) ? String(parsed?.email || '') : null;
}

const STATE_MAXAGE = 300;

export async function signState(returnTo: string, env: Env): Promise<string> {
	const header = base64UrlEncode('{"alg":"HS256","typ":"JWT"}');
	const now = Math.floor(Date.now() / 1000);
	const payload = base64UrlEncode(JSON.stringify({ return_to: returnTo, iat: now, exp: now + STATE_MAXAGE }));
	const data = new TextEncoder().encode(`${header}.${payload}`);
	const sig = await crypto.subtle.sign('HMAC', await getHmacKey(env), data);
	const sigB64 = base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
	return `${header}.${payload}.${sigB64}`;
}

export async function verifyState(token: string, env: Env): Promise<string | null> {
	const [h, p, s] = token.split('.');
	if (!h || !p || !s) return null;
	const data = new TextEncoder().encode(`${h}.${p}`);
	const sig = Uint8Array.from(base64UrlDecode(s), (c) => c.charCodeAt(0));
	const ok = await crypto.subtle.verify('HMAC', await getHmacKey(env), sig, data);
	if (!ok) return null;
	const parsed = JSON.parse(base64UrlDecode(p));
	return Date.now() / 1000 < Number(parsed?.exp) ? String(parsed?.return_to || '') : null;
}
