import type { Env } from './types.ts';
import { randomToken } from './utils/security.ts';

const SESSION_HOURS = 12;
export const SESSION_MAXAGE = 60 * 60 * SESSION_HOURS;
const STATE_MAXAGE = 5 * 60;
const MIN_HMAC_KEY_BYTES = 32;

export type SessionClaims = {
	email: string;
	sessionId: string;
	csrfToken: string;
	expiresAt: number;
};

export type OAuthState = {
	returnTo: string;
	nonce: string;
};

type SignedClaims = Record<string, unknown> & { iat: number; exp: number };

let hmacKeyPromise: Promise<CryptoKey> | null = null;

export function hasValidSessionKey(env: Env): boolean {
	return typeof env.SESSION_HMAC_KEY === 'string' && new TextEncoder().encode(env.SESSION_HMAC_KEY).byteLength >= MIN_HMAC_KEY_BYTES;
}

function getHmacKey(env: Env): Promise<CryptoKey> {
	if (!hmacKeyPromise) {
		hmacKeyPromise = crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(env.SESSION_HMAC_KEY),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify'],
		);
	}
	return hmacKeyPromise;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(raw: string): Uint8Array {
	const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeJson(value: unknown): string {
	return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(raw: string): unknown {
	return JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function signClaims(claims: SignedClaims, env: Env): Promise<string> {
	const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
	const payload = encodeJson(claims);
	const data = new TextEncoder().encode(`${header}.${payload}`);
	const signature = await crypto.subtle.sign('HMAC', await getHmacKey(env), data);
	return `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifyClaims(token: string, env: Env): Promise<Record<string, unknown> | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const [headerPart, payloadPart, signaturePart] = parts;
		const header = decodeJson(headerPart);
		if (!isRecord(header) || header.alg !== 'HS256' || header.typ !== 'JWT') return null;

		const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
		const valid = await crypto.subtle.verify('HMAC', await getHmacKey(env), base64UrlToBytes(signaturePart), data);
		if (!valid) return null;

		const claims = decodeJson(payloadPart);
		if (!isRecord(claims)) return null;
		const expiresAt = Number(claims.exp);
		if (!Number.isFinite(expiresAt) || Date.now() / 1000 >= expiresAt) return null;
		return claims;
	} catch {
		return null;
	}
}

export async function signSession(email: string, env: Env): Promise<string> {
	if (!hasValidSessionKey(env)) throw new Error('SESSION_HMAC_KEY must contain at least 32 bytes');
	const now = Math.floor(Date.now() / 1000);
	return signClaims(
		{
			email,
			sid: crypto.randomUUID(),
			csrf: randomToken(),
			iat: now,
			exp: now + SESSION_MAXAGE,
		},
		env,
	);
}

export async function verifySession(token: string, env: Env): Promise<SessionClaims | null> {
	if (!hasValidSessionKey(env)) return null;
	const claims = await verifyClaims(token, env);
	if (!claims) return null;
	const email = typeof claims.email === 'string' ? claims.email : '';
	const sessionId = typeof claims.sid === 'string' ? claims.sid : '';
	const csrfToken = typeof claims.csrf === 'string' ? claims.csrf : '';
	const expiresAt = Number(claims.exp);
	if (!email || !sessionId || !csrfToken || !Number.isFinite(expiresAt)) return null;
	return { email, sessionId, csrfToken, expiresAt };
}

export async function createOAuthState(returnTo: string, env: Env): Promise<{ token: string; nonce: string }> {
	if (!hasValidSessionKey(env)) throw new Error('SESSION_HMAC_KEY must contain at least 32 bytes');
	const now = Math.floor(Date.now() / 1000);
	const nonce = randomToken();
	const token = await signClaims({ return_to: returnTo, nonce, iat: now, exp: now + STATE_MAXAGE }, env);
	return { token, nonce };
}

export async function verifyState(token: string, env: Env): Promise<OAuthState | null> {
	if (!hasValidSessionKey(env)) return null;
	const claims = await verifyClaims(token, env);
	if (!claims) return null;
	const returnTo = typeof claims.return_to === 'string' ? claims.return_to : '';
	const nonce = typeof claims.nonce === 'string' ? claims.nonce : '';
	return returnTo && nonce ? { returnTo, nonce } : null;
}
