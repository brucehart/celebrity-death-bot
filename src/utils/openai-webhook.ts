// Utilities to verify OpenAI webhook HMAC signatures (Standard Webhooks spec)
// Reference: signature over `${id}.${timestamp}.${rawBody}` using HMAC-SHA256

const DEFAULT_MAX_AGE_SECONDS = 5 * 60; // 5 minutes

function toUint8Array(input: string): Uint8Array {
	return new TextEncoder().encode(input);
}

function base64DecodeToBytes(b64: string): Uint8Array {
	const binStr = atob(b64);
	const bytes = new Uint8Array(binStr.length);
	for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = '';
	for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
	return btoa(bin);
}

function looksLikeBase64(value: string): boolean {
	if (!value) return false;
	if (value.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/=]+$/.test(value);
}

function secretToBytes(secret: string): Uint8Array {
	const trimmed = secret.trim();
	const base = trimmed.includes('_') ? trimmed.split('_').pop() || trimmed : trimmed;
	if (looksLikeBase64(base)) {
		try {
			return base64DecodeToBytes(base);
		} catch {}
	}
	return toUint8Array(trimmed);
}

export function parseWebhookSignatures(header: string | null | undefined): string[] {
	if (!header) return [];
	return header
		.split(' ')
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => (t.includes(',') ? t.split(',')[1] : t))
		.filter(Boolean);
}

export function isTimestampFresh(headerTs: string | null | undefined, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS): boolean {
	if (!headerTs) return false;
	const ts = Number.parseInt(headerTs, 10);
	if (!Number.isFinite(ts)) return false;
	const now = Math.floor(Date.now() / 1000);
	const diff = Math.abs(now - ts);
	return diff <= maxAgeSeconds;
}

async function hmacSha256Base64(secretBytes: Uint8Array, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, toUint8Array(message));
	return bytesToBase64(sig);
}

export async function computeOpenAISignature(secret: string, signedContent: string): Promise<string> {
	const secretBytes = secretToBytes(secret);
	return hmacSha256Base64(secretBytes, signedContent);
}

export async function verifyOpenAISignatureParts(
	secret: string,
	webhookId: string | null | undefined,
	webhookTimestamp: string | null | undefined,
	webhookSignatureHeader: string | null | undefined,
	rawBody: string,
	maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS
): Promise<boolean> {
	if (!webhookId || !webhookTimestamp || !webhookSignatureHeader) return false;
	if (!isTimestampFresh(webhookTimestamp, maxAgeSeconds)) return false;
	const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
	const computed = await computeOpenAISignature(secret, signedContent);
	const expected = parseWebhookSignatures(webhookSignatureHeader);
	if (!expected.length) return false;
	const computedBytes = toUint8Array(computed);
	for (const exp of expected) {
		const expBytes = toUint8Array(exp);
		if (expBytes.length === computedBytes.length) {
			let res = 0;
			for (let i = 0; i < expBytes.length; i++) res |= expBytes[i] ^ computedBytes[i];
			if (res === 0) return true;
		}
	}
	return false;
}

export async function verifyOpenAIWebhook(
	request: Request,
	secret: string,
	rawBody?: string,
	maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS
): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
	const id = request.headers.get('webhook-id');
	const ts = request.headers.get('webhook-timestamp');
	const sig = request.headers.get('webhook-signature');
	const body = rawBody ?? (await request.clone().text());

	if (!id || !ts || !sig) {
		return { ok: false, code: 400, error: 'Missing required webhook headers' };
	}
	if (!isTimestampFresh(ts, maxAgeSeconds)) {
		return { ok: false, code: 400, error: 'Webhook timestamp is too old' };
	}
	const valid = await verifyOpenAISignatureParts(secret, id, ts, sig, body, maxAgeSeconds);
	if (!valid) return { ok: false, code: 403, error: 'Invalid webhook signature' };
	return { ok: true };
}
