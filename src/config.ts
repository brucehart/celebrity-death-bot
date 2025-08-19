// Centralized configuration and constants
import type { Env } from './types';

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
  };
}

