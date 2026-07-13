type RuntimeSecrets = {
	REPLICATE_API_TOKEN?: string;
	OPENAI_API_KEY?: string;
	OPENAI_WEBHOOK_SECRET?: string;
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_WEBHOOK_SECRET?: string;
	TELEGRAM_ALERT_CHAT_ID?: string;
	TELEGRAM_CHAT_IDS?: string;
	REPLICATE_WEBHOOK_SECRET?: string;
	MANUAL_RUN_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	SESSION_HMAC_KEY: string;
	ALLOWED_GOOGLE_ACCOUNTS?: string;
	X_CLIENT_ID?: string;
	X_CLIENT_SECRET?: string;
	X_ENC_KEY?: string;
	OPENAI_TIMEOUT_MS?: string;
	RUN_RATE_LIMITS?: string;
	JOB_ALERT_MIN_SCANNED?: string;
	JOB_ALERT_STALE_HOURS?: string;
	JOB_ALERT_COOLDOWN_MINUTES?: string;
	LLM_PROVIDER?: string;
};

export type Env = Cloudflare.Env & RuntimeSecrets;

export type DeathEntry = {
	name: string;
	// Only the Wikipedia ID (no leading /wiki/), e.g. "Peter_Doyle_(cyclist)".
	wiki_path: string;
	link_type: 'active' | 'edit';
	age: number | null;
	description: string | null;
	cause: string | null;
};
