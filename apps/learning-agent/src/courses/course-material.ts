import { readManifestAsync } from "../memory/l2/manifest-store.js";
import { parseFrontmatter } from "../memory/l2/wiki-maintainer.js";
import type { L2SearchResult } from "../memory/l2/l2-search.js";
import type { ManifestEntry } from "../memory/l2/types.js";
import { readTextAsync } from "../storage/file-store.js";
import { resolveContainedPathAsync } from "../utils/path-safety.js";

/**
 * E4.3b — bounded course material for plan generation.
 *
 * The generator never receives a whole textbook. This module walks only the
 * active sources of one course, keeps the real locator of every passage, and
 * returns a small, explicitly counted candidate set (24 units by default).
 * Every unit carries the exact excerpt the model may cite; a citation that is
 * not one of these units is rejected later, which is what makes fabricated
 * chapters/pages impossible to store.
 *
 * Reading order is the fallback, not the ranking: when the course index is
 * available, passages that actually match the course goals come first. A
 * search failure is reported, never disguised as "no material".
 */

export const MAX_MATERIAL_SOURCES = 12;
export const MAX_SOURCE_PASSAGES = 60;
export const MAX_CONSIDERED_PASSAGES = 240;
export const MAX_MATERIAL_UNITS = 24;
export const MAX_UNIT_EXCERPT_CHARS = 500;
export const MAX_TOC_ENTRIES = 60;

export interface CourseMaterialUnit {
	unit_id: string;
	source_id: string;
	source_title: string;
	page_path: string;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
	ordinal: number;
	excerpt: string;
}

export interface CourseMaterialSource {
	source_id: string;
	title: string;
	passage_count: number;
}

export interface CourseMaterialTocEntry {
	source_id: string;
	source_title: string;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
}

export type CourseMaterialStatus = "ok" | "no_material" | "unavailable";

export interface CourseMaterialResult {
	status: CourseMaterialStatus;
	units: CourseMaterialUnit[];
	toc: CourseMaterialTocEntry[];
	sources: CourseMaterialSource[];
	/** How many passages existed in scope before truncation. */
	considered_passages: number;
	/** True when the unit set is a subset of what the course actually contains. */
	truncated: boolean;
	retrieval: "ok" | "unsupported" | "failed";
	/** True when some source pages could not be read; never hidden. */
	partial: boolean;
	/** Content/version marker for every source considered; part of the plan fingerprint. */
	material_version: string;
}

interface PassageMeta {
	source_id: string;
	source_title: string;
	page_path: string;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
	ordinal: number;
	text: string;
}

export interface CollectCourseMaterialOptions {
	l2DataDir: string;
	courseTitle: string;
	goalTitles: readonly string[];
	/** Learner-declared background; used only as a retrieval hint. */
	focus?: string;
	/** Active source bindings of the course — the only readable scope. */
	sourceIds: readonly string[];
	/** Scoped search; `null` when L2 retrieval is disabled. */
	search: ((query: string, options?: { sourceIds?: readonly string[] }) => Promise<L2SearchResult[] | null>) | null;
	maxUnits?: number;
}

function excerptOf(body: string): string {
	const collapsed = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (collapsed.length <= MAX_UNIT_EXCERPT_CHARS) return collapsed;
	return `${collapsed.slice(0, MAX_UNIT_EXCERPT_CHARS).trimEnd()}…`;
}

async function readPassages(
	l2DataDir: string,
	entry: ManifestEntry,
): Promise<{ passages: PassageMeta[]; partial: boolean }> {
	const paths = (entry.passagePages ?? []).slice(0, MAX_SOURCE_PASSAGES);
	const passages: PassageMeta[] = [];
	let partial = (entry.passagePages?.length ?? 0) > paths.length;
	for (const path of paths) {
		const absolute = await resolveContainedPathAsync(l2DataDir, path);
		if (!absolute) {
			partial = true;
			continue;
		}
		const content = await readTextAsync(absolute, "").catch(() => "");
		if (!content) {
			partial = true;
			continue;
		}
		const parsed = parseFrontmatter(content);
		const passage = parsed.frontmatter?.passage;
		// A page whose locator does not name this source is not usable material:
		// attaching its text to this source would invent provenance.
		if (!passage || passage.source_id !== entry.id) {
			partial = true;
			continue;
		}
		passages.push({
			source_id: entry.id,
			source_title: entry.title,
			page_path: path,
			...(passage.heading_path ? { heading_path: passage.heading_path } : {}),
			...(passage.page_start !== undefined ? { page_start: passage.page_start } : {}),
			...(passage.page_end !== undefined ? { page_end: passage.page_end } : {}),
			ordinal: passage.ordinal,
			text: excerptOf(parsed.body),
		});
	}
	return { passages, partial };
}

