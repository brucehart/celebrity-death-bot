## Highlights
- Initial public release of Celebrity Death Bot as a Cloudflare Worker.
- Hourly cron job scans Wikipedia and notifies subscribers via Telegram.
- Replicate integration to filter notable entries for a U.S. audience.

## Features
- Scheduled job (cron) to fetch and parse Wikipedia’s “Deaths in <Year>” page.
- Parser extracts: `name`, `wiki_path`, `age`, `description`, `cause` (when present).
- D1 database for persistence of parsed entries and subscriber chat IDs.
- Replicate call enqueues LLM evaluation; separate webhook endpoint handles results.
- Telegram notifications to subscribed chats with HTML‑escaped content and 4096‑char truncation.
- Manual trigger endpoint `POST /run` (guarded by secret).
- Health check at `GET /health`.

## Endpoints
- `POST /run` — Manually start a scan. Requires `Authorization: Bearer <MANUAL_RUN_SECRET>`.
- `POST /replicate/callback` — Receives Replicate prediction results.
- `POST /telegram/webhook` — Handles `/subscribe`, `/unsubscribe`, `/status`, `/help` commands.
- `GET /health` — Returns `ok`.

## Security
- Secrets stored via Wrangler (`wrangler secret put`).
- `/run` endpoint guarded by `MANUAL_RUN_SECRET`.
- Optional Replicate webhook verification planned for later; initial release accepts unsigned callbacks.

## Database Schema
- `deaths` table with fields: `id`, `name`, `wiki_path` (unique), `age`, `description`, `cause`, `llm_result`, `llm_date_time`, `created_at`.
- `subscribers` table for Telegram: `id`, `type`, `chat_id`, `enabled`, `created_at` (unique on `(type, chat_id)`).

## Configuration
- Wrangler bindings (`wrangler.jsonc`):
  - `DB` (D1), `ASSETS` (Workers Assets for static files).
  - Vars: `BASE_URL` (public Worker URL).
- Secrets:
  - `REPLICATE_API_TOKEN`
  - `TELEGRAM_BOT_TOKEN`
  - `MANUAL_RUN_SECRET`

## Static Assets
- `public/` served via Workers Assets (e.g., `index.html`, `privacy.html`, favicon assets).

## Verify
- Apply database schema migrations:
  - `migrations/001_create_subscribers.sql`
  - `migrations/003_create_deaths.sql`
- Start dev server: `npm run dev`.
- Trigger a manual run: `curl -X POST -H "Authorization: Bearer $MANUAL_RUN_SECRET" $BASE_URL/run`.
- Subscribe on Telegram: send `/subscribe` to your bot, then observe notifications on next approved callback.

