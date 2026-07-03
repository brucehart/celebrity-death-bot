import { TZ } from '../config.ts';
import type { DeathEntry } from '../types.ts';
import { dedupeSpaces, stripTags } from '../utils/strings.ts';

// Current year in America/New_York timezone; Wikipedia pages are per-year/month.
export const toNYYear = () =>
	Number(
		new Date().toLocaleString('en-US', {
			timeZone: TZ,
			year: 'numeric',
		}),
	);

type ParseWikipediaOptions = {
	monthName?: string;
};

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMonthSection(html: string, monthName?: string): string {
	const normalizedMonth = String(monthName || '').trim();
	if (!normalizedMonth) return html;

	const monthHeading = new RegExp(`<h2\\b[^>]*\\bid=["']${escapeRegExp(normalizedMonth)}["'][^>]*>`, 'i');
	const match = monthHeading.exec(html);
	if (!match) return html;

	const start = match.index;
	const rest = html.slice(start + match[0].length);
	const nextHeading = rest.search(/<h2\b/i);
	return nextHeading >= 0 ? html.slice(start, start + match[0].length + nextHeading) : html.slice(start);
}

function extractWikiPath(href: string): { wikiPath: string; linkType: 'active' | 'edit' } | null {
	try {
		const url = new URL(href, 'https://en.wikipedia.org/wiki/');
		const isWikipedia = url.hostname === 'en.wikipedia.org';
		if (!isWikipedia) return null;

		if (url.pathname === '/w/index.php') {
			const title = url.searchParams.get('title') || '';
			if (!title) return null;
			return {
				wikiPath: title,
				linkType: url.searchParams.get('redlink') || url.searchParams.get('action') === 'edit' ? 'edit' : 'active',
			};
		}

		if (url.pathname.startsWith('/wiki/')) {
			const wikiPath = url.pathname.replace(/^\/wiki\//, '');
			if (!wikiPath || wikiPath.includes(':')) return null;
			return {
				wikiPath,
				linkType: url.searchParams.get('redlink') || url.searchParams.get('action') === 'edit' ? 'edit' : 'active',
			};
		}
	} catch {
		// Fall through to legacy handling below.
	}

	if (href.startsWith('/wiki/')) {
		return {
			wikiPath: href.replace(/^\/wiki\//, ''),
			linkType: 'active',
		};
	}

	return null;
}

// Parse a simplified subset of Wikipedia's "Deaths in <Year>" / monthly HTML.
// Expected pattern per <li>:
//   <li><a href="/wiki/Person">Person</a>, <age>, <description>.</li>
// Additionally handle red links where there is no page yet:
//   <a href="/w/index.php?title=Starling_Lawrence&amp;action=edit&amp;redlink=1">Starling Lawrence</a>
// We store only the Wikipedia ID in wiki_path (e.g., "Starling_Lawrence" or "Greg_O%27Connell")
// and track link_type as 'active' (has page) or 'edit' (red link).
export function parseWikipedia(html: string, opts?: ParseWikipediaOptions): DeathEntry[] {
	const results: DeathEntry[] = [];
	const scoped = extractMonthSection(html, opts?.monthName);
	const sanitized = scoped.replace(/<sup[^>]*>.*?<\/sup>/gis, '');
	const liMatches = sanitized.matchAll(/<li\b[^>]*>(.*?)<\/li>/gis);
	for (const m of liMatches) {
		const li = m[1];
		const a = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(li);
		if (!a) continue;

		// href may contain HTML entities (&amp;). Normalize so URL parsing works.
		const href = a[1].replace(/&amp;/gi, '&');
		const personName = dedupeSpaces(stripTags(a[2]));
		const afterAnchor = li.slice(a.index! + a[0].length);
		const afterText = dedupeSpaces(stripTags(afterAnchor));
		const m2 = /^,\s*(\d{1,3})\s*,\s*(.*?)(?:\.\s*)?$/.exec(afterText);
		if (!m2) continue;
		const ageNum = Number(m2[1]);
		const rest = m2[2] || '';

		const description: string | null = dedupeSpaces(rest) || null;
		const cause: string | null = null;
		if (!personName || Number.isNaN(ageNum)) continue;

		// Determine Wikipedia ID and link type
		const wiki = extractWikiPath(href);
		if (!wiki) continue;

		if (!wiki.wikiPath) continue;

		results.push({
			name: personName,
			wiki_path: wiki.wikiPath,
			link_type: wiki.linkType,
			age: ageNum,
			description,
			cause,
		});
	}
	return results;
}
