import { readTextAsync } from "../storage/file-store.js";
import { resolveContainedPathAsync } from "../utils/path-safety.js";
import { readManifestAsync } from "../memory/l2/manifest-store.js";
import { parseFrontmatter } from "../memory/l2/wiki-maintainer.js";
import type { ManifestEntry } from "../memory/l2/types.js";
import type { L2SearchResult } from "../memory/l2/l2-search.js";
import {
	knowledgeSnippet,
	type KnowledgeAssessment,
	type KnowledgeCandidate,
	type KnowledgeDesignationKind,
	type KnowledgePageReviewStatus,
} from "./knowledge-source.js";
import { MAX_SNIPPET_CHARS } from "./question-generator.js";

/**
 * Server-side assembly of C0 candidates from the real L2 store.
 *
 * This is the trust boundary: provenance and assessment are read from the
 * manifest and the wiki page here, never accepted from a client. Everything
 * downstream (`selectKnowledgeSource`) only compares and refuses.
 *
 * Retrieval deliberately refuses pages it cannot attribute to exactly one
 * manifest entry. A wiki page may merge several sources; picking one id and
 * attributing the whole page to it would be a fabricated citation.
 */

export interface KnowledgeLookupDeps {
	manifest?: (l2DataDir: string) => Promise<ManifestEntry[]>;
	page?: (l2DataDir: string, wikiPath: string) => Promise<string | null>;
	/** `null` means the index is unavailable, which is not the same as "no matches". */
	search?: (query: string) => Promise<L2SearchResult[] | null>;
	/**
	 * E4.1a course scope. `undefined` = unclassified legacy session (global L2,
	 * pre-E4.1 behaviour); `[]` = a course with no material and therefore no
	 * candidates. Applied to designated documents and retrieval results alike —
	 * a designation can never widen the course boundary.
	 */
	allowedSourceIds?: readonly string[];
}

const defaultDeps: Required<Omit<KnowledgeLookupDeps, "allowedSourceIds">> = {
	manifest: readManifestAsync,
	page: async (l2DataDir, wikiPath) => {
		// Wiki paths come from the manifest/search results, but a tampered or
		// stale manifest entry must never let an arbitrary path escape the L2 dir.
		// Resolve through the same symlink-aware containment check the indexer uses.
		const abs = await resolveContainedPathAsync(l2DataDir, wikiPath);
		if (!abs) return null;
		const text = await readTextAsync(abs, "");
		return text ? text : null;
	},
	// Bound by the caller; the default cannot reach the index without an L2Memory.
	search: async () => null,
};

export type RetrievalStatus = "ok" | "empty" | "unavailable";

export interface RetrievalResult {
	candidates: KnowledgeCandidate[];
	/** Distinguishes "nothing matched" from "retrieval is broken". */
	status: RetrievalStatus;
}

function reviewStatusOf(entry: ManifestEntry, pageText: string): { status: KnowledgePageReviewStatus; contested: boolean } {
	const parsed = parseFrontmatter(pageText);
	const raw = parsed.frontmatter?.status;
	const status: KnowledgePageReviewStatus = raw === "draft" || raw === "reviewed" || raw === "outdated" ? raw : "unknown";
	const contradictions = parsed.frontmatter?.contradictions;
	const contested = parsed.frontmatter?.contested === true || (Array.isArray(contradictions) && contradictions.length > 0);
	void entry;
	return { status, contested };
}

/** Page body without frontmatter, bounded — the text actually adopted. */
export function adoptableExcerpt(pageText: string): string | null {
	const body = parseFrontmatter(pageText).body.replace(/\r\n/g, "\n").trim();
	if (!body) return null;
	return body.slice(0, MAX_SNIPPET_CHARS);
}

function candidateFrom(
	entry: ManifestEntry,
	wikiPath: string,
	pageText: string,
	foundBy: "designated" | "retrieval",
	score: number | null,
): KnowledgeCandidate | null {
	const text = adoptableExcerpt(pageText);
	if (!text) return null;
	const review = reviewStatusOf(entry, pageText);
	const assessment: KnowledgeAssessment = {
		// Just read successfully and the snapshot is taken from this exact text.
		availability: "available",
		review_status: review.status,
		contested: review.contested,
	};
	return {
		provenance: {
			source_id: entry.id,
			origin: entry.source.origin,
			original_content_hash: entry.contentHash,
			source_identity: entry.source.identity?.trim() || null,
		},
		snippet: knowledgeSnippet({ page_path: wikiPath, location: { kind: "whole_page" }, text }),
		assessment,
		found_by: foundBy,
		score,
	};
}

function matchesEntry(entry: ManifestEntry, by: KnowledgeDesignationKind, value: string): boolean {
	switch (by) {
		case "source_id":
			return entry.id === value;
		case "content_hash":
			return entry.contentHash === value;
		case "source_identity":
			// Same trim semantics as `findManifestBySourceIdentity`.
			return (entry.source.identity?.trim() ?? "") === value;
	}
}

/**
 * Resolve a designation against the manifest.
 *
 * Returns one candidate per matching entry (using that entry's first wiki
 * page). An entry with no readable page yields no candidate, so a "found"
 * designation that cannot actually be cited degrades to "not found" instead of
 * being reported as usable.
 */
