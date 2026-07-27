-- Persist accepted OpenAI background responses so a later cron can retrieve
-- terminal results when the corresponding webhook is delayed or missing.
CREATE TABLE IF NOT EXISTS openai_background_responses (
  response_id TEXT PRIMARY KEY,
  candidate_paths_json TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_openai_background_responses_pending
  ON openai_background_responses(completed_at, submitted_at);
