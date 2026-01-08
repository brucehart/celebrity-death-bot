import type { Env } from './types.ts';
import { parseCookies } from './utils/cookies.ts';
import { signSession, verifySession, SESSION_MAXAGE } from './session.ts';

export type AuthInfo = { email: string };

export async function verifyGoogleToken(token: string, env: Env): Promise<string | null> {
	const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
	if (!resp.ok) return null;
	const data = await resp.json<any>();
	if (data.aud !== env.GOOGLE_CLIENT_ID) return null;
	if (Date.now() / 1000 > Number(data.exp)) return null;
	return data.email as string;
}

function parseAllowedAccounts(raw: string | undefined): Set<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(/[,\s;]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	);
}

export function isAllowedAccount(email: string, env: Env): boolean {
	const allowed = parseAllowedAccounts(env.ALLOWED_GOOGLE_ACCOUNTS);
	if (!allowed.size) return false;
	return allowed.has(email.toLowerCase());
}

export async function requireAuth(request: Request, env: Env): Promise<Response | AuthInfo> {
	const url = new URL(request.url);
	const cookies = parseCookies(request.headers.get('Cookie'));
	const token = cookies['session'];
	if (!token) {
		return redirectToLogin(url);
	}
	const email = await verifySession(token, env);
	if (!email) {
		return redirectToLogin(url);
	}
	if (!isAllowedAccount(email, env)) {
		return new Response('Forbidden', { status: 403 });
	}
	return { email };
}

export async function finalizeLogin(email: string, env: Env, returnTo: string): Promise<Response> {
	const jwt = await signSession(email, env);
	return new Response(null, {
		status: 302,
		headers: {
			Location: returnTo,
			'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAXAGE}`,
		},
	});
}

function redirectToLogin(url: URL): Response {
	const returnTo = encodeURIComponent(url.pathname + url.search);
	return new Response(null, { status: 302, headers: { Location: `/login?return_to=${returnTo}` } });
}
