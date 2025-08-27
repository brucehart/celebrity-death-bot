## Highlights
- X/Twitter posting via OAuth 2.0 (PKCE) with encrypted token storage.
- Verified Replicate webhooks and secured Telegram webhooks.
- Configurable rate limiting for `/run`; safer DB access and batching.
- Improved coverage (scans previous month early in a month) and content formatting.

## Features
- X/Twitter integration using OAuth 2.0 (PKCE): tokens are encrypted at rest (AES‑GCM via `X_ENC_KEY`).
  - New routes: `GET /x/oauth/start`, `GET /x/oauth/callback`, `GET /x/oauth/status`.
  - Posts to X after Replicate completes if connected. If not configured/connected, posting is skipped.

## Security
- Replicate webhook verification (HMAC‑SHA256) when `REPLICATE_WEBHOOK_SECRET` is set. 5‑minute timestamp window enforced.
- Telegram webhook protection: require header `X-Telegram-Bot-Api-Secret-Token` matching `TELEGRAM_WEBHOOK_SECRET` when set.

## Performance & DB
- Batched upsert into `deaths` using D1 batch API with `RETURNING` and safe chunking (199 rows) to honor SQLite parameter limits.
- Removed runtime D1 table creation for X OAuth; rely on migrations to avoid exec/parse issues in Workers.

## Behavior & Fixes
- Configurable rate limiting for `POST /run` per IP. Defaults to `3/minute` and `20/hour`.
  - Override via `RUN_RATE_LIMITS` (e.g., `RUN_RATE_LIMITS="60:5,3600:50"`). Uses D1 `rate_limits` table.
- During the first 5 days of a month, also scan the previous month’s Wikipedia page for missed entries.
- Telegram content: omit cause when it equals "unknown"; minor formatting and prompt improvements.

## Configuration
- D1 binding configured in `wrangler.jsonc` (`DB`). Schema is managed via migrations in `/migrations`.
- Non‑secret var: `BASE_URL` for URLs/webhooks.
- Secrets to set (Wrangler):
  - `REPLICATE_API_TOKEN`
  - `TELEGRAM_BOT_TOKEN`
  - `MANUAL_RUN_SECRET`
  - Optional: `REPLICATE_WEBHOOK_SECRET` (enables webhook verification)
  - Optional: `TELEGRAM_WEBHOOK_SECRET` (protects `/telegram/webhook`)
  - X OAuth 2.0: `X_CLIENT_ID` (required), `X_CLIENT_SECRET` (optional), `X_ENC_KEY` (required to encrypt tokens)
- Optional: `RUN_RATE_LIMITS` to tune limiter windows.

## Migrations
Run against your D1 database:
- `migrations/001_create_subscribers.sql`
- `migrations/002_create_rate_limits.sql`
- `migrations/003_create_deaths.sql`
- `migrations/004_create_x_oauth.sql`

## Breaking/Action Required
- OAuth 1.0a for X is removed; migrate to OAuth 2.0 (PKCE) and set `X_CLIENT_ID`/`X_ENC_KEY` (and optionally `X_CLIENT_SECRET`).
- Ensure D1 tables exist by applying migrations (no more runtime creation for OAuth tables).

## Verify
- Authorize X: visit `/x/oauth/start` and complete the flow; confirm via `/x/oauth/status`.
- Trigger a run: `POST /run` with header `Authorization: Bearer $MANUAL_RUN_SECRET`.
- Optional: Test Replicate webhook verification by setting `REPLICATE_WEBHOOK_SECRET` and sending a signed sample.
