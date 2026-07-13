import type { DeathEntry, Env } from '../types.ts';
import { extractAndParseJSON, normalizeToArray, isObject } from '../utils/json.ts';
import { toStr } from '../utils/strings.ts';
import { markDeathsAsError, markDeathsAsNo, selectDeathsByWikiPaths, updateDeathLLM } from './db.ts';
import { buildTelegramMessage, notifyTelegram } from './telegram.ts';
import { buildXStatus, postToXIfConfigured, shouldIncludeWikipediaLinkInXPost } from './x.ts';

type SelectedRejected = {
	selected?: Array<Record<string, unknown>>;
	rejected?: Array<Record<string, unknown> | string>;
};

type Rejection = { wiki_path: string; reason?: string | null };

const MAX_REASON_CHARS = 200;

function normalizeRejected(raw: SelectedRejected['rejected'], candidateMap: Map<string, string>): Rejection[] {
	const out: Rejection[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item === 'string') {
				const wiki_path = resolveWikiPath(item, candidateMap);
				if (wiki_path) out.push({ wiki_path, reason: null });
				continue;
			}
			if (isObject(item)) {
				const wiki_path = readWikiPath(item, candidateMap);
				if (!wiki_path) continue;
				const reason = sanitizeReason((item as any)['reason']);
				out.push({ wiki_path, reason });
			}
		}
	} else if (isObject(raw)) {
		const wiki_path = readWikiPath(raw, candidateMap);
		if (wiki_path) {
			const reason = sanitizeReason((raw as any)['reason']);
			out.push({ wiki_path, reason });
		}
	}
	return out;
}

function sanitizeReason(value: unknown): string | null {
	const raw = toStr(value);
	if (!raw) return null;
	const trimmed = raw.replace(/\s+/g, ' ').trim();
	if (!trimmed) return null;
	return trimmed.slice(0, MAX_REASON_CHARS);
}

