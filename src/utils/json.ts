// Utilities for extracting and handling JSON from LLM outputs

export function stripCodeFences(s: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const m = s.match(fence);
  return m ? m[1] : s;
}

export function extractAndParseJSON(s: string): any | null {
  const trimmed = stripCodeFences(s).trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const slice = trimmed.slice(objStart, objEnd + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    const slice = trimmed.slice(arrStart, arrEnd + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  return null;
}

export const isObject = (x: any): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function normalizeToArray(parsed: any): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed.filter(isObject);
  if (isObject(parsed)) {
    return Object.keys(parsed).length ? [parsed] : [];
  }
  return [];
}

export function coalesceOutput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return flattenStrings(raw).join('');
  return '';
}

function flattenStrings(x: unknown): string[] {
  if (typeof x === 'string') return [x];
  if (Array.isArray(x)) {
    const out: string[] = [];
    for (const el of x) out.push(...flattenStrings(el));
    return out;
  }
  return [];
}

