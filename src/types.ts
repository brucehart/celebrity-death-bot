export interface Env {
  DB: D1Database;

  REPLICATE_API_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  BASE_URL: string;
  REPLICATE_WEBHOOK_SECRET?: string;
  MANUAL_RUN_SECRET: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ASSETS: Fetcher; // bound by Wrangler for static assets
}

export type DeathEntry = {
  name: string;
  wiki_path: string;
  age: number | null;
  description: string | null;
  cause: string | null;
};

