# Changelog

## 1.0.0 – Initial release

- Cloudflare Worker with hourly cron to scan Wikipedia and enqueue LLM filter via Replicate.
- HMAC verification for Replicate webhooks with 5-minute tolerance.
- Telegram webhook for subscription commands with optional secret token.
- D1 persistence for `deaths`, `subscribers`, and lightweight rate limiter for `/run`.
- Safer Telegram HTML generation with escaping and 4096-char truncation.
- Tests for webhook signature verification, Telegram sanitization, Wikipedia parser, and JSON extraction.
- Static assets (`/privacy`).

