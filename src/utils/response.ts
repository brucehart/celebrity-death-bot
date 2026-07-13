export function withSecurityHeaders(response: Response): Response {
	const secured = new Response(response.body, response);
	if (!secured.headers.has('Content-Security-Policy')) {
		secured.headers.set(
			'Content-Security-Policy',
			"default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
		);
	}
	secured.headers.set('X-Content-Type-Options', 'nosniff');
	secured.headers.set('X-Frame-Options', 'DENY');
	secured.headers.set('Referrer-Policy', 'no-referrer');
	secured.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
	secured.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	return secured;
}

export function adminContentSecurityPolicy(nonce: string): string {
	return [
		"default-src 'self'",
		"base-uri 'none'",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"img-src 'self' data:",
		"object-src 'none'",
		`script-src 'nonce-${nonce}'`,
		`style-src 'nonce-${nonce}'`,
	].join('; ');
}
