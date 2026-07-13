const textEncoder = new TextEncoder();

export async function secureCompareStrings(provided: string, expected: string): Promise<boolean> {
	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', textEncoder.encode(provided)),
		crypto.subtle.digest('SHA-256', textEncoder.encode(expected)),
	]);

	if (typeof crypto.subtle.timingSafeEqual === 'function') {
		return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
	}

	// Node's Web Crypto does not expose Workers' timingSafeEqual extension. Keep
	// the fallback fixed-length and branch-free so the same helpers remain testable.
	const left = new Uint8Array(providedHash);
	const right = new Uint8Array(expectedHash);
	let mismatch = 0;
	for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
	return mismatch === 0;
}

export function randomToken(byteLength = 32): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function hasSameOrigin(request: Request, canonicalBaseUrl?: string): boolean {
	const suppliedOrigin = request.headers.get('Origin');
	if (!suppliedOrigin) return false;
	try {
		const requestOrigin = new URL(request.url).origin;
		if (new URL(suppliedOrigin).origin !== requestOrigin) return false;
		return canonicalBaseUrl ? requestOrigin === new URL(canonicalBaseUrl).origin : true;
	} catch {
		return false;
	}
}
