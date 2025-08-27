## Highlights
- First alpha cut to validate architecture and data flow.
- Wikipedia parsing prototype with D1 persistence.
- Manual run endpoint and basic cron scaffold.

## Features
- Basic Worker routing with `/run` and `/health`.
- Prototype `parseWikipedia(...)` extracts: `name`, `wiki_path`, `age`, `description` (when present).
- D1 `deaths` table with unique `wiki_path` and timestamps.
- Initial Replicate integration planned; endpoint and callback shape drafted.

## Endpoints
- `POST /run` — Triggers a one‑off scan. Requires `Authorization: Bearer <MANUAL_RUN_SECRET>`.
- `GET /health` — Simple liveness check.

## Security
- Secrets stored via Wrangler only; none committed.
- `/run` protected by `MANUAL_RUN_SECRET`.
- Webhook verification not enabled yet (planned for later).

## Database Schema
- `deaths` table: `id`, `name`, `wiki_path` (unique), `age`, `description`, `cause` (optional), `llm_result`, `llm_date_time`, `created_at`.

## Configuration
- `wrangler.jsonc` defines D1 binding (`DB`) and assets binding (`ASSETS`).
- Required env vars/secrets: `BASE_URL`, `MANUAL_RUN_SECRET`.
- Optional (planned): `REPLICATE_API_TOKEN`.

## Static Assets
- `public/` directory present; basic index/privacy placeholders wired for Workers Assets.

## Notes
- Telegram subscription and notifications are not included in this alpha.
- Webhook signature verification and broader test coverage arrive in v1.0.

