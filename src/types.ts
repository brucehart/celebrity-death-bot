export interface Env {
  DB: D1Database;
  celebrity_death_bot_kv: KVNamespace;

  REPLICATE_API_TOKEN: string;
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN: string;
  BASE_URL: string;
  // Optional: override OpenAI Responses API timeout in ms
  OPENAI_TIMEOUT_MS?: string;
  // Optional: number of days into the month we also check the previous month
  LOOKBACK_DAYS?: string;
  REPLICATE_WEBHOOK_SECRET?: string;
  MANUAL_RUN_SECRET: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // Google OAuth for /llm-debug
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_CALLBACK_URL: string;
  SESSION_HMAC_KEY: string;
  // Comma/space/semicolon delimited list of permitted Google account emails
  ALLOWED_GOOGLE_ACCOUNTS?: string;
  // X (Twitter) OAuth 2.0 credentials and encryption key
  // X_CLIENT_ID is required to initiate OAuth (PKCE). X_CLIENT_SECRET is optional (used when supported).
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  // Symmetric key (base64) to encrypt tokens at rest in D1
  X_ENC_KEY?: string;
  // Optional: configure rate limits for /run as "60:3,3600:20"
  RUN_RATE_LIMITS?: string;
  // Optional: LLM provider override ("openai" or "replicate")
  LLM_PROVIDER?: string;
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
