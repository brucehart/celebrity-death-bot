import type { Env } from '../types.ts';
import { getConfig } from '../config.ts';

export function getMeta(env: Env): Response {
  const cfg = getConfig(env);
  const data = {
    name: 'Celebrity Death Bot',
    description:
      'Automated updates of notable deaths sourced from Wikipedia. Generally accurate—mistakes can happen. Follow on X and subscribe on Telegram for alerts.',
    xProfileUrl: env.X_PROFILE_URL || '',
    telegramBotUrl: env.TELEGRAM_BOT_URL || '',
    timezone: cfg.tz,
    baseUrl: cfg.baseUrl,
  };
  return Response.json(data);
}
