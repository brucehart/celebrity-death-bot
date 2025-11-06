<p align="center">
  <img src="public/Celebrity-Death-Bot.png" alt="Project Logo" width="50%" />
</p>

# Celebrity Death Bot

Celebrity Death Bot is a Cloudflare Worker that runs on a scheduled Cron trigger. It checks the latest Wikipedia page of notable deaths for the current year and notifies subscribed users when a new entry appears.

## How it works

1. **Fetches Wikipedia**: The worker retrieves `https://en.wikipedia.org/wiki/Deaths_in_<year>` where `<year>` is the current year in the America/New_York timezone.
2. **Parses entries**: From the page, it extracts each person's name, Wikipedia path, age, description and cause of death.
3. **Stores in D1**: Entries are stored in a D1 database. Items already in the database are ignored.
4. **LLM evaluation**: Newly discovered entries are sent to Replicate for LLM evaluation. The worker exposes a webhook to receive callbacks from Replicate.
5. **Telegram notifications**: When the callback provides results, the worker sends a message via Telegram to subscribed chats.
6. **X (Twitter) posting**: If X OAuth 2.0 is connected, each approved result is also posted to the timeline.

## Configuration

The worker expects the following bindings and environment variables:

- `DB` – D1 database binding used to persist entries.
- `REPLICATE_API_TOKEN` – API token for Replicate.
- `TELEGRAM_BOT_TOKEN` – Telegram bot token used for sending messages.
- `BASE_URL` – Public URL of the worker, used when building webhook URLs.
- `REPLICATE_WEBHOOK_SECRET` – Replicate webhook signing secret. When set, the
  worker verifies all Replicate webhook callbacks using HMAC (recommended).
- `MANUAL_RUN_SECRET` – Secret token required to call the manual `/run` endpoint.
- X (Twitter) OAuth 2.0 (PKCE) configuration:
  - `X_CLIENT_ID` – OAuth 2.0 client ID for your X App
  - `X_CLIENT_SECRET` – (optional) client secret; included when present
  - `X_ENC_KEY` – base64 AES-256-GCM key to encrypt tokens in D1

When connected once via OAuth 2.0, the worker stores and refreshes tokens and posts via `POST /2/tweets` with a Bearer token.

### Cron schedule

The default schedule runs hourly at minute 5 (see `wrangler.jsonc`). Adjust as needed.

## Development

Install dependencies and start the development server using Wrangler:

```bash
npm install
npm run dev
```

Deploy the worker with:

```bash
npm run deploy
```

## Endpoints
- `POST /run` – Manually trigger the job. Requires `MANUAL_RUN_SECRET`.
  - **Auth:** Send the secret in the `Authorization` header:
    ```
    Authorization: Bearer <MANUAL_RUN_SECRET>
    ```
  - **Full run (curl):**
    ```bash
    curl -X POST \
      -H "Authorization: Bearer $MANUAL_RUN_SECRET" \
      https://<your-worker>/run
    ```
  - **Targeted reprocess by IDs:** Re-enqueue specific `deaths.id` rows for Replicate summarization and normal processing (Telegram/X via the existing callback). These IDs are explicitly flagged in the prompt as MUST INCLUDE so the model accepts them as notable.
    ```bash
    curl -X POST \
      -H "Authorization: Bearer $MANUAL_RUN_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"ids":[123,124,130]}' \
      https://<your-worker>/run
    ```
    Notes: The worker also avoids marking these IDs as `llm_result = 'no'` if the model unexpectedly omits them; they'll remain pending so you can retry.
  - **Targeted reprocess by wiki_path(s):** If you prefer specifying the Wikipedia ID(s) instead of database IDs, send `wiki_paths` or a single `wiki_path`. Accepts raw IDs like `Jane_Doe`, full article paths like `/wiki/Jane_Doe`, or edit/redlink URLs like `/w/index.php?title=Jane_Doe&action=edit&redlink=1`.
    ```bash
    # Single
    curl -X POST \
      -H "Authorization: Bearer $MANUAL_RUN_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"wiki_path":"Jane_Doe"}' \
      https://<your-worker>/run

    # Multiple
    curl -X POST \
      -H "Authorization: Bearer $MANUAL_RUN_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"wiki_paths":["Jane_Doe","/wiki/John_Smith","/w/index.php?title=Greg_O%2727Connell&action=edit&redlink=1"]}' \
      https://<your-worker>/run
    ```
    Behavior mirrors the ID-based mode: These paths are treated as MUST INCLUDE in the Replicate prompt and won’t be auto-marked `no` if omitted.
