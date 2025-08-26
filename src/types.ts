export interface Env {
  DB: D1Database;

  REPLICATE_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  BASE_URL: string;
  REPLICATE_WEBHOOK_SECRET?: string;
  MANUAL_RUN_SECRET: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // X (Twitter) OAuth 2.0 credentials and encryption key
  // X_CLIENT_ID is required to initiate OAuth (PKCE). X_CLIENT_SECRET is optional (used when supported).
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  // Symmetric key (base64) to encrypt tokens at rest in D1
  X_ENC_KEY?: string;
  // Optional: configure rate limits for /run as "60:3,3600:20"
  RUN_RATE_LIMITS?: string;
  // Optional: site links for homepage
  X_PROFILE_URL?: string;
  TELEGRAM_BOT_URL?: string;
  ASSETS: Fetcher; // bound by Wrangler for static assets
}

export type DeathEntry = {
  name: string;
  // Only the Wikipedia ID (no leading /wiki/), e.g. "Peter_Doyle_(cyclist)" or "Greg_O%27Connell" or "Starling_Lawrence"
  wiki_path: string;
  // Whether the link is an actual article (active) or an edit/redlink action (edit)
  link_type: 'active' | 'edit';
  age: number | null;
  description: string | null;
  cause: string | null;
};
