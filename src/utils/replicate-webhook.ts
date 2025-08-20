// Utilities to verify Replicate webhook HMAC signatures (Cloudflare Workers compatible)
// Reference: Replicate signs with HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`

const DEFAULT_MAX_AGE_SECONDS = 5 * 60; // 5 minutes

function toUint8Array(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function base64DecodeToBytes(b64: string): Uint8Array {
  // atob expects a string; convert to bytes
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

export function parseWebhookSignatures(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.includes(',') ? t.split(',')[1] : t)) // drop version prefix like v1,
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
  // Use Web Crypto API available in Cloudflare Workers and modern Node
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, toUint8Array(message));
  return bytesToBase64(sig);
}

export async function computeReplicateSignature(secret: string, signedContent: string): Promise<string> {
  // Secret comes as whsec_<base64>; use the base64 part as raw key bytes
  const parts = secret.split('_');
  const base64Part = parts.length > 1 ? parts[1] : parts[0];
  const secretBytes = base64DecodeToBytes(base64Part);
  return hmacSha256Base64(secretBytes, signedContent);
}

export async function verifyReplicateSignatureParts(
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
  const computed = await computeReplicateSignature(secret, signedContent);
  const expected = parseWebhookSignatures(webhookSignatureHeader);
  if (!expected.length) return false;
  // Constant-time comparison over each candidate
  const computedBytes = toUint8Array(computed);
  for (const exp of expected) {
    const expBytes = toUint8Array(exp);
    if (expBytes.length === computedBytes.length) {
      // crypto.subtle.timingSafeEqual is not available; simulate constant-time compare
      let res = 0;
      for (let i = 0; i < expBytes.length; i++) res |= expBytes[i] ^ computedBytes[i];
      if (res === 0) return true;
    }
  }
  return false;
}

export async function verifyReplicateWebhook(
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
  const valid = await verifyReplicateSignatureParts(secret, id, ts, sig, body, maxAgeSeconds);
  if (!valid) return { ok: false, code: 403, error: 'Invalid webhook signature' };
  return { ok: true };
}

