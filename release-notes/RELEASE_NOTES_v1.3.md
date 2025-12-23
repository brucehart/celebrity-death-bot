## Highlights
- New LLM debug dashboard at `/llm-debug` with filters, grouping by creation time, and rejection reason visibility.
- More robust Replicate flow: explicit rejected handling, callback error parsing, and optional manual overrides.
- Targeted reprocessing via `POST /run` by id/wiki_path with MUST INCLUDE prompt protections.
- Automatic retries for pending rows plus safer state transitions after callbacks.

## Features
- LLM debug dashboard: `/llm-debug` for inspecting results with paging, search, filters, and timeline grouping.
- Replicate model overrides and pending retries for jobs; auto-retry pending deaths each run.
- Targeted reprocess supports `ids`/`id` and `wiki_paths`/`wiki_path` body payloads.
- Optional manual override flag for Replicate callbacks.

## Behavior & Fixes
- LLM results now include explicit `rejected` entries; rejection reasons persist in D1.
- Pending rows are finalized after callbacks; newly inserted pending rows are excluded from the same run.
- Metadata include condition corrected to avoid accidental cross-candidate updates.
- LLM rejection timestamps persisted; callback parsing hardened for error payloads.
- LLM debug view shows rejection reasons when present.

## Configuration
- `LOOKBACK_DAYS` env var (default 5) controls previous-month scan window.
- `wrangler.jsonc` includes `LOOKBACK_DAYS` as a configurable var.

## Migrations
- None new for this release.

## Tests
- Not run.

## Verify
- `POST /run` with `Authorization: Bearer $MANUAL_RUN_SECRET`.
- Targeted reprocess:
  - `POST /run` with JSON body `{ "ids": [1,2] }` or `{ "wiki_paths": ["Person_Name"] }`.
- Visit `/llm-debug` to confirm rejection reasons and pending retries behavior.