function tocOf(passages: readonly PassageMeta[]): CourseMaterialTocEntry[] {
	const entries: CourseMaterialTocEntry[] = [];
	const seen = new Set<string>();
	for (const passage of [...passages].sort((a, b) => a.source_id.localeCompare(b.source_id)
		|| a.ordinal - b.ordinal)) {
		const key = `${passage.source_id}\u0000${passage.heading_path ?? ""}\u0000${passage.page_start ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({
			source_id: passage.source_id,
			source_title: passage.source_title,
			...(passage.heading_path ? { heading_path: passage.heading_path } : {}),
			...(passage.page_start !== undefined ? { page_start: passage.page_start } : {}),
			...(passage.page_end !== undefined ? { page_end: passage.page_end } : {}),
		});
		if (entries.length >= MAX_TOC_ENTRIES) break;
	}
	return entries;
}

/**
 * Collect material for one course. Returns `no_material` when the course has
 * no usable indexed source, `unavailable` when the manifest itself cannot be
 * read (the caller must not report that as "no material").
 */
export async function collectCourseMaterial(options: CollectCourseMaterialOptions): Promise<CourseMaterialResult> {
	const empty: CourseMaterialResult = {
		status: "no_material",
		units: [],
		toc: [],
		sources: [],
		considered_passages: 0,
		truncated: false,
		retrieval: "unsupported",
		partial: false,
		material_version: "",
	};
	if (options.sourceIds.length === 0) return empty;

	let manifest: ManifestEntry[];
	try {
		manifest = await readManifestAsync(options.l2DataDir);
	} catch {
		return { ...empty, status: "unavailable" };
	}
	const allowed = new Set(options.sourceIds);
	const entries = manifest
		.filter((entry) => allowed.has(entry.id) && entry.status === "indexed")
		.slice(0, MAX_MATERIAL_SOURCES);
	if (entries.length === 0) return empty;

	const sources: CourseMaterialSource[] = entries.map((entry) => ({
		source_id: entry.id,
		title: entry.title,
		passage_count: entry.passageCount ?? entry.passagePages?.length ?? 0,
	}));
	// A plan must not be reused after the underlying material changed. The
	// fingerprint sees content hash + manifest update time, not only the ids.
	const materialVersion = entries
		.map((entry) => `${entry.id}:${entry.contentHash}:${entry.updatedAt}:${entry.passageCount ?? entry.passagePages?.length ?? 0}`)
		.sort()
		.join("|");

	const passages: PassageMeta[] = [];
	let partial = false;
	for (const entry of entries) {
		const read = await readPassages(options.l2DataDir, entry);
		partial = partial || read.partial;
		passages.push(...read.passages);
		if (passages.length >= MAX_CONSIDERED_PASSAGES) break;
	}
	if (passages.length === 0) {
		return { ...empty, status: "no_material", sources, partial, material_version: materialVersion };
	}

	const considered = passages.slice(0, MAX_CONSIDERED_PASSAGES);
	const byPath = new Map(considered.map((passage, index) => [passage.page_path, index]));
	const chosen: number[] = [];
	const seen = new Set<number>();
	let retrieval: CourseMaterialResult["retrieval"] = options.search ? "ok" : "unsupported";
	const queries = [options.courseTitle, ...options.goalTitles.slice(0, 3), ...(options.focus ? [options.focus] : [])]
		.map((query) => query.trim())
		.filter((query) => query.length > 0);
	if (options.search) {
		for (const query of queries) {
			let hits: L2SearchResult[] | null = null;
			try {
				hits = await options.search(query, { sourceIds: options.sourceIds });
			} catch {
				retrieval = "failed";
				break;
			}
			if (hits === null) {
				retrieval = "failed";
				break;
			}
			for (const hit of hits) {
				const index = byPath.get(hit.path);
				if (index === undefined || seen.has(index)) continue;
				seen.add(index);
				chosen.push(index);
				if (chosen.length >= 10) break;
			}
			if (chosen.length >= 10) break;
		}
	}

	// Reading order fills the rest: a short document is fully available, and a
	// long one is a bounded, disclosed sample rather than "the textbook".
	const ordered = [...considered]
		.map((passage, index) => ({ passage, index }))
		.sort((a, b) => a.passage.source_id.localeCompare(b.passage.source_id)
			|| a.passage.ordinal - b.passage.ordinal);
	for (const entry of ordered) {
		if (chosen.length >= (options.maxUnits ?? MAX_MATERIAL_UNITS)) break;
		if (seen.has(entry.index)) continue;
		seen.add(entry.index);
		chosen.push(entry.index);
	}

	const units: CourseMaterialUnit[] = chosen.map((index, position) => {
		const passage = considered[index];
		return {
			unit_id: `u${String(position + 1).padStart(2, "0")}`,
			source_id: passage.source_id,
			source_title: passage.source_title,
			page_path: passage.page_path,
			...(passage.heading_path ? { heading_path: passage.heading_path } : {}),
			...(passage.page_start !== undefined ? { page_start: passage.page_start } : {}),
			...(passage.page_end !== undefined ? { page_end: passage.page_end } : {}),
			ordinal: passage.ordinal,
			excerpt: passage.text,
		};
	});

	return {
		status: "ok",
		units,
		toc: tocOf(considered),
		sources,
		considered_passages: passages.length,
		truncated: passages.length > (options.maxUnits ?? MAX_MATERIAL_UNITS),
		retrieval,
		partial,
		material_version: materialVersion,
	};
}
