export function parseCookies(cookieHeader: string | null): Record<string, string> {
	const cookies: Record<string, string> = {};
	if (!cookieHeader) return cookies;
	for (const pair of cookieHeader.split(';')) {
		const [key, ...vals] = pair.trim().split('=');
		if (!key) continue;
		cookies[key] = vals.join('=');
	}
	return cookies;
}
