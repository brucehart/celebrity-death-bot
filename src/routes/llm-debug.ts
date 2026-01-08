import type { Env } from '../types.ts';
import { buildSafeUrl, toStr } from '../utils/strings.ts';
import { buildTelegramMessage, notifyTelegram } from '../services/telegram.ts';
import { buildXStatus, postToXIfConfigured } from '../services/x.ts';
import { runJob, runJobForIds } from '../services/job.ts';
import { requireAuth } from '../auth.ts';

type LlmRow = {
	id: number;
	name: string;
	wiki_path: string;
	link_type: 'active' | 'edit';
	age: number | null;
	description: string | null;
	cause: string | null;
	llm_result: string;
	llm_rejection_reason: string | null;
	llm_date_time: string | null;
	created_at: string;
};

type QueryState = {
	search: string;
	page: number;
	pageSize: number;
	llmResults: string[];
	linkTypes: string[];
	createdFrom: string;
	createdTo: string;
	llmFrom: string;
	llmTo: string;
};

type HighlightConfig = { pattern: string };

const PAGE_SIZES = [25, 50, 100] as const;
const LLM_RESULT_OPTIONS = ['pending', 'yes', 'no', 'skipped', 'error'];
const LINK_TYPE_OPTIONS: Array<'active' | 'edit'> = ['active', 'edit'];
const EASTERN_TZ = 'America/New_York';

const headerDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: EASTERN_TZ,
	dateStyle: 'long',
	timeStyle: 'short',
});

const detailDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: EASTERN_TZ,
	dateStyle: 'medium',
	timeStyle: 'medium',
});

export async function llmDebug(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const auth = await requireAuth(request, env);
	if (auth instanceof Response) return auth;
	if (request.method === 'POST') {
		return handlePost(request, env, ctx);
	}
	const url = new URL(request.url);
	const state = extractQueryState(url);
	const notice = toStr(url.searchParams.get('notice')).trim();

	const { sql, binds } = buildQuery(state);
	const res = await env.DB.prepare(sql).bind(...binds).all<LlmRow>();
	const rows = res.results || [];

	const total = rows.length;
	const hasNext = total > state.pageSize;
	const pageRows = rows.slice(0, state.pageSize);
	const hasPrev = state.page > 1;

	const groups = groupRows(pageRows);
	const highlight = buildHighlightConfig(state.search);
	const html = renderPage(groups, state, { hasNext, hasPrev }, highlight, notice || null);

	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}

async function handlePost(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return new Response('Invalid form', { status: 400 });
	}

	const action = toStr(form.get('action'));
	const returnTo = sanitizeReturnTo(toStr(form.get('returnTo')));

	if (action === 'run-cron') {
		ctx.waitUntil(
			(async () => {
				try {
					const res = await runJob(env);
					console.log('Manual run via /llm-debug complete', res);
				} catch (err) {
					console.error('Manual run via /llm-debug error', err);
				}
			})()
		);
		return redirectTo(addNoticeToReturnTo(request, returnTo, 'Job started'));
	}

	if (action === 'replicate') {
		const id = parseNumericId(form.get('id'));
		if (id == null) return new Response('Invalid id', { status: 400 });
		await runJobForIds(env, [id], { model: 'openai/gpt-5-mini' });
		return redirectTo(returnTo);
	}

	if (action === 'update') {
		const id = parseNumericId(form.get('id'));
		if (id == null) return new Response('Invalid id', { status: 400 });

		const row = await env.DB.prepare(
			`SELECT id, name, wiki_path, link_type, age, description, cause, llm_result, llm_rejection_reason
         FROM deaths
        WHERE id = ?1`
		)
			.bind(id)
			.first<LlmRow>();
		if (!row) return new Response('Not found', { status: 404 });

		const nextStatus = normalizeLlmResult(toStr(form.get('status')) || row.llm_result);
		const statusChanged = nextStatus !== row.llm_result;

		const age = parseOptionalInt(toStr(form.get('age')));
		const description = normalizeOptionalText(form.get('description'));
		const cause = normalizeOptionalText(form.get('cause'));

		const rejection = nextStatus === 'yes' ? null : row.llm_rejection_reason ?? null;
		const llmDateSql = statusChanged
			? nextStatus === 'yes'
				? 'CURRENT_TIMESTAMP'
				: 'NULL'
			: 'llm_date_time';

		const sql = `UPDATE deaths
        SET age = ?1,
            description = ?2,
            cause = ?3,
            llm_result = ?4,
            llm_rejection_reason = ?5,
            llm_date_time = ${llmDateSql}
      WHERE id = ?6`;

		await env.DB.prepare(sql).bind(age, description, cause, nextStatus, rejection, id).run();

		if (statusChanged && nextStatus === 'yes') {
			const msg = buildTelegramMessage({
				name: row.name,
				age,
				description,
				cause,
				wiki_path: row.wiki_path,
				link_type: row.link_type,
			});
			await notifyTelegram(env, msg);
			const xText = buildXStatus({
				name: row.name,
				age,
				description,
				cause,
				wiki_path: row.wiki_path,
				link_type: row.link_type,
			});
			await postToXIfConfigured(env, xText);
		}

		return redirectTo(returnTo);
	}

	return new Response('Unsupported action', { status: 400 });
}