function normalizeWikiPath(value: unknown): string {
	const raw = toStr(value);
	if (!raw) return '';
	let candidate = raw.trim();
	if (!candidate) return '';
	try {
		if (/^https?:\/\//i.test(candidate)) {
			const url = new URL(candidate);
			candidate = `${url.pathname}${url.search}`;
		}
	} catch {}
	const wikiMatch = /\/wiki\/([^?#]+)/.exec(candidate);
	if (wikiMatch) return wikiMatch[1];
	const titleMatch = /[?&]title=([^&#]+)/.exec(candidate);
	if (titleMatch) return titleMatch[1];
	return candidate.replace(/^\/+wiki\//, '').trim();
}

function addWikiPathMapping(map: Map<string, string>, key: string, value: string) {
	const trimmed = key.trim();
	if (!trimmed || map.has(trimmed)) return;
	map.set(trimmed, value);
}

function addWikiPathAliases(map: Map<string, string>, raw: string, canonical: string): void {
	const base = normalizeWikiPath(raw);
	if (!base) return;
	addWikiPathMapping(map, base, canonical);
	addWikiPathMapping(map, base.replace(/\s+/g, '_'), canonical);
	addWikiPathMapping(map, base.replace(/_/g, ' '), canonical);
	try {
		const decoded = decodeURIComponent(base);
		addWikiPathMapping(map, decoded, canonical);
		addWikiPathMapping(map, decoded.replace(/\s+/g, '_'), canonical);
		addWikiPathMapping(map, decoded.replace(/_/g, ' '), canonical);
		addWikiPathMapping(map, encodeURIComponent(decoded.replace(/\s+/g, '_')), canonical);
	} catch {}
}

function buildWikiPathMap(paths: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const raw of paths) {
		const base = normalizeWikiPath(raw);
		if (!base) continue;
		addWikiPathAliases(map, raw, base);
	}
	return map;
}

function resolveWikiPath(value: unknown, map: Map<string, string>): string {
	const normalized = normalizeWikiPath(value);
	if (!normalized) return '';
	const direct = map.get(normalized);
	if (direct) return direct;
	const spaced = normalized.replace(/_/g, ' ');
	const spacedHit = map.get(spaced);
	if (spacedHit) return spacedHit;
	const underscored = normalized.replace(/\s+/g, '_');
	const underscoredHit = map.get(underscored);
	if (underscoredHit) return underscoredHit;
	try {
		const decoded = decodeURIComponent(normalized);
		const decodedHit = map.get(decoded);
		if (decodedHit) return decodedHit;
		const decodedUnderscore = decoded.replace(/\s+/g, '_');
		const decodedUnderscoreHit = map.get(decodedUnderscore);
		if (decodedUnderscoreHit) return decodedUnderscoreHit;
		const encoded = encodeURIComponent(decodedUnderscore);
		const encodedHit = map.get(encoded);
		if (encodedHit) return encodedHit;
	} catch {}
	return '';
}

function readWikiPath(item: Record<string, unknown>, map: Map<string, string>): string {
	const raw = item['wiki_path'] ?? item['wikiPath'] ?? item['wiki_id'] ?? item['wikiId'] ?? item['wiki'];
	return resolveWikiPath(raw, map);
}

export function extractWikiPathsFromPrompt(prompt: string): string[] {
	const m = /Input \(each line:[\s\S]*?----\n([\s\S]*?)\n----/m.exec(prompt);
	if (!m || !m[1]) return [];
	return m[1]
		.split(/\n\n+/)
		.map((line) => line.trim())
		.map((line) => line.split(',').pop() || '')
		.map((s) => s.trim())
		.filter((path) => path.length > 0 && path.length <= 512)
		.slice(0, 400);
}

export function extractCandidatePathsFromReplicatePayload(payload: any): string[] {
	const fromMeta = Array.isArray(payload?.metadata?.candidates) ? payload.metadata.candidates : [];
	const metaPaths = fromMeta
		.map((s: unknown) => String(s || '').trim())
		.filter((path: string) => path.length > 0 && path.length <= 512)
		.slice(0, 400);
	if (metaPaths.length) return metaPaths;
	const prompt = payload?.input?.prompt;
	if (typeof prompt !== 'string') return [];
	return extractWikiPathsFromPrompt(prompt);
}

export async function applyLlmOutput(env: Env, outputText: string, candidatePaths: string[]) {
	const candidates = Array.from(
		new Set(
			(candidatePaths || [])
				.map((s) => String(s || '').trim())
				.filter((path) => path.length > 0 && path.length <= 512)
				.slice(0, 400),
		),
	);
	if (!candidates.length) throw new Error('LLM result has no trusted candidate set');

	const canonicalRows = await selectDeathsByWikiPaths(env, candidates);
	if (!canonicalRows.length) {
		await markDeathsAsError(env, candidates);
		return { notified: 0, rejected: 0, errored: candidates.length } as const;
	}
	const candidateMap = buildWikiPathMap(canonicalRows.map((row) => row.wiki_path));
	for (const candidate of candidates) {
		const canonical = resolveWikiPath(candidate, candidateMap);
		if (canonical) addWikiPathAliases(candidateMap, candidate, canonical);
	}
	const rowsByPath = new Map<string, DeathEntry>(canonicalRows.map((row) => [row.wiki_path, row]));
	const joined = outputText.trim();
	if (!joined) {
		await markDeathsAsError(env, candidates);
		return { notified: 0, rejected: 0, errored: candidates.length } as const;
	}

	const parsed = extractAndParseJSON(joined);
	if (parsed == null) {
		console.warn('LLM output was not valid JSON:', joined.slice(0, 500));
		await markDeathsAsError(env, candidates);
		return { notified: 0, rejected: 0, errored: candidates.length } as const;
	}

	let selectedItems: Array<Record<string, unknown>> = [];
	let rejectedItems: Rejection[] = [];

	if (Array.isArray(parsed)) {
		selectedItems = normalizeToArray(parsed);
	} else if (isObject(parsed)) {
		const parsedObj = parsed as SelectedRejected;
		if ('selected' in parsedObj || 'rejected' in parsedObj) {
			selectedItems = normalizeToArray(parsedObj.selected);
			rejectedItems = normalizeRejected(parsedObj.rejected, candidateMap);
		} else {
			selectedItems = normalizeToArray(parsed);
		}
	}

	let notified = 0;
	const selectedPaths = Array.from(new Set(selectedItems.map((item) => readWikiPath(item, candidateMap)).filter(Boolean)));
	for (const wikiPath of selectedPaths) {
		const row = rowsByPath.get(wikiPath);
		if (!row) continue;
		const msg = buildTelegramMessage(row);
		await notifyTelegram(env, msg);
		const xText = buildXStatus(row, { includeWikipediaLink: shouldIncludeWikipediaLinkInXPost(env) });
		await postToXIfConfigured(env, xText);
		notified++;
		await updateDeathLLM(env, row.wiki_path, row.cause, row.description);
	}

	let rejected = 0;
	if (rejectedItems.length) {
		const selectedSet = new Set(selectedPaths);
		const rejectedByPath = new Map<string, Rejection>();
		for (const item of rejectedItems) if (!selectedSet.has(item.wiki_path)) rejectedByPath.set(item.wiki_path, item);
		const filtered = Array.from(rejectedByPath.values());
		await markDeathsAsNo(env, filtered);
		rejected = filtered.length;
	}

	return { notified, rejected, errored: 0 } as const;
}
