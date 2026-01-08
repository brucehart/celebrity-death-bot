import type { Env } from '../types.ts';
import { finalizeLogin, isAllowedAccount, verifyGoogleToken } from '../auth.ts';
import { signState, verifyState } from '../session.ts';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function login(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const returnPath = sanitizeReturnPath(url.searchParams.get('return_to'));
	const returnTo = `${url.origin}${returnPath}`;
	const state = await signState(returnTo, env);
	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: env.OAUTH_CALLBACK_URL,
		response_type: 'code',
		scope: 'openid email',
		prompt: 'select_account',
		state,
	});
	return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
}

export async function oauthCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get('code');
	if (!code) return new Response('Missing code', { status: 400 });
	const state = url.searchParams.get('state');
	const returnTo = state ? await verifyState(state, env).catch(() => null) : null;
	if (!returnTo) return new Response('Invalid state', { status: 400 });

	const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			redirect_uri: env.OAUTH_CALLBACK_URL,
			grant_type: 'authorization_code',
		}),
	});
	const tokenJson = await tokenRes.json<any>();
	const idToken = tokenJson.id_token as string | undefined;
	const email = idToken ? await verifyGoogleToken(idToken, env).catch(() => null) : null;
	if (!email) return new Response('Unauthorized', { status: 403 });
	if (!isAllowedAccount(email, env)) return new Response('Forbidden', { status: 403 });

	return finalizeLogin(email, env, returnTo);
}

function sanitizeReturnPath(raw: string | null): string {
	if (!raw) return '/llm-debug';
	if (!raw.startsWith('/')) return '/llm-debug';
	if (raw.startsWith('//')) return '/llm-debug';
	return raw;
}