function sanitizeReturnTo(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return '/llm-debug';
	if (trimmed.startsWith('/llm-debug')) return trimmed;
	return '/llm-debug';
}

function addNoticeToReturnTo(request: Request, returnTo: string, notice: string): string {
	try {
		const url = new URL(returnTo, request.url);
		url.searchParams.set('notice', notice);
		return `${url.pathname}${url.search}`;
	} catch {
		return '/llm-debug';
	}
}

function redirectTo(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			location,
		},
	});
}

function parseNumericId(value: unknown): number | null {
	const raw = typeof value === 'string' ? value : toStr(value);
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return null;
	const id = Math.floor(parsed);
	return id > 0 ? id : null;
}

function parseOptionalInt(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const n = Number(trimmed);
	return Number.isFinite(n) ? Math.floor(n) : null;
}

function normalizeOptionalText(value: FormDataEntryValue | null): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function normalizeLlmResult(value: string): string {
	const raw = value.trim().toLowerCase();
	return LLM_RESULT_OPTIONS.includes(raw) ? raw : 'pending';
}

function extractQueryState(url: URL): QueryState {
	const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '', 10);
	const pageParam = parseInt(url.searchParams.get('page') || '', 10);
	const search = toStr(url.searchParams.get('search')).trim();

	const pageSize = PAGE_SIZES.includes(pageSizeParam as (typeof PAGE_SIZES)[number]) ? pageSizeParam : PAGE_SIZES[0];
	const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

	const llmResults = parseMultiSelect(url.searchParams.getAll('llmResult'), LLM_RESULT_OPTIONS);
	const linkTypes = parseMultiSelect(url.searchParams.getAll('linkType'), LINK_TYPE_OPTIONS);

	const createdFrom = toStr(url.searchParams.get('createdFrom'));
	const createdTo = toStr(url.searchParams.get('createdTo'));
	const llmFrom = toStr(url.searchParams.get('llmFrom'));
	const llmTo = toStr(url.searchParams.get('llmTo'));

	return { search, page, pageSize, llmResults, linkTypes, createdFrom, createdTo, llmFrom, llmTo };
}

function parseMultiSelect<T extends string>(values: string[], allowed: readonly T[]): T[] {
	const allowSet = new Set<string>(allowed);
	const out: T[] = [];
	for (const raw of values) {
		for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
			if (allowSet.has(part) && !out.includes(part as T)) out.push(part as T);
		}
	}
	return out;
}

