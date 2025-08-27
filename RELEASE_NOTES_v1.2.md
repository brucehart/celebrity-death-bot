## Highlights
- Cleaner organization and safer helpers with zero breaking changes.
- Stronger Telegram HTML truncation that guarantees max length while keeping valid links.
- Small ergonomics improvements for assets and auth parsing.

## Code Quality & Organization
- Extracted `buildSafeUrl` to `src/utils/strings.ts` and reused in both Telegram and X posting to avoid cross‑module coupling.
- Removed dead code:
  - `makeWikiUrl` from `utils/strings.ts` (unused)
  - `insertIfNew` from `services/db.ts` (superseded by batched insert)
- Added targeted comments to clarify intent and constraints:
  - `src/services/job.ts`: high‑level orchestration overview.
  - `src/router.ts`: exact‑match routing scope.
  - `src/routes/posts.ts`: UTF‑8‑safe base64 cursor helpers.

## Runtime Behavior
- Telegram formatting:
  - Standardized message boundaries (no stray spaces around emoji bookends).
  - `truncateTelegramHTML(...)` now enforces the configured max length while preserving a well‑formed `</a>`; degrades to a minimal `<a></a>…` when the opening tag alone would exceed the budget.
- Asset serving:
  - `GET /` now serves `index.html` via Workers Assets using the original request context (headers/method) for consistency.
- `/run` endpoint:
  - Simplified case‑insensitive `Authorization` header parsing with optional Bearer support.

## Tests
- All existing unit tests pass (`node --test`). No new tests added.

## Migration/Config
- No schema or configuration changes required.

## Verify
- `npm test` — all suites green.
- Visit `/` and `/privacy` — served from Workers Assets as expected.
- `POST /run` with `Authorization: Bearer $MANUAL_RUN_SECRET` — unchanged behavior.
- Telegram/X posts unchanged in content; HTML truncation is more robust at extreme lengths.

