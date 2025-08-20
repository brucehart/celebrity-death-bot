import type { Env, DeathEntry } from '../types.ts';

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

/**
 * Batched upsert that inserts only unseen wiki_paths and returns exactly those new rows.
 * Uses a single round-trip per chunk with RETURNING. Wraps all chunks in a transaction.
 */
export async function insertBatchReturningNew(env: Env, rows: DeathEntry[]): Promise<DeathEntry[]> {
  if (!rows.length) return [];

  // Normalize input before binding
  const tuples = rows.map((r) => [
    r.name,
    String(r.wiki_path || '').trim().toLowerCase(),
    Number.isFinite(r.age as any) ? (r.age as number) : null,
    r.description ?? null,
    r.cause ?? null,
  ] as const);

  // 5 params per row -> keep well under 999
  const CHUNK = 480;
  const newOnes: DeathEntry[] = [];

  // Begin transaction
  await env.DB.prepare('BEGIN').run();
  try {
    for (let i = 0; i < tuples.length; i += CHUNK) {
      const chunk = tuples.slice(i, i + CHUNK);
      const placeholders = chunk
        .map((_, j) => `(?${j * 5 + 1},?${j * 5 + 2},?${j * 5 + 3},?${j * 5 + 4},?${j * 5 + 5})`)
        .join(',');

      const sql = `
        INSERT INTO deaths (name, wiki_path, age, description, cause, llm_result)
        SELECT v.name, v.wiki_path, v.age, v.description, v.cause, 'no'
        FROM (VALUES ${placeholders}) AS v(name, wiki_path, age, description, cause)
        ON CONFLICT(wiki_path) DO NOTHING
        RETURNING name, wiki_path, age, description, cause
      `;

      const flatBinds = chunk.flat();
      const res = await env.DB.prepare(sql).bind(...flatBinds).all<DeathEntry>();
      if (res.results?.length) newOnes.push(...(res.results as any));
    }
    await env.DB.prepare('COMMIT').run();
  } catch (err) {
    await env.DB.prepare('ROLLBACK').run();
    throw err;
  }

  return newOnes;
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
