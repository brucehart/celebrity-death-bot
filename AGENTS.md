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
  - `wrangler secret put TELEGRAM_BOT_TOKEN`
  - `wrangler secret put MANUAL_RUN_SECRET`
  - Optional: `wrangler secret put REPLICATE_WEBHOOK_SECRET`

## Coding Style & Naming Conventions
- TypeScript, `strict: true`.
- Formatting: Prettier with tabs, single quotes, semicolons, `printWidth: 140`.
- Naming: `camelCase` for variables/functions, `PascalCase` for types, `kebab-case.ts` for filenames where applicable.
- Keep functions small and pure (e.g., parser helpers). Avoid logging secrets.

## Testing Guidelines
- No formal suite yet. Prefer Vitest for unit tests.
- Place tests beside code as `*.test.ts` (e.g., `src/parse-wikipedia.test.ts`).
- Focus: `parseWikipedia(...)` behavior and webhook JSON extraction utilities.
- Run locally with `npx vitest` (add an `npm test` script in PRs when introducing tests).

## Commit & Pull Request Guidelines
- Commits: short, imperative, scoped (e.g., `docs: center project logo`, `fix: callback JSON handling`).
- PRs include: clear description, linked issues, steps to verify (e.g., curl `POST /run` with `Authorization: Bearer <MANUAL_RUN_SECRET>`), and note schema or config changes.

## Security & Configuration Tips
- Store secrets with Wrangler; never commit tokens.
- `/run` requires `MANUAL_RUN_SECRET`. If set, `/replicate/callback` verifies HMAC signatures using `REPLICATE_WEBHOOK_SECRET` (5-minute window). If `TELEGRAM_WEBHOOK_SECRET` is set, `/telegram/webhook` must receive header `X-Telegram-Bot-Api-Secret-Token` with the same secret.
- Ensure a D1 table `deaths` exists with columns used in `src/index.ts` (e.g., `name`, `wiki_path` UNIQUE, `age`, `description`, `cause`, `llm_result`, `llm_date_time`).
