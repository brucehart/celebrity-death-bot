-- Create table for parsed death entries
-- Schema used by src/services/db.ts and src/services/job.ts

CREATE TABLE IF NOT EXISTS deaths (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	wiki_path TEXT NOT NULL,
	age INTEGER,
	description TEXT,
	cause TEXT,
	llm_result TEXT NOT NULL DEFAULT 'pending', -- 'pending' until Replicate callback decides 'yes' or 'no'
	llm_date_time TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (wiki_path)
);

-- Helpful index if you plan to query by LLM state
CREATE INDEX IF NOT EXISTS idx_deaths_llm_result ON deaths(llm_result);