- `POST /replicate/callback` – Endpoint for Replicate webhook callbacks (signed by Replicate; verified via HMAC if `REPLICATE_WEBHOOK_SECRET` is set).
  - Manual override: send the same `Authorization: Bearer <MANUAL_RUN_SECRET>` header that `/run` uses to bypass the HMAC requirement. Useful when you need to craft a callback payload to force a “yes” decision.
- `POST /telegram/webhook` – Telegram webhook endpoint for subscription commands. If `TELEGRAM_WEBHOOK_SECRET` is set, Telegram must send header `X-Telegram-Bot-Api-Secret-Token` with the same secret.
- `GET /health` – Simple health check returning `ok`.

## Rate Limiting

The `POST /run` endpoint is rate-limited to protect the worker from abuse and accidental overload.

- Default limits: 3 requests per 60 seconds and 20 requests per hour per client IP.
- Configuration: Override with the env var `RUN_RATE_LIMITS` as a comma-separated list of `<windowInSeconds>:<limit>` pairs.
  - Example: `RUN_RATE_LIMITS="60:5,3600:50"` sets 5/minute and 50/hour.
- Behavior: If a limit is exceeded, the endpoint responds with `429 Too Many Requests` and includes a `Retry-After` header (seconds).
- Logging: Exceed events are logged with IP and window info for operational visibility.

Schema
- The limiter uses a small D1 table `rate_limits` for counters.
- Apply the migration:
  ```bash
  wrangler d1 execute celebrity-death-bot --file=./migrations/002_create_rate_limits.sql
  ```

## Database Schema

The worker stores parsed entries and subscriber/chat state in D1.

- Death entries: `migrations/003_create_deaths.sql`
  ```bash
  wrangler d1 execute celebrity-death-bot --file=./migrations/003_create_deaths.sql
  ```
- Telegram subscribers: `migrations/001_create_subscribers.sql`
  ```bash
  wrangler d1 execute celebrity-death-bot --file=./migrations/001_create_subscribers.sql
  ```

## Telegram Webhook & Commands

Configure your bot to send updates to the Worker and let users manage subscriptions via chat.

- Set the Telegram webhook URL and provide a secret token that Telegram will send in header `X-Telegram-Bot-Api-Secret-Token` with every webhook request:
  ```bash
  export BASE_URL=<your-worker-url>
  export TELEGRAM_BOT_TOKEN=<your-token>
  export TELEGRAM_WEBHOOK_SECRET=<your-secret> # allowed chars: A-Z a-z 0-9 _ -

  # Store secret in Worker
  wrangler secret put TELEGRAM_WEBHOOK_SECRET <<< "$TELEGRAM_WEBHOOK_SECRET"

  # Configure webhook and secret_token on Telegram side
  curl -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -d url="${BASE_URL}/telegram/webhook" \
    -d secret_token="${TELEGRAM_WEBHOOK_SECRET}"
  ```
- Supported commands (send in a DM to your bot):
  - `/start` or `/subscribe` – Subscribe this chat to alerts.
  - `/stop` or `/unsubscribe` – Unsubscribe this chat (we delete your chat ID).
  - `/status` – Show current subscription status.
  - `/commands` – Show the list of available commands.

