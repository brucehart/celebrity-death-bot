import type { Env, DeathEntry } from '../types';

export async function insertIfNew(env: Env, e: DeathEntry): Promise<boolean> {
  const exists = await env.DB.prepare(`SELECT 1 FROM deaths WHERE wiki_path = ? LIMIT 1`).bind(e.wiki_path).first<{ 1: number }>();
  if (exists) return false;
  await env.DB.prepare(
    `INSERT INTO deaths (name, wiki_path, age, description, cause, llm_result)
     VALUES (?, ?, ?, ?, ?, 'no')`
  )
    .bind(e.name, e.wiki_path, e.age, e.description, e.cause)
    .run();
  return true;
}

export async function updateDeathLLM(env: Env, wiki_path: string, cause: string | null) {
  await env.DB.prepare(
    `UPDATE deaths
       SET cause = ?,
           llm_date_time = CURRENT_TIMESTAMP,
           llm_result = 'yes'
     WHERE wiki_path = ?`
  )
    .bind(cause, wiki_path)
    .run();
}

type Subscriber = { type: string; chat_id: string; enabled: number };

export async function getTelegramChatIds(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT type, chat_id, enabled FROM subscribers WHERE enabled = 1 AND type = ?`)
    .bind('telegram')
    .all<Subscriber>();
  return (rows.results || [])
    .map((r) => String((r as any).chat_id).trim())
    .filter(Boolean);
}

export async function getSubscriberStatus(env: Env, chatId: string): Promise<0 | 1 | null> {
  const row = await env.DB.prepare(`SELECT enabled FROM subscribers WHERE type = ? AND chat_id = ? LIMIT 1`)
    .bind('telegram', chatId)
    .first<{ enabled: number }>();
  if (!row) return null;
  return (row as any).enabled ? 1 : 0;
}

export async function subscribeTelegram(env: Env, chatId: string) {
  await env.DB.prepare(
    `INSERT INTO subscribers(type, chat_id, enabled)
       VALUES('telegram', ?, 1)
     ON CONFLICT(type, chat_id) DO UPDATE SET enabled = 1`
  )
    .bind(chatId)
    .run();
}

export async function unsubscribeTelegram(env: Env, chatId: string) {
  await env.DB.prepare(`DELETE FROM subscribers WHERE type = 'telegram' AND chat_id = ?`).bind(chatId).run();
}

