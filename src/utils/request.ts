export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export const MAX_ADMIN_FORM_BYTES = 64 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export const MAX_WIKIPEDIA_BODY_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Body exceeds ${maxBytes} bytes`);
		this.name = 'BodyTooLargeError';
		this.maxBytes = maxBytes;
	}
}

function rejectOversizedContentLength(headers: Headers, maxBytes: number): void {
	const raw = headers.get('Content-Length');
	if (!raw) return;
	const length = Number(raw);
	if (Number.isFinite(length) && length > maxBytes) throw new BodyTooLargeError(maxBytes);
}

async function readTextBounded(body: ReadableStream<Uint8Array> | null, headers: Headers, maxBytes: number): Promise<string> {
	rejectOversizedContentLength(headers, maxBytes);
	if (!body) return '';

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel('Body too large').catch(() => undefined);
				throw new BodyTooLargeError(maxBytes);
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		reader.releaseLock();
	}
}

export function readRequestTextBounded(request: Request, maxBytes: number): Promise<string> {
	return readTextBounded(request.body, request.headers, maxBytes);
}

export function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
	return readTextBounded(response.body, response.headers, maxBytes);
}
