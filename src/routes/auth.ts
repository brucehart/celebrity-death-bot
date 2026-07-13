import type { Env } from '../types.ts';
import { clearSession, finalizeLogin, isAllowedAccount, requireAuth, verifyCsrfRequest, verifyGoogleToken } from '../auth.ts';
import { createOAuthState, hasValidSessionKey, verifyState } from '../session.ts';
import { BodyTooLargeError, MAX_ADMIN_FORM_BYTES, readRequestTextBounded, readResponseTextBounded } from '../utils/request.ts';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function login(request: Request, env: Env): Promise<Response> {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !hasValidSessionKey(env)) {
		return new Response('Authentication is not configured', { status: 503 });
	}
	const url = new URL(request.url);
	const returnPath = sanitizeReturnPath(url.searchParams.get('return_to'));
	const returnTo = new URL(returnPath, env.BASE_URL).toString();
	const oauthState = await createOAuthState(returnTo, env);
	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: env.OAUTH_CALLBACK_URL,
		response_type: 'code',
		scope: 'openid email',
		prompt: 'select_account',
		state: oauthState.token,
		nonce: oauthState.nonce,
	});
	return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
}

export async function oauthCallback(request: Request, env: Env): Promise<Response> {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !hasValidSessionKey(env)) {
		return new Response('Authentication is not configured', { status: 503 });
	}
	const url = new URL(request.url);
	const code = url.searchParams.get('code');
	if (!code || code.length > 2_048) return new Response('Missing or invalid code', { status: 400 });
	const stateToken = url.searchParams.get('state');
	if (!stateToken || stateToken.length > 8_192) return new Response('Invalid state', { status: 400 });
	const state = await verifyState(stateToken, env);
	if (!state) return new Response('Invalid state', { status: 400 });

	try {
		if (new URL(state.returnTo).origin !== new URL(env.BASE_URL).origin) return new Response('Invalid state', { status: 400 });
	} catch {
		return new Response('Invalid state', { status: 400 });
	}

	const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			redirect_uri: env.OAUTH_CALLBACK_URL,
			grant_type: 'authorization_code',
		}),
	});
	if (!tokenRes.ok) return new Response('Unauthorized', { status: 403 });

	let tokenPayload: unknown;
	try {
		tokenPayload = JSON.parse(await readResponseTextBounded(tokenRes, MAX_ADMIN_FORM_BYTES));
	} catch {
		return new Response('Unauthorized', { status: 403 });
	}
	const idToken = isRecord(tokenPayload) && typeof tokenPayload.id_token === 'string' ? tokenPayload.id_token : '';
	const email = idToken ? await verifyGoogleToken(idToken, env, state.nonce) : null;
	if (!email) return new Response('Unauthorized', { status: 403 });
	if (!isAllowedAccount(email, env)) return new Response('Forbidden', { status: 403 });

	return finalizeLogin(email, env, state.returnTo);
}

export async function logout(request: Request, env: Env): Promise<Response> {
	const auth = await requireAuth(request, env);
	if (auth instanceof Response) return auth;

	let form: URLSearchParams;
	try {
		form = new URLSearchParams(await readRequestTextBounded(request, MAX_ADMIN_FORM_BYTES));
	} catch (error) {
		return new Response(error instanceof BodyTooLargeError ? 'Request too large' : 'Invalid form', {
			status: error instanceof BodyTooLargeError ? 413 : 400,
		});
	}
	if (!(await verifyCsrfRequest(request, env, auth, form.get('_csrf') || ''))) {
		return new Response('Forbidden', { status: 403 });
	}
	return clearSession('/');
}

function sanitizeReturnPath(raw: string | null): string {
	if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/llm-debug';
	return raw;
}