function buildQuery(state: QueryState): { sql: string; binds: Array<string | number> } {
	const binds: Array<string | number> = [];
	const where: string[] = [];

	if (state.search) {
		const normalized = escapeLike(state.search.toLowerCase());
		const likeTerm = `%${normalized}%`;
		where.push(
			`(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(wiki_path) LIKE ? ESCAPE '\\' OR CAST(age AS TEXT) LIKE ? OR LOWER(description) LIKE ? ESCAPE '\\' OR LOWER(cause) LIKE ? ESCAPE '\\')`
		);
		binds.push(likeTerm, likeTerm, `%${escapeLike(state.search)}%`, likeTerm, likeTerm);
	}

	if (state.llmResults.length) {
		where.push(`llm_result IN (${state.llmResults.map(() => '?').join(',')})`);
		binds.push(...state.llmResults);
	}

	if (state.linkTypes.length) {
		where.push(`link_type IN (${state.linkTypes.map(() => '?').join(',')})`);
		binds.push(...state.linkTypes);
	}

	const createdFromSql = normalizeDateTime(state.createdFrom);
	if (createdFromSql) {
		where.push(`created_at >= ?`);
		binds.push(createdFromSql);
	}
	const createdToSql = normalizeDateTime(state.createdTo);
	if (createdToSql) {
		where.push(`created_at <= ?`);
		binds.push(createdToSql);
	}
	const llmFromSql = normalizeDateTime(state.llmFrom);
	if (llmFromSql) {
		where.push(`llm_date_time >= ?`);
		binds.push(llmFromSql);
	}
	const llmToSql = normalizeDateTime(state.llmTo);
	if (llmToSql) {
		where.push(`llm_date_time <= ?`);
		binds.push(llmToSql);
	}

	const limit = state.pageSize + 1;
	const offset = (state.page - 1) * state.pageSize;

	const sql = `SELECT id, name, wiki_path, link_type, age, description, cause, llm_result, llm_rejection_reason, llm_date_time, created_at
		FROM deaths
		${where.length ? `WHERE ${where.join(' AND ')}` : ''}
		ORDER BY created_at DESC, id DESC
		LIMIT ? OFFSET ?`;

	return { sql, binds: [...binds, limit, offset] };
}

function normalizeDateTime(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const parts = trimmed.split('T');
	const date = parts[0];
	if (!date) return null;
	let time = parts[1] || '00:00';
	if (time.length === 5) time = `${time}:00`;
	if (time.length === 2) time = `${time}:00:00`;
	if (!time.includes(':')) time = `${time}:00:00`;
	return `${date} ${time}`;
}

function escapeLike(value: string): string {
	return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

function buildHighlightConfig(search: string): HighlightConfig | null {
	const trimmed = search.trim();
	if (!trimmed) return null;
	const tokens = Array.from(new Set(trimmed.split(/\s+/).filter(Boolean)));
	if (!tokens.length) return null;
	const pattern = tokens.map(escapeRegex).join('|');
	if (!pattern) return null;
	return { pattern };
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(value: string | number | null, config: HighlightConfig | null, fallback = '—'): string {
	const str = toStr(value);
	if (!str) return fallback;
	if (!config) return escapeHtml(str);
	const regex = new RegExp(config.pattern, 'gi');
	let result = '';
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(str)) !== null) {
		result += escapeHtml(str.slice(lastIndex, match.index));
		result += `<mark>${escapeHtml(match[0])}</mark>`;
		lastIndex = regex.lastIndex;
	}
	result += escapeHtml(str.slice(lastIndex));
	return result;
}

function groupRows(rows: LlmRow[]): Array<{ key: string | null; label: string; rows: LlmRow[] }> {
	const groups: Array<{ key: string | null; label: string; rows: LlmRow[] }> = [];
	for (const row of rows) {
		const key = row.created_at || null;
		const last = groups[groups.length - 1];
		if (last && last.key === key) {
			last.rows.push(row);
		} else {
			groups.push({ key, label: formatGroupHeader(key), rows: [row] });
		}
	}
	return groups;
}

function formatGroupHeader(value: string | null): string {
	if (!value) return 'Created timestamp unavailable';
	const formatted = formatWithFormatter(value, headerDateTimeFormatter);
	return `Created ${formatted}`;
}

