-- Bind X OAuth attempts to the authenticated administrator session and expire
-- one-time PKCE state. This table only contains short-lived state, so it is
-- safe to recreate during the migration.
DROP TABLE IF EXISTS oauth_sessions;

CREATE TABLE oauth_sessions (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_oauth_sessions_expires_at ON oauth_sessions(expires_at);

-- A provider event ID is processed at most once. The scheduled job retains
-- entries for 90 days, well beyond the providers' retry windows.
CREATE TABLE IF NOT EXISTS processed_webhooks (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_created_at ON processed_webhooks(created_at);
