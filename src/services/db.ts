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

  // D1 limits positional parameters to ?1..?100. We avoid numbered placeholders
  // and cap total placeholders per statement to <= 100. Each row has 6 params,
  // so 16 rows -> 96 placeholders stays within the limit.
  const CHUNK = 16;
  const newOnes: DeathEntry[] = [];

  // Use D1's batch API which runs statements in a transaction.
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < tuples.length; i += CHUNK) {
    const chunk = tuples.slice(i, i + CHUNK);
    // Use unnamed placeholders to avoid exceeding the ?1..?100 numeric cap
    // and rely on bind order. 6 placeholders per tuple; we add a literal 'pending'.
    const placeholders = chunk.map(() => `(?,?,?,?,?,?,'pending')`).join(',');

    const sql = `INSERT OR IGNORE INTO deaths (name, wiki_path, link_type, age, description, cause, llm_result)
                 VALUES ${placeholders}
                 RETURNING name, wiki_path, link_type, age, description, cause`;

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

export async function updateDeathLLM(env: Env, wiki_path: string, cause: string | null, description?: string | null) {
  const desc = (() => {
    const d = (description ?? '').toString().trim();
    return d ? d : null; // only update when non-empty
  })();
  await env.DB.prepare(
    `UPDATE deaths
       SET cause = ?1,
           description = COALESCE(?2, description),
           llm_date_time = CURRENT_TIMESTAMP,
           llm_result = 'yes'
     WHERE wiki_path = ?3`
  )
    .bind(cause, desc, wiki_path)
    .run();
}

export async function setLLMNoFor(env: Env, wikiPaths: string[]) {
  const paths = (wikiPaths || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!paths.length) return;
  const CHUNK = 100; // D1 param limit
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => `?`).join(',');
    statements.push(
      env.DB.prepare(`UPDATE deaths SET llm_result = 'no' WHERE wiki_path IN (${placeholders}) AND llm_result = 'pending'`).bind(...chunk)
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function getLinkTypeMap(env: Env, wikiPaths: string[]): Promise<Record<string, 'active' | 'edit'>> {
  const paths = (wikiPaths || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!paths.length) return {};
  const CHUNK = 100; // D1 param limit
  const out: Record<string, 'active' | 'edit'> = {};
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => `?`).join(',');
    const res = await env.DB
      .prepare(`SELECT wiki_path, link_type FROM deaths WHERE wiki_path IN (${placeholders})`)
      .bind(...chunk)
      .all<{ wiki_path: string; link_type: 'active' | 'edit' }>();
    for (const r of res.results || []) {
      out[(r as any).wiki_path] = (r as any).link_type as 'active' | 'edit';
    }
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
