-- Fence stale webhook attempts so only the current claimant can complete the
-- event or cross the boundary into non-idempotent external side effects.
ALTER TABLE processed_webhooks ADD COLUMN claim_token TEXT;
