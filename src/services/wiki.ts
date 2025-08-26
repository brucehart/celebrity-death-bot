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
// Additionally handle red links where there is no page yet:
//   <a href="/w/index.php?title=Starling_Lawrence&amp;action=edit&amp;redlink=1">Starling Lawrence</a>
// We store only the Wikipedia ID in wiki_path (e.g., "Starling_Lawrence" or "Greg_O%27Connell")
// and track link_type as 'active' (has page) or 'edit' (red link).
export function parseWikipedia(html: string): DeathEntry[] {
  const results: DeathEntry[] = [];
  const sanitized = html.replace(/<sup[^>]*>.*?<\/sup>/gsi, '');
  const liMatches = sanitized.matchAll(/<li>(.*?)<\/li>/gsi);
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
    let wikiPath = '';
    let linkType: 'active' | 'edit' = 'active';
    try {
      if (href.startsWith('/wiki/')) {
        // Actual article link; strip prefix, keep percent-encoding
        wikiPath = href.replace(/^\/wiki\//, '');
        linkType = 'active';
      } else if (href.startsWith('/w/index.php')) {
        // Edit/redlink; extract title query param
        const url = new URL(href, 'https://en.wikipedia.org');
        const title = url.searchParams.get('title') || '';
        if (title) {
          wikiPath = title; // already uses underscores; keep as-is
          linkType = url.searchParams.get('redlink') ? 'edit' : 'active';
        }
      }
    } catch {
      // fallback; detect redlink by param
      wikiPath = href;
      linkType = href.includes('redlink=1') ? 'edit' : 'active';
    }

    if (!wikiPath) continue;

    results.push({
      name: personName,
      wiki_path: wikiPath,
      link_type: linkType,
      age: ageNum,
      description,
      cause,
    });
  }
  return results;
}

