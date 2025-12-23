# Changelog

## 1.3.0 – LLM reliability and debug tooling

- LLM debug dashboard at `/llm-debug` with grouping and filters; now shows rejection reasons when present.
- Replicate improvements: model override support, explicit `rejected` handling, safer callback error parsing, and manual override option.
- Targeted reprocess via `POST /run` by id/wiki_path with MUST INCLUDE prompt protections.
- Retry and correctness: auto-retry pending rows, finalize pending results after callbacks, and skip newly inserted pending rows.
- Operational tuning: configurable `LOOKBACK_DAYS` and updated cron frequency for scans.

## 1.2.0 – Website, schema, and KV caching

- Website and API: responsive homepage served via Workers Assets; `GET /`, `GET /api/posts`, `GET /api/meta`.
- Schema and parser: store only the Wikipedia ID in `wiki_path` and add `link_type` (`active` vs `edit` redlink); link only when active.
- Monthly KV cache: track scraped `wiki_path`s per month with a short-lived lock to reduce duplicate D1 reads/writes.
- Replicate callback: scope `llm_result = 'no'` updates to the current callback’s candidates only; update `description` when provided by LLM.
- Telegram/X content: safer truncation that preserves the closing `</a>`; shared URL builder util.
- D1 batching: respect `?1..?100` limit and use `VALUES (...) ... RETURNING` for efficient multi-row inserts.

## 1.1.0 – X OAuth and posting

- X (Twitter) posting via OAuth 2.0 (PKCE): `GET /x/oauth/start`, `/x/oauth/callback`, `/x/oauth/status`.
- Tokens encrypted at rest in D1 using AES‑256‑GCM with `X_ENC_KEY`; automatic refresh before expiry.
- Post formatting mirrors Telegram; respects 280‑char limit with t.co link weighting.
- Documentation updates: setup for X OAuth and privacy policy improvements; favicon assets served via Workers Assets.

## 1.0.0 – Initial release

- Cloudflare Worker with hourly cron to scan Wikipedia and enqueue LLM filter via Replicate.
- HMAC verification for Replicate webhooks with 5-minute tolerance.
- Telegram webhook for subscription commands with optional secret token.
- D1 persistence for `deaths`, `subscribers`, and lightweight rate limiter for `/run`.
- Safer Telegram HTML generation with escaping and 4096-char truncation.
- Tests for webhook signature verification, Telegram sanitization, Wikipedia parser, and JSON extraction.
- Static assets (`/privacy`).

## 0.1.0 – Alpha preview

- Core scaffolding: basic routes (`/run`, `/health`), cron scaffold, and D1 persistence for parsed entries.
- Prototype Wikipedia parsing for `name`, `wiki_path`, `age`, `description`.
- Manual run endpoint with shared secret; secrets stored via Wrangler.
- Replicate integration planned (callback shape drafted); Telegram/webhook verification deferred.