export async function designatedCandidates(
	l2DataDir: string,
	designation: { by: KnowledgeDesignationKind; value: string },
	deps: KnowledgeLookupDeps = {},
): Promise<KnowledgeCandidate[]> {
	const result = await resolveDesignation(l2DataDir, designation, deps);
	return result.candidates;
}

/**
 * Resolve a designation with a machine-readable outcome.
 *
 * This is the caller-facing variant of {@link designatedCandidates}: it keeps
 * "the manifest has no such document" (`not_found`) distinct from "the document
 * exists but its page could not be read" (`unavailable`). Collapsing the two
 * would report a broken read (a symlink escape, a permission error, a torn
 * file) as "this document does not exist", which misleads the user and lets a
 * fault masquerade as an empty knowledge base.
 */
export type DesignationResolution =
	| { status: "found"; candidates: KnowledgeCandidate[] }
	| { status: "not_found"; candidates: KnowledgeCandidate[] }
	| { status: "unavailable"; candidates: KnowledgeCandidate[] }
	/** The document exists but is not material of the session's course. */
	| { status: "out_of_scope"; candidates: KnowledgeCandidate[] };

export async function resolveDesignation(
	l2DataDir: string,
	designation: { by: KnowledgeDesignationKind; value: string },
	deps: KnowledgeLookupDeps = {},
): Promise<DesignationResolution> {
	const d = { ...defaultDeps, ...deps };
	const allowed = d.allowedSourceIds;
	// A source id outside the course scope is refused before the manifest read:
	// naming another course's document must not work even if that document is
	// perfectly readable, and the check must not depend on manifest contents.
	if (allowed !== undefined && designation.by === "source_id" && !allowed.includes(designation.value)) {
		return { status: "out_of_scope", candidates: [] };
	}
	const entries = await d.manifest(l2DataDir);
	const allMatched = entries.filter((entry) => matchesEntry(entry, designation.by, designation.value));
	const matched = allowed === undefined ? allMatched : allMatched.filter((entry) => allowed.includes(entry.id));
	if (matched.length === 0) {
		// Matching something the course does not own is a scope violation, not a
		// typo: the two need different user-facing explanations.
		if (allMatched.length > 0) return { status: "out_of_scope", candidates: [] };
		return { status: "not_found", candidates: [] };
	}

	const candidates: KnowledgeCandidate[] = [];
	let readFailure = false;
	for (const entry of matched) {
		const wikiPath = entry.wikiPages[0];
		if (!wikiPath) {
			// The entry exists but names no page: it cannot be cited, and that is a
			// source-side unavailability, not "the document does not exist".
			readFailure = true;
			continue;
		}
		let pageText: string | null;
		try {
			pageText = await d.page(l2DataDir, wikiPath);
		} catch {
			readFailure = true;
			continue;
		}
		if (!pageText) {
			readFailure = true;
			continue;
		}
		const candidate = candidateFrom(entry, wikiPath, pageText, "designated", null);
		if (candidate) candidates.push(candidate);
		else readFailure = true;
	}
	// A found entry whose page(s) all failed to read is "unavailable", never
	// "not found". When at least one page read cleanly but produced no usable
	// excerpt, we still report "found" only if there is a usable candidate.
	if (candidates.length > 0) return { status: "found", candidates };
	return readFailure ? { status: "unavailable", candidates } : { status: "not_found", candidates };
}

/**
 * Retrieve candidates for a query.
 *
 * `unavailable` means the caller could not search (index missing, L2 off);
 * `empty` means the search ran and matched nothing. Collapsing the two would
 * let a broken retrieval look like an empty knowledge base.
 */
export async function retrievalCandidates(
	l2DataDir: string,
	query: string,
	deps: KnowledgeLookupDeps = {},
): Promise<RetrievalResult> {
	const d = { ...defaultDeps, ...deps };
	let results: L2SearchResult[] | null;
	try {
		results = await d.search(query);
	} catch {
		return { candidates: [], status: "unavailable" };
	}
	if (results === null) return { candidates: [], status: "unavailable" };
	if (results.length === 0) return { candidates: [], status: "empty" };

	const entries = await d.manifest(l2DataDir);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const candidates: KnowledgeCandidate[] = [];
	for (const result of results) {
		// Exactly one known source, or this page cannot be attributed.
		if (result.sourceIds.length !== 1) continue;
		// Defense in depth: even a scoped search must not surface a page whose
		// single source lies outside the course, e.g. a stale or mis-scoped index.
		if (d.allowedSourceIds !== undefined && !d.allowedSourceIds.includes(result.sourceIds[0])) continue;
		const entry = byId.get(result.sourceIds[0]);
		if (!entry) continue;
		const pageText = await d.page(l2DataDir, result.path);
		if (!pageText) continue;
		const candidate = candidateFrom(entry, result.path, pageText, "retrieval", result.score);
		if (candidate) candidates.push(candidate);
	}
	return { candidates, status: candidates.length > 0 ? "ok" : "empty" };
}

/** Title used in the prompt for an L2-backed selection. */
export function snippetTitleFor(pagePath: string, entries: readonly ManifestEntry[]): string {
	const entry = entries.find((candidate) => candidate.wikiPages.includes(pagePath));
	return entry?.title ?? pagePath;
}
