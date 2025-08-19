export const dedupeSpaces = (s: string) => s.replace(/\s+/g, ' ').trim();

export const stripTags = (html: string) => html.replace(/<sup[^>]*>.*?<\/sup>/gsi, '').replace(/<[^>]+>/g, '');

export const toStr = (v: unknown): string => {
  if (v == null) return '';
  const s = String(v).trim();
  return s === 'null' || s === 'undefined' ? '' : s;
};

export const makeWikiUrl = (path: string) => (path.startsWith('http') ? path : `https://en.wikipedia.org${path}`);

