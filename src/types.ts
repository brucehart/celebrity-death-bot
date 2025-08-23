export interface Env {
  DB: D1Database;

  REPLICATE_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  BASE_URL: string;
  REPLICATE_WEBHOOK_SECRET?: string;
  MANUAL_RUN_SECRET: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // X (Twitter) OAuth 1.0a credentials for posting Tweets
  // These should be set via Wrangler secrets; posting is skipped if any are missing.
  X_API_KEY?: string; // aka consumer key
  X_API_SECRET?: string; // aka consumer secret
  X_ACCESS_TOKEN?: string; // user access token
  X_ACCESS_TOKEN_SECRET?: string; // user access token secret
  // Optional: configure rate limits for /run as "60:3,3600:20"
  RUN_RATE_LIMITS?: string;
  ASSETS: Fetcher; // bound by Wrangler for static assets
}

export type DeathEntry = {
  name: string;
  wiki_path: string;
  age: number | null;
  description: string | null;
  cause: string | null;
};
