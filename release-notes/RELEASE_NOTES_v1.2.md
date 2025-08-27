## Highlights
- Monthly KV cache for scraped wiki paths reduces D1 reads/writes during scans; includes short‑lived KV lock to avoid races.
- Fixed D1 parameter index limits in batched inserts; safer and more reliable multi‑row upsert with `RETURNING`.
- Replicate callback correctness: only mark non‑selected candidates as `no` within the current callback.
- New lightweight API for recent posts and basic app metadata.
- Cleaner organization (shared wiki URL helper), fewer foot‑guns, and stronger Telegram HTML truncation.

## New Endpoints
- `GET /api/posts`: returns most recent approved (`llm_result = 'yes'`) items with rendered HTML snippet, plus pagination via `before` cursor (UTF‑8 safe base64).
- `GET /api/meta`: returns name, description, profile links, timezone, and base URL for simple client consumption.

## Schema & Migrations
- Added `link_type` to `deaths` and normalized `wiki_path` to store only the article ID (no leading `/wiki/`).
  - Migration: `migrations/005_alter_deaths_link_type.sql` adds the column, backfills existing rows, normalizes IDs, deduplicates rows (prefers `active` link), and enforces uniqueness on `wiki_path`.
- No changes to subscribers or rate limiter tables.

## Performance
- Introduced monthly KV cache and a short‑lived lock to synchronize updates per month bucket.
- Reworked batched insert to honor D1’s `?1..?100` positional parameter cap:
  - 16‑row chunks (≤96 params), unnamed placeholders, `INSERT OR IGNORE ... VALUES (...) RETURNING ...`.

## Behavior & Fixes
- Replicate callback:
  - Scope `llm_result = 'no'` updates only to non‑selected `metadata.candidates` to prevent overbroad updates.
  - Persist LLM description into `deaths.description` when present (and non‑empty) upon confirmation.
- Telegram/X content:
  - Telegram message spacing standardized; HTML truncation now enforces max length while preserving a valid `<a>` tag (degrades to minimal anchor if needed).
  - X posts mirror Telegram content; link included when article is active.
- Asset serving: `GET /` now serves `index.html` through Workers Assets using the original request context; 404 falls back to static assets.
- `/run`: simplified case‑insensitive `Authorization` parsing with optional Bearer prefix.

## Tooling & Config
- `wrangler.jsonc`: added KV binding, observability, and assets binding; updated compatibility date.
- `scripts/seed-monthly-kv.sh`: exports wiki paths from D1, groups per UTC month, and seeds KV keys `wiki_paths:YYYY-MM` (supports remote/local, env/profile flags).
- `types.ts`: includes KV, assets, and optional rate limit envs.

## Code Quality & Organization
- Extracted `buildSafeUrl` to `src/utils/strings.ts` and reused across Telegram and X posting.
- Removed dead code: `makeWikiUrl` (unused) and `insertIfNew` (superseded by batch insert).
- Added targeted comments to clarify behavior and constraints in `router.ts`, `services/job.ts`, and `routes/posts.ts`.

## Tests
- Existing unit tests cover webhook verification, Telegram HTML sanitation, Wikipedia parsing, JSON extraction, and Telegram webhook header auth.
- All tests pass (`node --test`).

## Verify
- Apply migrations if upgrading from ≤ v1.1 and you have not yet added `link_type`/normalized `wiki_path`:
  - `wrangler d1 execute celebrity-death-bot --file=./migrations/005_alter_deaths_link_type.sql`
- Seed KV (optional, one‑time bootstrap):
  - `scripts/seed-monthly-kv.sh --env <your-env>`
- Trigger a run: `curl -X POST -H "Authorization: Bearer $MANUAL_RUN_SECRET" $BASE_URL/run`
- Replicate callback: set `REPLICATE_WEBHOOK_SECRET` and send a signed sample; observe candidate‑scoped updates.
- API:
  - `GET /api/posts` returns items + `nextBefore` cursor.
  - `GET /api/meta` returns basic metadata.