function formatFullDateTime(value: string | null, fallback = '—'): string {
	if (!value) return fallback;
	return formatWithFormatter(value, detailDateTimeFormatter);
}

function formatWithFormatter(value: string, formatter: Intl.DateTimeFormat): string {
	const date = parseUtcDate(value);
	if (!date) return value;
	return `${formatter.format(date)} ET`;
}

function parseUtcDate(value: string): Date | null {
	try {
		const normalized = value.includes('T') ? value : value.replace(' ', 'T');
		const iso = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? null : date;
	} catch {
		return null;
	}
}

function sanitizeToken(value: string): string {
	const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
	return clean || 'pending';
}

function escapeHtml(value: string | null | number): string {
	const str = toStr(value);
	return str.replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			case "'":
				return '&#39;';
			default:
				return ch;
		}
	});
}

function renderPage(
	groups: Array<{ key: string | null; label: string; rows: LlmRow[] }>,
	state: QueryState,
	pageMeta: { hasNext: boolean; hasPrev: boolean },
	highlight: HighlightConfig | null,
	notice: string | null
) {
	const baseParams = new URLSearchParams();
	if (state.search) baseParams.set('search', state.search);
	if (state.pageSize !== PAGE_SIZES[0]) baseParams.set('pageSize', String(state.pageSize));
	for (const val of state.llmResults) baseParams.append('llmResult', val);
	for (const val of state.linkTypes) baseParams.append('linkType', val);
	if (state.createdFrom) baseParams.set('createdFrom', state.createdFrom);
	if (state.createdTo) baseParams.set('createdTo', state.createdTo);
	if (state.llmFrom) baseParams.set('llmFrom', state.llmFrom);
	if (state.llmTo) baseParams.set('llmTo', state.llmTo);

	const nextParams = new URLSearchParams(baseParams);
	nextParams.set('page', String(state.page + 1));
	const prevParams = new URLSearchParams(baseParams);
	prevParams.set('page', String(Math.max(1, state.page - 1)));
	const currentParams = new URLSearchParams(baseParams);
	currentParams.set('page', String(state.page));
	const returnTo = `/llm-debug${currentParams.toString() ? `?${currentParams.toString()}` : ''}`;

	const formLlmr = renderCheckboxGroup('llmResult', 'LLM Result', LLM_RESULT_OPTIONS, state.llmResults);
	const formLink = renderCheckboxGroup('linkType', 'Link Type', LINK_TYPE_OPTIONS, state.linkTypes);

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>LLM Debug • Celebrity Death Bot</title>
	<style>
		:root {
			--bg: #f5f7fb;
			--panel: #ffffff;
			--panel-alt: #f0f3f9;
			--border: #d9deeb;
			--text: #0b1220;
			--muted: #6b7690;
			--accent: #2457f5;
			--accent-soft: rgba(36, 87, 245, 0.18);
			--success: #1f9d67;
			--danger: #d6455d;
			--warning: #c37b16;
		}
		* { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 16px/1.5 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
		a { color: var(--accent); text-decoration: none; }
		a:hover { text-decoration: underline; }
		header { padding: 24px 32px; border-bottom: 1px solid var(--border); backdrop-filter: blur(12px); position: sticky; top: 0; background: rgba(245,247,251,0.92); z-index: 10; }
		.header-inner { display: flex; align-items: center; gap: 18px; }
		.brand-logo { width: 64px; height: 64px; border-radius: 50%; border: 1px solid var(--border); box-shadow: 0 8px 25px rgba(15, 22, 42, 0.14); object-fit: cover; background: #fff; }
		.header-copy { display: flex; flex-direction: column; gap: 6px; }
		h1 { margin: 0; font-size: 1.9rem; font-weight: 700; }
		.subtitle { color: var(--muted); margin: 0; font-size: 0.98rem; }
		.container { max-width: 1240px; margin: 0 auto; padding: 24px 32px 60px; }
		form.filters { margin-top: 24px; background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 20px 24px; display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); box-shadow: 0 18px 45px rgba(15, 22, 42, 0.08); }
		.form-group { display: flex; flex-direction: column; gap: 8px; }
		label { font-weight: 600; font-size: 0.92rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
		input[type="search"], select, input[type="datetime-local"] { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; font: inherit; background: #fff; transition: border-color 0.2s ease, box-shadow 0.2s ease; }
		input[type="search"]:focus, select:focus, input[type="datetime-local"]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
		.checkbox-group { display: grid; gap: 6px; font-size: 0.92rem; }
		.checkbox-group label { font-weight: 500; text-transform: none; letter-spacing: normal; color: var(--text); display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
		.checkbox-group input { accent-color: var(--accent); }
		.button-row { display: flex; align-items: center; gap: 12px; }
		button.apply { padding: 10px 18px; border-radius: 10px; border: none; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
		button.apply:hover { background: #1c46ca; }
		a.reset { font-weight: 600; color: var(--muted); }
		.summary { margin: 28px 0 12px; display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
		.summary .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); font-size: 0.85rem; color: var(--muted); }
		.groups { display: flex; flex-direction: column; gap: 18px; margin-top: 16px; }
		.group { background: var(--panel); border-radius: 18px; border: 1px solid var(--border); box-shadow: 0 18px 45px rgba(15, 22, 42, 0.08); }
		.group-header { padding: 18px 24px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, rgba(36, 87, 245, 0.08), rgba(87, 143, 255, 0.08)); font-weight: 600; font-size: 1rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
		.group-items { display: flex; flex-direction: column; gap: 12px; padding: 18px 24px 24px; }
		.result-card { padding: 16px 20px; border: 1px solid var(--border); border-radius: 14px; background: var(--panel-alt); display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
		.result-main { display: flex; flex-direction: column; gap: 6px; }
		.result-main h3 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.result-main h3 a { font-weight: 700; color: var(--text); }
		.result-main h3 span.name-disabled { font-weight: 700; color: var(--muted); }
		.result-actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
		.edit-panel { border: 1px dashed var(--border); border-radius: 12px; background: rgba(255,255,255,0.7); padding: 8px 12px; }
		.edit-panel summary { cursor: pointer; font-weight: 600; color: var(--accent); list-style: none; }
		.edit-panel summary::-webkit-details-marker { display: none; }
		.edit-form { margin-top: 10px; display: grid; gap: 10px; }
		.edit-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
		.edit-grid label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
		.edit-grid input, .edit-grid textarea, .edit-grid select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; background: #fff; }
		.edit-grid textarea { resize: vertical; min-height: 72px; }
		button.secondary { padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border); background: #fff; font-weight: 600; cursor: pointer; color: var(--text); }
		button.secondary:hover { border-color: var(--accent); color: var(--accent); }
		button.danger { padding: 10px 16px; border-radius: 12px; border: 1px solid rgba(214, 69, 93, 0.55); background: rgba(214, 69, 93, 0.12); font-weight: 700; cursor: pointer; color: var(--danger); }
		button.danger:hover { border-color: var(--danger); background: rgba(214, 69, 93, 0.18); }
		.replicate-form { display: flex; align-items: center; gap: 10px; }
		.helper { color: var(--muted); font-size: 0.82rem; }
		.badge-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
		.badge-yes { background: rgba(31, 157, 103, 0.14); color: var(--success); }
		.badge-no { background: rgba(214, 69, 93, 0.14); color: var(--danger); }
		.badge-pending { background: rgba(195, 123, 22, 0.12); color: var(--warning); }
		.badge-error { background: rgba(214, 69, 93, 0.14); color: var(--danger); }
		.badge-skipped { background: rgba(107, 118, 144, 0.12); color: var(--muted); }
		.meta-grid { display: grid; gap: 6px; font-size: 0.92rem; color: var(--muted); }
		.meta-grid strong { color: var(--text); font-weight: 600; margin-right: 6px; }
		.pagination { display: flex; justify-content: center; gap: 12px; margin: 26px 0 16px; }
		.pagination a { padding: 10px 18px; border-radius: 12px; border: 1px solid var(--border); background: var(--panel); font-weight: 600; color: var(--text); }
		.pagination a[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
		.empty { padding: 60px 24px; text-align: center; color: var(--muted); background: var(--panel); border-radius: 18px; border: 1px dashed var(--border); }
		.notice { margin: 14px 0 0; padding: 12px 14px; border-radius: 14px; border: 1px solid rgba(36, 87, 245, 0.25); background: rgba(36, 87, 245, 0.08); color: var(--text); font-weight: 600; }
		.notice small { display: block; margin-top: 4px; color: var(--muted); font-weight: 500; }
		dialog.confirm-dialog { border: none; border-radius: 16px; padding: 0; width: min(460px, calc(100vw - 32px)); box-shadow: 0 30px 80px rgba(15, 22, 42, 0.28); }
		dialog.confirm-dialog::backdrop { background: rgba(15, 22, 42, 0.55); }
		.confirm-inner { padding: 18px 18px 14px; background: #fff; }
		.confirm-inner h2 { margin: 0; font-size: 1.05rem; }
		.confirm-inner p { margin: 10px 0 0; color: var(--muted); line-height: 1.35; }
		.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 18px 18px; background: #fff; border-top: 1px solid var(--border); }
		button.confirm { padding: 10px 16px; border-radius: 12px; border: 1px solid rgba(214, 69, 93, 0.55); background: var(--danger); color: #fff; font-weight: 700; cursor: pointer; }
		button.confirm:hover { filter: brightness(0.95); }
		mark { background: var(--accent-soft); color: var(--text); padding: 0 4px; border-radius: 4px; font-weight: 600; }
		@media (max-width: 720px) {
			header, .container { padding: 18px 16px; }
			form.filters { grid-template-columns: 1fr; }
			.result-card { grid-template-columns: 1fr; }
		}
	</style>
</head>
<body>
	<header>
		<div class="header-inner">
			<img class="brand-logo" src="/Celebrity-Death-Bot.png" alt="Celebrity Death Bot logo" />
			<div class="header-copy">
				<h1>LLM Evaluation Debug</h1>
				<p class="subtitle">Inspect Replicate outputs grouped by record creation time, with filters for deeper investigation.</p>
			</div>
		</div>
	</header>
	<main class="container">
		<form class="filters" method="get">
			<div class="form-group">
				<label for="search">Keyword Search</label>
				<input id="search" name="search" type="search" placeholder="Name, description, cause, age…" value="${escapeHtml(state.search)}" />
			</div>
			<div class="form-group">
				<label for="pageSize">Results Per Page</label>
				<select id="pageSize" name="pageSize">
					${PAGE_SIZES.map((size) => `<option value="${size}"${size === state.pageSize ? ' selected' : ''}>${size}</option>`).join('')}
				</select>
			</div>
			${formLlmr}
			${formLink}
			<div class="form-group">
				<label for="createdFrom">Created From</label>
				<input id="createdFrom" type="datetime-local" name="createdFrom" value="${escapeHtml(state.createdFrom)}" />
			</div>
			<div class="form-group">
				<label for="createdTo">Created To</label>
				<input id="createdTo" type="datetime-local" name="createdTo" value="${escapeHtml(state.createdTo)}" />
			</div>
			<div class="form-group">
				<label for="llmFrom">LLM Time From</label>
				<input id="llmFrom" type="datetime-local" name="llmFrom" value="${escapeHtml(state.llmFrom)}" />
			</div>
			<div class="form-group">
				<label for="llmTo">LLM Time To</label>
				<input id="llmTo" type="datetime-local" name="llmTo" value="${escapeHtml(state.llmTo)}" />
			</div>
			<div class="form-group button-row">
				<button class="apply" type="submit">Apply Filters</button>
				<a class="reset" href="/llm-debug">Reset</a>
			</div>
		</form>
		${notice ? `<div class="notice">${escapeHtml(notice)}<small>Refresh the page in a bit to see new records and updated LLM results.</small></div>` : ''}
		<section class="summary">
			<div class="badge">Page ${state.page}</div>
			<div class="badge">Showing ${groups.reduce((acc, g) => acc + g.rows.length, 0)} of ${state.pageSize} rows</div>
			${state.search ? `<div class="badge">Search: <strong>${escapeHtml(state.search)}</strong></div>` : ''}
			${state.llmResults.length ? `<div class="badge">LLM: ${state.llmResults.map((r) => escapeHtml(r)).join(', ')}</div>` : ''}
			${state.linkTypes.length ? `<div class="badge">Links: ${state.linkTypes.map((r) => escapeHtml(r)).join(', ')}</div>` : ''}
			<form class="replicate-form" method="post" data-confirm="Run the full cron job now?" data-confirm-cta="Yes, run it">
				<input type="hidden" name="action" value="run-cron" />
				<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
				<button class="danger" type="submit">Run Cron Processing</button>
			</form>
		</section>
		${groups.length ? renderGroups(groups, highlight, returnTo) : `<div class="empty">No results found for the selected filters.</div>`}
		<nav class="pagination">
			${renderPagerLink('Newer', `/llm-debug?${prevParams.toString()}`, pageMeta.hasPrev)}
			${renderPagerLink('Older', `/llm-debug?${nextParams.toString()}`, pageMeta.hasNext)}
		</nav>
		<dialog id="confirmDialog" class="confirm-dialog">
			<div class="confirm-inner">
				<h2>Are you sure?</h2>
				<p id="confirmDetail"></p>
			</div>
			<div class="confirm-actions">
				<button class="secondary" type="button" data-cancel>Cancel</button>
				<button class="confirm" type="button" data-confirm>Confirm</button>
			</div>
		</dialog>
	</main>
	<script>
		(() => {
			const dialog = document.getElementById('confirmDialog');
			if (!(dialog instanceof HTMLDialogElement)) return;

			const detail = document.getElementById('confirmDetail');
			const cancel = dialog.querySelector('[data-cancel]');
			const confirm = dialog.querySelector('[data-confirm]');
			let pendingForm = null;

			document.addEventListener(
				'submit',
				(e) => {
					const form = e.target;
					if (!(form instanceof HTMLFormElement)) return;
					const message = form.getAttribute('data-confirm');
					if (!message) return;
					const cta = form.getAttribute('data-confirm-cta');
					e.preventDefault();
					pendingForm = form;
					if (detail) detail.textContent = message;
					if (confirm instanceof HTMLButtonElement) confirm.textContent = cta || 'Confirm';
					dialog.showModal();
				},
				true
			);

			dialog.addEventListener('cancel', () => {
				pendingForm = null;
			});

			cancel?.addEventListener('click', () => {
				pendingForm = null;
				dialog.close();
			});

			confirm?.addEventListener('click', () => {
				const form = pendingForm;
				pendingForm = null;
				dialog.close();
				if (form) form.submit();
			});
		})();
	</script>
</body>
</html>`;
}

function renderCheckboxGroup<T extends string>(name: string, labelText: string, options: readonly T[], selected: readonly T[]): string {
	const set = new Set(selected);
	return `<div class="form-group">
	<label>${escapeHtml(labelText)}</label>
	<div class="checkbox-group">
		${options
			.map((opt) => {
				const id = `${name}-${opt}`;
				return `<label for="${escapeHtml(id)}"><input type="checkbox" id="${escapeHtml(id)}" name="${escapeHtml(
					name
				)}" value="${escapeHtml(opt)}"${set.has(opt) ? ' checked' : ''} /> ${escapeHtml(opt)}</label>`;
			})
			.join('')}
	</div>
</div>`;
}

function renderGroups(
	groups: Array<{ key: string | null; label: string; rows: LlmRow[] }>,
	highlight: HighlightConfig | null,
	returnTo: string
): string {
	return `<section class="groups">
	${groups
		.map(
			(group) => `<article class="group">
			<div class="group-header">${escapeHtml(group.label)}</div>
			<div class="group-items">
				${group.rows.map((row) => renderRow(row, highlight, returnTo)).join('')}
			</div>
		</article>`
		)
		.join('')}
</section>`;
}

function renderRow(row: LlmRow, highlight: HighlightConfig | null, returnTo: string): string {
	const isActive = row.link_type === 'active';
	const url = isActive ? buildSafeUrl(row.wiki_path) : '';
	const nameHtml = highlightText(row.name, highlight, '—');
	const wikiHtml = highlightText(row.wiki_path, highlight, '—');
	const ageHtml = row.age == null ? '—' : highlightText(row.age, highlight, '—');
	const descriptionHtml = highlightText(row.description, highlight, '—');
	const causeHtml = highlightText(row.cause, highlight, '—');
	const rejectionHtml = row.llm_rejection_reason ? highlightText(row.llm_rejection_reason, highlight, '—') : '';
	const llmLabel = toStr(row.llm_result || 'pending') || 'pending';
	const badgeClass = `badge-${sanitizeToken(llmLabel)}`;
	const llmTime = escapeHtml(formatFullDateTime(row.llm_date_time, 'Pending evaluation'));
	const createdTime = escapeHtml(formatFullDateTime(row.created_at, '—'));
	const nameBlock = isActive
		? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${nameHtml}</a>`
		: `<span class="name-disabled">${nameHtml}</span>`;
	const statusOptions = LLM_RESULT_OPTIONS.map(
		(opt) => `<option value="${escapeHtml(opt)}"${opt === llmLabel ? ' selected' : ''}>${escapeHtml(opt)}</option>`
	).join('');
	const ageValue = row.age == null ? '' : String(row.age);
	const descriptionValue = row.description ?? '';
	const causeValue = row.cause ?? '';

	return `<div class="result-card">
	<div class="result-main">
		<h3>${nameBlock}
			<span class="badge-pill ${badgeClass}">${escapeHtml(llmLabel)}</span>
		</h3>
		<div class="meta-grid">
			<div><strong>Wiki Path:</strong> ${wikiHtml}</div>
			<div><strong>Age:</strong> ${ageHtml}</div>
			<div><strong>Link Type:</strong> ${escapeHtml(row.link_type)}</div>
		</div>
	</div>
	<div class="meta-grid">
		<div><strong>Description:</strong> ${descriptionHtml}</div>
		<div><strong>Cause:</strong> ${causeHtml}</div>
		${rejectionHtml ? `<div><strong>Rejection Reason:</strong> ${rejectionHtml}</div>` : ''}
		<div><strong>LLM Timestamp:</strong> ${llmTime}</div>
		<div><strong>Created:</strong> ${createdTime}</div>
		<div class="result-actions">
			<details class="edit-panel">
				<summary>Update</summary>
				<form class="edit-form" method="post">
					<input type="hidden" name="action" value="update" />
					<input type="hidden" name="id" value="${row.id}" />
					<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
					<div class="edit-grid">
						<label>Status
							<select name="status">${statusOptions}</select>
						</label>
						<label>Age
							<input type="number" name="age" min="0" step="1" value="${escapeHtml(ageValue)}" />
						</label>
						<label>Cause
							<input type="text" name="cause" value="${escapeHtml(causeValue)}" />
						</label>
						<label>Description
							<textarea name="description">${escapeHtml(descriptionValue)}</textarea>
						</label>
					</div>
					<button class="apply" type="submit">Save Changes</button>
				</form>
			</details>
			<form class="replicate-form" method="post" data-confirm="Refresh via Replicate?" data-confirm-cta="Yes, refresh">
				<input type="hidden" name="action" value="replicate" />
				<input type="hidden" name="id" value="${row.id}" />
				<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
				<button class="secondary" type="submit">Refresh via Replicate</button>
				<span class="helper">Model: gpt-5-mini</span>
			</form>
		</div>
	</div>
</div>`;
}

function renderPagerLink(label: string, href: string, enabled: boolean): string {
	return `<a href="${escapeHtml(href)}" ${enabled ? '' : 'aria-disabled="true"'}>${escapeHtml(label)}</a>`;
}
