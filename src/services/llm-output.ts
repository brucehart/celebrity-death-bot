import type { Env } from '../types.ts';
import { extractAndParseJSON, normalizeToArray, isObject } from '../utils/json.ts';
import { toStr } from '../utils/strings.ts';
import { getLinkTypeMap, markDeathsAsError, markDeathsAsNo, updateDeathLLM } from './db.ts';
import { buildTelegramMessage, notifyTelegram } from './telegram.ts';
import { buildXStatus, postToXIfConfigured } from './x.ts';

type SelectedRejected = {
	selected?: Array<Record<string, unknown>>;
	rejected?: Array<Record<string, unknown> | string>;
};

type Rejection = { wiki_path: string; reason?: string | null };

const MAX_REASON_CHARS = 200;

function normalizeRejected(raw: SelectedRejected['rejected'], candidateMap: Map<string, string> | null): Rejection[] {
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

function buildWikiPathMap(paths: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const raw of paths) {
		const base = normalizeWikiPath(raw);
		if (!base) continue;
		addWikiPathMapping(map, base, base);
		addWikiPathMapping(map, base.replace(/\s+/g, '_'), base);
		addWikiPathMapping(map, base.replace(/_/g, ' '), base);
		try {
			const decoded = decodeURIComponent(base);
			addWikiPathMapping(map, decoded, base);
			addWikiPathMapping(map, decoded.replace(/\s+/g, '_'), base);
			addWikiPathMapping(map, decoded.replace(/_/g, ' '), base);
			addWikiPathMapping(map, encodeURIComponent(decoded.replace(/\s+/g, '_')), base);
		} catch {}
	}
	return map;
}

function resolveWikiPath(value: unknown, map: Map<string, string> | null): string {
	const normalized = normalizeWikiPath(value);
	if (!normalized) return '';
	if (!map || map.size === 0) return normalized;
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
	return normalized;
}

function readWikiPath(item: Record<string, unknown>, map: Map<string, string> | null): string {
	const raw =
		item['wiki_path'] ??
		item['wikiPath'] ??
		item['wiki_id'] ??
		item['wikiId'] ??
		item['wiki'];
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
		.filter(Boolean);
}

export function extractCandidatePathsFromReplicatePayload(payload: any): string[] {
	const fromMeta = Array.isArray(payload?.metadata?.candidates) ? payload.metadata.candidates : [];
	const metaPaths = fromMeta.map((s: unknown) => String(s || '').trim()).filter(Boolean);
	if (metaPaths.length) return metaPaths;
	const prompt = payload?.input?.prompt;
	if (typeof prompt !== 'string') return [];
	return extractWikiPathsFromPrompt(prompt);
}

export async function applyLlmOutput(env: Env, outputText: string, candidatePaths: string[]) {
	const candidates = (candidatePaths || []).map((s) => String(s || '').trim()).filter(Boolean);
	const candidateMap = candidates.length ? buildWikiPathMap(candidates) : null;
	const joined = outputText.trim();
	if (!joined) {
		if (candidates.length) await markDeathsAsError(env, candidates);
		return { notified: 0, rejected: 0, errored: candidates.length } as const;
	}

	const parsed = extractAndParseJSON(joined);
	if (parsed == null) {
		console.warn('LLM output was not valid JSON:', joined.slice(0, 500));
		if (candidates.length) await markDeathsAsError(env, candidates);
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
	if (selectedItems.length) {
		const selectedPaths: string[] = selectedItems.map((it) => readWikiPath(it, candidateMap)).filter(Boolean);
		const linkTypeMap = selectedPaths.length ? await getLinkTypeMap(env, selectedPaths) : {};
		for (const it of selectedItems) {
			const name = toStr(it['name']);
			if (!name) continue;
			const age = toStr(it['age']);
			const desc = toStr(it['description']);
			const cause = toStr(it['cause of death'] ?? it['cause_of_death'] ?? (it as any).causeOfDeath ?? it['cause']);
			const wiki_path = readWikiPath(it, candidateMap);
			const link_type = wiki_path ? (linkTypeMap[wiki_path] || 'active') : 'active';

			const msg = buildTelegramMessage({ name, age, description: desc, cause, wiki_path, link_type });
			await notifyTelegram(env, msg);
			const xText = buildXStatus({ name, age, description: desc, cause, wiki_path, link_type });
			await postToXIfConfigured(env, xText);
			notified++;

			if (wiki_path) {
				await updateDeathLLM(env, wiki_path, cause, desc);
			}
		}
	}

	if (rejectedItems.length) {
		const selectedSet = new Set(selectedItems.map((it) => readWikiPath(it, candidateMap)).filter(Boolean));
		const filtered = rejectedItems.filter((item) => !selectedSet.has(item.wiki_path));
		await markDeathsAsNo(env, filtered);
	}

	return { notified, rejected: rejectedItems.length, errored: 0 } as const;
}
