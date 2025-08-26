import type { Env, DeathEntry } from '../types.ts';

export async function insertIfNew(env: Env, e: DeathEntry): Promise<boolean> {
  const exists = await env.DB.prepare(`SELECT 1 FROM deaths WHERE wiki_path = ? LIMIT 1`).bind(e.wiki_path).first<{ 1: number }>();
  if (exists) return false;
  await env.DB.prepare(
    `INSERT INTO deaths (name, wiki_path, link_type, age, description, cause, llm_result)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(e.name, e.wiki_path, e.link_type, e.age, e.description, e.cause)
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
    String(r.wiki_path || '').trim(),
    r.link_type,
    Number.isFinite(r.age as any) ? (r.age as number) : null,
    r.description ?? null,
    r.cause ?? null,
  ] as const);

  // 6 params per row -> SQLite has a 999 parameter limit. 166*6=996
  const CHUNK = 166;
  const newOnes: DeathEntry[] = [];

  // Use D1's batch API which runs statements in a transaction.
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < tuples.length; i += CHUNK) {
    const chunk = tuples.slice(i, i + CHUNK);
    const placeholders = chunk
      .map((_, j) => `(?${j * 6 + 1},?${j * 6 + 2},?${j * 6 + 3},?${j * 6 + 4},?${j * 6 + 5},?${j * 6 + 6})`)
      .join(',');

    const sql = `
      INSERT INTO deaths (name, wiki_path, link_type, age, description, cause, llm_result)
      SELECT v.name, v.wiki_path, v.link_type, v.age, v.description, v.cause, 'pending'
      FROM (VALUES ${placeholders}) AS v(name, wiki_path, link_type, age, description, cause)
      ON CONFLICT(wiki_path) DO NOTHING
      RETURNING name, wiki_path, link_type, age, description, cause
    `;

    const flatBinds = chunk.flat();
    statements.push(env.DB.prepare(sql).bind(...flatBinds));
  }

  if (statements.length) {
    const results = await env.DB.batch<DeathEntry>(statements);
    for (const r of results) {
      const rows = (r as any).results as DeathEntry[] | undefined;
      if (rows && rows.length) newOnes.push(...rows);
    }
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

export async function setLLMNoFor(env: Env, wikiPaths: string[]) {
  const paths = (wikiPaths || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!paths.length) return;
  const placeholders = paths.map((_, i) => `?${i + 1}`).join(',');
  await env.DB.prepare(`UPDATE deaths SET llm_result = 'no' WHERE wiki_path IN (${placeholders}) AND llm_result = 'pending'`).bind(...paths).run();
}

export async function getLinkTypeMap(env: Env, wikiPaths: string[]): Promise<Record<string, 'active' | 'edit'>> {
  const paths = (wikiPaths || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!paths.length) return {};
  const placeholders = paths.map((_, i) => `?${i + 1}`).join(',');
  const res = await env.DB.prepare(`SELECT wiki_path, link_type FROM deaths WHERE wiki_path IN (${placeholders})`).bind(...paths).all<{ wiki_path: string; link_type: 'active' | 'edit' }>();
  const out: Record<string, 'active' | 'edit'> = {};
  for (const r of res.results || []) {
    out[(r as any).wiki_path] = (r as any).link_type as 'active' | 'edit';
  }
  return out;
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
