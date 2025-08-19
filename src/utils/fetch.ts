type RetryOptions = {
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
};

export async function fetchWithRetry(input: RequestInfo, init: RequestInit = {}, opts: RetryOptions = {}) {
  const { retries = 0, backoffMs = 400, timeoutMs } = opts;
  let attempt = 0;
  let lastErr: any;
  while (attempt <= retries) {
    try {
      const controller = new AbortController();
      const id = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      const res = await fetch(input, { ...init, signal: controller.signal });
      if (id) clearTimeout(id);
      if (res.ok) return res;
      // Retry 5xx
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, backoffMs * Math.max(1, attempt + 1)));
    }
    attempt++;
  }
  throw lastErr;
}

