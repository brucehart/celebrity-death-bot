import type { Env } from './types.ts';
import { parseCookies } from './utils/cookies.ts';
import { secureCompareStrings, hasSameOrigin } from './utils/security.ts';
import { signSession, verifySession, SESSION_MAXAGE, type SessionClaims } from './session.ts';
import { MAX_WEBHOOK_BODY_BYTES, readResponseTextBounded } from './utils/request.ts';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const SESSION_COOKIE_NAME = '__Host-session';

export type AuthInfo = SessionClaims;

type GoogleIdTokenHeader = { alg: string; kid: string };
type GoogleIdTokenClaims = {
	iss: string;
	aud: string | string[];
	exp: number;
	iat: number;
	nonce: string;
	email: string;
	email_verified: boolean;
	azp?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function base64UrlToBytes(raw: string): Uint8Array {
	const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtPart(raw: string): unknown {
	return JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw)));
}

function parseGoogleHeader(value: unknown): GoogleIdTokenHeader | null {
	if (!isRecord(value) || value.alg !== 'RS256' || typeof value.kid !== 'string' || !value.kid) return null;
	return { alg: value.alg, kid: value.kid };
}

function parseGoogleClaims(value: unknown): GoogleIdTokenClaims | null {
	if (!isRecord(value)) return null;
	const audience = value.aud;
	if (typeof audience !== 'string' && !Array.isArray(audience)) return null;
	if (Array.isArray(audience) && !audience.every((entry) => typeof entry === 'string')) return null;
	if (
		typeof value.iss !== 'string' ||
		typeof value.exp !== 'number' ||
		typeof value.iat !== 'number' ||
		typeof value.nonce !== 'string' ||
		typeof value.email !== 'string' ||
		value.email_verified !== true
	) {
		return null;
	}
	return {
		iss: value.iss,
		aud: audience as string | string[],
		exp: value.exp,
		iat: value.iat,
		nonce: value.nonce,
		email: value.email,
		email_verified: true,
		azp: typeof value.azp === 'string' ? value.azp : undefined,
	};
}

async function fetchGoogleVerificationKey(kid: string): Promise<CryptoKey | null> {
	const response = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } });
	if (!response.ok) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(await readResponseTextBounded(response, MAX_WEBHOOK_BODY_BYTES));
	} catch {
		return null;
	}
	if (!isRecord(payload) || !Array.isArray(payload.keys)) return null;

	for (const candidate of payload.keys) {
		if (!isRecord(candidate) || candidate.kid !== kid || candidate.kty !== 'RSA') continue;
		if (candidate.alg !== undefined && candidate.alg !== 'RS256') continue;
		if (candidate.use !== undefined && candidate.use !== 'sig') continue;
		if (typeof candidate.n !== 'string' || typeof candidate.e !== 'string') continue;
		const jwk: JsonWebKey = {
			kty: 'RSA',
			n: candidate.n,
			e: candidate.e,
		};
		return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
	}
	return null;
}

export async function verifyGoogleToken(token: string, env: Env, expectedNonce: string): Promise<string | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const [headerPart, payloadPart, signaturePart] = parts;
		const header = parseGoogleHeader(decodeJwtPart(headerPart));
		const claims = parseGoogleClaims(decodeJwtPart(payloadPart));
		if (!header || !claims) return null;

		const key = await fetchGoogleVerificationKey(header.kid);
		if (!key) return null;
		const signedData = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
		const signatureValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(signaturePart), signedData);
		if (!signatureValid) return null;

		if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return null;
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.includes(env.GOOGLE_CLIENT_ID)) return null;
		if (audiences.length > 1 && claims.azp !== env.GOOGLE_CLIENT_ID) return null;
		const now = Math.floor(Date.now() / 1000);
		if (claims.exp <= now || claims.iat > now + 5 * 60) return null;
		if (!(await secureCompareStrings(claims.nonce, expectedNonce))) return null;
		return claims.email;
	} catch {
		return null;
	}
}

function parseAllowedAccounts(raw: string | undefined): Set<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(/[,\s;]+/)
			.map((account) => account.trim().toLowerCase())
			.filter(Boolean),
	);
}

export function isAllowedAccount(email: string, env: Env): boolean {
	const allowed = parseAllowedAccounts(env.ALLOWED_GOOGLE_ACCOUNTS);
	return allowed.size > 0 && allowed.has(email.toLowerCase());
}

export async function requireAuth(request: Request, env: Env): Promise<Response | AuthInfo> {
	const url = new URL(request.url);
	const cookies = parseCookies(request.headers.get('Cookie'));
	const token = cookies[SESSION_COOKIE_NAME];
	if (!token) return redirectToLogin(url);

	const session = await verifySession(token, env);
	if (!session) return redirectToLogin(url);
	if (!isAllowedAccount(session.email, env)) return new Response('Forbidden', { status: 403 });
	return session;
}

export async function verifyCsrfRequest(request: Request, env: Env, auth: AuthInfo, suppliedToken: string): Promise<boolean> {
	if (!hasSameOrigin(request, env.BASE_URL)) return false;
	return secureCompareStrings(suppliedToken, auth.csrfToken);
}

export async function finalizeLogin(email: string, env: Env, returnTo: string): Promise<Response> {
	const jwt = await signSession(email, env);
	return new Response(null, {
		status: 302,
		headers: {
			Location: returnTo,
			'Cache-Control': 'no-store',
			'Set-Cookie': `${SESSION_COOKIE_NAME}=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAXAGE}`,
		},
	});
}

export function clearSession(location = '/'): Response {
	return new Response(null, {
		status: 303,
		headers: {
			Location: location,
			'Cache-Control': 'no-store',
			'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
		},
	});
}

function redirectToLogin(url: URL): Response {
	const returnTo = encodeURIComponent(url.pathname + url.search);
	return new Response(null, { status: 302, headers: { Location: `/login?return_to=${returnTo}`, 'Cache-Control': 'no-store' } });
}
