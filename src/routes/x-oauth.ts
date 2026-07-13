import type { Env } from '../types.ts';
import { requireAuth, verifyCsrfRequest } from '../auth.ts';
import { xOauthCallback as completeXOauth, xOauthStart as beginXOauth, xOauthStatus as readXOauthStatus } from '../services/x.ts';
import { BodyTooLargeError, MAX_ADMIN_FORM_BYTES, readRequestTextBounded } from '../utils/request.ts';
import { adminContentSecurityPolicy } from '../utils/response.ts';
import { randomToken } from '../utils/security.ts';

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character,
	);
}

export async function xOauthStart(request: Request, env: Env): Promise<Response> {
	const auth = await requireAuth(request, env);
	if (auth instanceof Response) return auth;
	if (request.method === 'POST') {
		let form: URLSearchParams;
		try {
			form = new URLSearchParams(await readRequestTextBounded(request, MAX_ADMIN_FORM_BYTES));
		} catch (error) {
			return new Response(error instanceof BodyTooLargeError ? 'Request too large' : 'Invalid form', {
				status: error instanceof BodyTooLargeError ? 413 : 400,
			});
		}
		if (!(await verifyCsrfRequest(request, env, auth, form.get('_csrf') || ''))) return new Response('Forbidden', { status: 403 });
		return beginXOauth(env, env.BASE_URL, { email: auth.email, sessionId: auth.sessionId });
	}

	const nonce = randomToken(18);
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect X</title><style nonce="${nonce}">body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#172033}button,a{font:inherit}button{padding:.7rem 1rem;cursor:pointer}.actions{display:flex;gap:1rem;align-items:center}</style></head>
<body><main><h1>Connect the X account</h1><p>This will authorize the bot to publish posts as the connected X account.</p>
<div class="actions"><form method="post" action="/x/oauth/start"><input type="hidden" name="_csrf" value="${escapeHtml(auth.csrfToken)}"><button type="submit">Continue to X</button></form><a href="/llm-debug">Cancel</a></div></main></body></html>`;
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Content-Security-Policy': adminContentSecurityPolicy(nonce),
		},
	});
}

export async function xOauthCallback(request: Request, env: Env): Promise<Response> {
	const auth = await requireAuth(request, env);
	if (auth instanceof Response) return auth;
	return completeXOauth(env, request.url, env.BASE_URL, { email: auth.email, sessionId: auth.sessionId });
}

export async function xOauthStatus(request: Request, env: Env): Promise<Response> {
	const auth = await requireAuth(request, env);
	if (auth instanceof Response) return auth;
	return readXOauthStatus(env);
}
