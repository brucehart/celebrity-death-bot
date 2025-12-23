-- Add optional rejection reason from LLM responses
ALTER TABLE deaths ADD COLUMN llm_rejection_reason TEXT;
