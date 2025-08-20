// Centralized configuration and constants
import type { Env } from './types.ts';

export const TZ = 'America/New_York';

export type AppConfig = {
  tz: string;
  baseUrl: string;
  features: {
    verifyReplicateWebhook: boolean;
    verifyTelegramWebhook: boolean;
  };
  limits: {
    fetchTimeoutMs: number;
    fetchRetries: number;
  };
  rateLimit: {
    run: {
      windows: { windowSeconds: number; limit: number }[];
    };
  };
};

export function getConfig(env: Env): AppConfig {
  return {
    tz: TZ,
    baseUrl: env.BASE_URL,
    features: {
      verifyReplicateWebhook: !!env.REPLICATE_WEBHOOK_SECRET,
      verifyTelegramWebhook: !!env.TELEGRAM_WEBHOOK_SECRET,
    },
    limits: {
      fetchTimeoutMs: 15000,
      fetchRetries: 2,
    },
    rateLimit: {
      run: {
        windows: parseRunRateLimits(env.RUN_RATE_LIMITS),
      },
    },
  };
}

function parseRunRateLimits(input?: string) {
  // Format: "<windowSeconds>:<limit>,<windowSeconds>:<limit>" e.g., "60:3,3600:20"
  if (!input) return [
    { windowSeconds: 60, limit: 3 },
    { windowSeconds: 3600, limit: 20 },
  ];
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  const windows = [] as { windowSeconds: number; limit: number }[];
  for (const part of parts) {
    const [w, l] = part.split(':');
    const ws = Number(w);
    const lim = Number(l);
    if (!Number.isFinite(ws) || !Number.isFinite(lim) || ws <= 0 || lim <= 0) continue;
    windows.push({ windowSeconds: Math.floor(ws), limit: Math.floor(lim) });
  }
  return windows.length ? windows : [
    { windowSeconds: 60, limit: 3 },
    { windowSeconds: 3600, limit: 20 },
  ];
}
