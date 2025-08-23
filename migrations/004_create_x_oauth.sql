-- OAuth storage for X (Twitter) OAuth 2.0
CREATE TABLE IF NOT EXISTS oauth_sessions (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

