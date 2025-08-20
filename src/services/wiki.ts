import { TZ } from '../config.ts';
import type { DeathEntry } from '../types.ts';
import { dedupeSpaces, stripTags } from '../utils/strings.ts';

// Current year in America/New_York timezone; Wikipedia pages are per-year/month.
export const toNYYear = () =>
	Number(
		new Date().toLocaleString('en-US', {
			timeZone: TZ,
			year: 'numeric',
		})
	);

// Parse a simplified subset of Wikipedia's "Deaths in <Year>" HTML.
// Expected pattern per <li>:
//   <li><a href="/wiki/Person">Person</a>, <age>, <description>.</li>
// We intentionally keep this tolerant and avoid heavy DOM parsing for size/perf.
export function parseWikipedia(html: string): DeathEntry[] {
	const results: DeathEntry[] = [];
	const sanitized = html.replace(/<sup[^>]*>.*?<\/sup>/gsi, '');
	const liMatches = sanitized.matchAll(/<li>(.*?)<\/li>/gsi);
	for (const m of liMatches) {
		const li = m[1];
		const a = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(li);
		if (!a) continue;

		const href = a[1];
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

		results.push({
			name: personName,
			wiki_path: href,
			age: ageNum,
			description,
			cause,
		});
	}
	return results;
}
