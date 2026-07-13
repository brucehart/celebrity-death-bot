# Repository Guidelines

## Project Structure & Module Organization

- `src/index.ts`: Cloudflare Worker entry. Handles cron job, routes (`/run`, `/replicate/callback`, `/health`), Wikipedia parsing, D1 writes, Replicate calls, and Telegram notifications.
- `public/`: Static assets served via Workers Assets (`ASSETS`) — e.g., `privacy.html`, `index.html`, and project logo.
- `wrangler.jsonc`: Worker configuration (cron schedule, D1 binding `DB`, `vars.BASE_URL`, assets, observability).
- Tooling: `tsconfig.json` (strict TypeScript), `.editorconfig`, `.prettierrc`, `worker-configuration.d.ts`.

## Build, Test, and Development Commands

- `npm run dev` (alias: `npm start`): Start local Wrangler dev server.
- `npm run deploy`: Deploy the Worker.
- `npm run cf-typegen`: Generate env typings from Wrangler bindings.
- Secrets (set once per environment):
  - `wrangler secret put REPLICATE_API_TOKEN`
  - `wrangler secret put REPLICATE_WEBHOOK_SECRET` (required with Replicate)
  - `wrangler secret put TELEGRAM_BOT_TOKEN`
  - `wrangler secret put TELEGRAM_WEBHOOK_SECRET` (required for Telegram commands)
  - `wrangler secret put MANUAL_RUN_SECRET`
  - `wrangler secret put ALLOWED_GOOGLE_ACCOUNTS`
  - `wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SESSION_HMAC_KEY`

## Coding Style & Naming Conventions

- TypeScript, `strict: true`.
- Formatting: Prettier with tabs, single quotes, semicolons, `printWidth: 140`.
- Naming: `camelCase` for variables/functions, `PascalCase` for types, `kebab-case.ts` for filenames where applicable.
- Keep functions small and pure (e.g., parser helpers). Avoid logging secrets.

## Testing Guidelines

- `npm test` runs Node unit tests plus Cloudflare's Workers-runtime Vitest integration.
- Place Node unit tests in `tests/*.test.js` and Worker integration tests in `tests/worker/*.integration.ts`.
- Focus on parser behavior, authenticated route boundaries, webhook verification/idempotency, request limits, and LLM candidate constraints.

## Commit & Pull Request Guidelines

- Commits: short, imperative, scoped (e.g., `docs: center project logo`, `fix: callback JSON handling`).
- PRs include: clear description, linked issues, steps to verify (e.g., curl `POST /run` with `Authorization: Bearer <MANUAL_RUN_SECRET>`), and note schema or config changes.

## Security & Configuration Tips

- Store secrets with Wrangler; never commit tokens.
- `/run` requires `MANUAL_RUN_SECRET`. Replicate, OpenAI, and Telegram webhooks fail closed when their signing secret is absent; there is no manual webhook bypass.
- Apply `migrations/006_security_hardening.sql` before deploying code that uses the webhook replay ledger or session-bound X OAuth state.
- Ensure a D1 table `deaths` exists with columns used in `src/index.ts` (e.g., `name`, `wiki_path` UNIQUE, `age`, `description`, `cause`, `llm_result`, `llm_date_time`).
