import type { Env } from '../types.ts';
import { buildSafeUrl, toStr } from '../utils/strings.ts';

type LlmRow = {
	id: number;
	name: string;
	wiki_path: string;
	link_type: 'active' | 'edit';
	age: number | null;
	description: string | null;
	cause: string | null;
	llm_result: string;
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

const PAGE_SIZES = [25, 50, 100] as const;
const LLM_RESULT_OPTIONS = ['pending', 'yes', 'no', 'skipped', 'error'];
const LINK_TYPE_OPTIONS: Array<'active' | 'edit'> = ['active', 'edit'];

export async function llmDebug(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const state = extractQueryState(url);

	const { sql, binds } = buildQuery(state);
	const res = await env.DB.prepare(sql).bind(...binds).all<LlmRow>();
	const rows = res.results || [];

	const total = rows.length;
	const hasNext = total > state.pageSize;
	const pageRows = rows.slice(0, state.pageSize);
	const hasPrev = state.page > 1;

	const groups = groupRows(pageRows);
	const html = renderPage(groups, state, { hasNext, hasPrev });

	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
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

	// Only fetch what we need: requested page size plus one extra row to know if there is another page.
	const limit = state.pageSize + 1;
	const offset = (state.page - 1) * state.pageSize;

	const sql = `SELECT id, name, wiki_path, link_type, age, description, cause, llm_result, llm_date_time, created_at
		FROM deaths
		${where.length ? `WHERE ${where.join(' AND ')}` : ''}
		ORDER BY COALESCE(llm_date_time, '') DESC, id DESC
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

function groupRows(rows: LlmRow[]): Array<{ key: string | null; label: string; rows: LlmRow[] }> {
	const groups: Array<{ key: string | null; label: string; rows: LlmRow[] }> = [];
	for (const row of rows) {
		const key = row.llm_date_time || null;
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
	if (!value) return 'Pending LLM evaluation';
	const date = parseUtcDate(value);
	if (!date) return value;
	return `${formatDate(date, { month: 'long', day: 'numeric', year: 'numeric' })} • ${formatTime(date, true)} UTC`;
}

function formatDate(date: Date, opts: { month: 'long' | 'short'; day: 'numeric'; year: 'numeric' }): string {
	const monthNames =
		opts.month === 'long'
			? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
			: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${monthNames[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')}, ${date.getUTCFullYear()}`;
}

function formatTime(date: Date, includeSeconds = false): string {
	const hours = String(date.getUTCHours()).padStart(2, '0');
	const minutes = String(date.getUTCMinutes()).padStart(2, '0');
	if (!includeSeconds) return `${hours}:${minutes}`;
	const seconds = String(date.getUTCSeconds()).padStart(2, '0');
	return `${hours}:${minutes}:${seconds}`;
}

function formatFullDateTime(value: string | null): string {
	if (!value) return '—';
	const date = parseUtcDate(value);
	if (!date) return value;
	return `${formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' })} ${formatTime(date, true)} UTC`;
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

function renderPage(groups: Array<{ key: string | null; label: string; rows: LlmRow[] }>, state: QueryState, pageMeta: { hasNext: boolean; hasPrev: boolean }) {
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
			--accent-soft: rgba(36, 87, 245, 0.1);
			--success: #1f9d67;
			--danger: #d6455d;
			--warning: #c37b16;
		}
		* { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 16px/1.5 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
		a { color: var(--accent); text-decoration: none; }
		a:hover { text-decoration: underline; }
		header { padding: 24px 32px; border-bottom: 1px solid var(--border); backdrop-filter: blur(12px); position: sticky; top: 0; background: rgba(245,247,251,0.92); z-index: 10; }
		.container { max-width: 1240px; margin: 0 auto; padding: 24px 32px 60px; }
		h1 { margin: 0; font-size: 1.9rem; font-weight: 700; }
		.subtitle { color: var(--muted); margin-top: 4px; }
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
		.group-header { padding: 18px 24px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, rgba(36, 87, 245, 0.08), rgba(87, 143, 255, 0.08)); font-weight: 600; font-size: 1rem; }
		.group-items { display: flex; flex-direction: column; gap: 12px; padding: 18px 24px 24px; }
		.result-card { padding: 16px 20px; border: 1px solid var(--border); border-radius: 14px; background: var(--panel-alt); display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
		.result-main { display: flex; flex-direction: column; gap: 6px; }
		.result-main h3 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 10px; }
		.result-main h3 a { font-weight: 700; color: var(--text); }
		.result-main h3 span.name-disabled { font-weight: 700; color: var(--muted); }
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
		@media (max-width: 720px) {
			header, .container { padding: 18px 16px; }
			form.filters { grid-template-columns: 1fr; }
			.result-card { grid-template-columns: 1fr; }
		}
	</style>
</head>
<body>
	<header>
		<h1>LLM Evaluation Debug</h1>
		<p class="subtitle">Inspect Replicate results for parsed Wikipedia entries, grouped by evaluation timestamp.</p>
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
		<section class="summary">
			<div class="badge">Page ${state.page}</div>
			<div class="badge">Showing ${groups.reduce((acc, g) => acc + g.rows.length, 0)} of ${state.pageSize} rows</div>
			${
				state.search
					? `<div class="badge">Search: <strong>${escapeHtml(state.search)}</strong></div>`
					: ''
			}
			${state.llmResults.length ? `<div class="badge">LLM: ${state.llmResults.map((r) => escapeHtml(r)).join(', ')}</div>` : ''}
			${state.linkTypes.length ? `<div class="badge">Links: ${state.linkTypes.map((r) => escapeHtml(r)).join(', ')}</div>` : ''}
		</section>
		${groups.length ? renderGroups(groups) : `<div class="empty">No results found for the selected filters.</div>`}
		<nav class="pagination">
			${renderPagerLink('Newer', `/llm-debug?${prevParams.toString()}`, pageMeta.hasPrev)}
			${renderPagerLink('Older', `/llm-debug?${nextParams.toString()}`, pageMeta.hasNext)}
		</nav>
	</main>
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

function renderGroups(groups: Array<{ key: string | null; label: string; rows: LlmRow[] }>): string {
	return `<section class="groups">
	${groups
		.map(
			(group) => `<article class="group">
			<div class="group-header">${escapeHtml(group.label)}</div>
			<div class="group-items">
				${group.rows.map(renderRow).join('')}
			</div>
		</article>`
		)
		.join('')}
</section>`;
}

function renderRow(row: LlmRow): string {
	const isActive = row.link_type === 'active';
	const url = isActive ? buildSafeUrl(row.wiki_path) : '';
	const badgeClass = `badge-${escapeHtml((row.llm_result || 'pending').toLowerCase())}`;
	return `<div class="result-card">
	<div class="result-main">
		<h3>${isActive ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a>` : `<span class="name-disabled">${escapeHtml(row.name)}</span>`}
			<span class="badge-pill ${badgeClass}">${escapeHtml(row.llm_result || 'pending')}</span>
		</h3>
		<div class="meta-grid">
			<div><strong>Wiki Path:</strong> ${escapeHtml(row.wiki_path)}</div>
			<div><strong>Age:</strong> ${row.age == null ? '—' : escapeHtml(String(row.age))}</div>
			<div><strong>Link Type:</strong> ${escapeHtml(row.link_type)}</div>
		</div>
	</div>
	<div class="meta-grid">
		<div><strong>Description:</strong> ${row.description ? escapeHtml(row.description) : '—'}</div>
		<div><strong>Cause:</strong> ${row.cause ? escapeHtml(row.cause) : '—'}</div>
		<div><strong>LLM Timestamp:</strong> ${escapeHtml(formatFullDateTime(row.llm_date_time))}</div>
		<div><strong>Created:</strong> ${escapeHtml(formatFullDateTime(row.created_at))}</div>
	</div>
</div>`;
}

function renderPagerLink(label: string, href: string, enabled: boolean): string {
	return `<a href="${escapeHtml(href)}" ${enabled ? '' : 'aria-disabled="true"'}>${escapeHtml(label)}</a>`;
}
