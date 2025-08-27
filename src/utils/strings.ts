export const dedupeSpaces = (s: string) => s.replace(/\s+/g, ' ').trim();

export const stripTags = (html: string) => html.replace(/<sup[^>]*>.*?<\/sup>/gsi, '').replace(/<[^>]+>/g, '');

export const toStr = (v: unknown): string => {
  if (v == null) return '';
  const s = String(v).trim();
  return s === 'null' || s === 'undefined' ? '' : s;
};

// Build a canonical Wikipedia article URL from a stored article ID.
// Accepts raw IDs like "Greg_O%27Connell" or paths like "/wiki/Greg_O%27Connell".
export function buildSafeUrl(wikiPath: string): string {
  try {
    if (typeof wikiPath === 'string' && wikiPath.trim()) {
      const id = wikiPath.replace(/^\/*wiki\//, '');
      return new URL(`https://en.wikipedia.org/wiki/${id}`).href;
    }
    return '';
  } catch {
    return '';
  }
}