Notes
- Subscriptions are stored in the D1 table `subscribers` with fields: `id`, `type`, `chat_id`, `enabled`, `created_at` (unique on `(type, chat_id)`).
- Only `type = 'telegram'` is used currently; the schema allows future channels (SMS, Signal, etc.).
- Schema is managed outside runtime. A sample migration exists at `migrations/001_create_subscribers.sql`.
- Apply schema (option A — migration file):
  ```bash
  wrangler d1 execute celebrity-death-bot --file=./migrations/001_create_subscribers.sql
  ```
- Or create manually (option B):
  ```sql
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (type, chat_id)
  );
  ```
- Add secrets via Wrangler: `wrangler secret put TELEGRAM_WEBHOOK_SECRET` and ensure `TELEGRAM_BOT_TOKEN` is set.

## X (Twitter) Posting

The worker can post each Replicate-approved death to X (Twitter) at `x.com/CelebDeathBot`.

- Format matches Telegram, but the Wikipedia link is appended at the end (since X posts cannot embed clickable HTML links):
  - Example: `🚨💀Jane Doe (88) : American actor and philanthropist - cancer 💀🚨\nhttps://en.wikipedia.org/wiki/Jane_Doe`
- Length is constrained to 280 characters with t.co URL weighting (23 chars). The body text is truncated with an ellipsis if necessary.

Setup (OAuth 2.0, PKCE)
- In your X developer app, enable OAuth 2.0 user auth with scopes: `tweet.read tweet.write users.read offline.access`.
- Store secrets (never commit these):
  ```bash
  wrangler secret put X_CLIENT_ID
  wrangler secret put X_CLIENT_SECRET   # optional; included when present
  wrangler secret put X_ENC_KEY         # base64 32-byte key for AES-GCM
  ```
- Apply the migration for token storage:
  ```bash
  wrangler d1 execute celebrity-death-bot --file=./migrations/004_create_x_oauth.sql
  ```
- Connect the bot account by visiting:
  - `GET ${BASE_URL}/x/oauth/start` → authorizes via X; callback goes to `${BASE_URL}/x/oauth/callback`.
  - Verify status: `GET ${BASE_URL}/x/oauth/status` → `{ connected: true, expires_at: <unix> }`.

Security notes
- Access and refresh tokens are encrypted at rest in D1 via AES-256-GCM using `X_ENC_KEY`.
- Tokens are auto-refreshed as they near expiry; no interactive login is needed after the first connect.

## Replicate Webhook Signing (HMAC)

Replicate signs each webhook delivery. This worker verifies signatures to prevent spoofed or replayed requests.

- Headers used: `webhook-id`, `webhook-timestamp` (seconds), `webhook-signature`.
- Signed content: `${webhook-id}.${webhook-timestamp}.${rawBody}` (raw, unmodified body string).
- Algorithm: HMAC-SHA256 with your Replicate webhook signing key.
- Timestamp window: 5 minutes (requests older than this are rejected).

Setup
- Retrieve your signing key from Replicate (associated with your API token):
  ```bash
  curl -s -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
    https://api.replicate.com/v1/webhooks/default/secret
  # { "key": "whsec_..." }
  ```
- Store the key as a Worker secret:
  ```bash
  wrangler secret put REPLICATE_WEBHOOK_SECRET
  ```

Notes
- Do not append secrets to the webhook URL. This worker no longer uses `?secret=...` for Replicate callbacks; it relies on HMAC verification only.
- The secret format is `whsec_<base64>`. Only the base64 part is used as the raw HMAC key.
- The worker uses constant-time comparison and enforces a 5-minute timestamp tolerance to mitigate replay attacks.

## Testing

This repo uses Node’s built-in `node:test` for a few focused unit tests around webhook verification, Telegram HTML sanitization, Wikipedia parsing, and JSON extraction helpers.

- Run all tests:
  ```bash
  npm test
  ```

If you prefer Vitest, you can add it later; place tests beside code as `*.test.ts`.

## Release Notes

- See `release-notes/` for version-specific notes (e.g., v1.1, v1.2).

## License

This project is licensed under the [MIT License](LICENSE.md).
