import type { Env } from '../types.ts';
import { buildTelegramMessage } from '../services/telegram.ts';

const PAGE_SIZE = 25;

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

function unb64(s: string): string {
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return '';
  }
}

export async function getRecentPosts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const beforeParam = url.searchParams.get('before') || '';
  const before = beforeParam ? unb64(beforeParam) : '';

  const binds: any[] = [];
  let sql = `SELECT name, wiki_path, age, description, cause, llm_date_time as posted_at
             FROM deaths
             WHERE llm_result = 'yes' AND llm_date_time IS NOT NULL`;
  if (before) {
    sql += ` AND llm_date_time < ?1`;
    binds.push(before);
  }
  sql += ` ORDER BY llm_date_time DESC LIMIT ?${binds.length + 1}`;
  binds.push(PAGE_SIZE + 1); // fetch one extra to know if there is a next page

  const res = await env.DB.prepare(sql).bind(...binds).all<{
    name: string;
    wiki_path: string;
    age: number | null;
    description: string | null;
    cause: string | null;
    posted_at: string;
  }>();

  const rows = res.results || [];
  const hasMore = rows.length > PAGE_SIZE;
  const slice = rows.slice(0, PAGE_SIZE);

  const items = slice.map((r) => {
    const html = buildTelegramMessage({
      name: r.name,
      age: r.age,
      description: r.description,
      cause: r.cause,
      wiki_path: r.wiki_path,
    });
    return {
      name: r.name,
      age: r.age,
      description: r.description,
      cause: r.cause,
      wiki_path: r.wiki_path,
      posted_at: r.posted_at,
      html,
    };
  });

  const nextBefore = hasMore ? b64(String(rows[PAGE_SIZE].posted_at)) : null;

  return Response.json({ ok: true, count: items.length, items, nextBefore, hasMore });
}

