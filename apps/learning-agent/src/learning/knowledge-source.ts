import { createHash } from "node:crypto";
import type { LearningModelIdentity, LearningQuestionRef } from "../memory/learner/types.js";
import type { ManifestEntry, WikiPageStatus } from "../memory/l2/types.js";

/**
 * Knowledge-source contract (C0).
 *
 * Answers exactly one question: *what is this teaching or question grounded in,
 * which version of it, and can that be traced back?* It does not fetch, search,
 * generate questions or score answers — those are C1/C2.
 *
 * Three shapes, deliberately a closed discriminated union rather than one
 * object with optional fields: a model answer must not be able to carry a
 * citation, and an archived source must not be able to claim it was verified.
 *
 * Vocabulary used throughout:
 *   traceable  the excerpt resolves to a stored source record and still matches
 *              the snapshot that was adopted — nothing about truth
 *   reviewed   the wiki page's own declared status — nothing about truth
 *   contested  archived sources disagree — never silently resolved
 */

export const KNOWLEDGE_SOURCE_SCHEMA_VERSION = 1;

export const KNOWLEDGE_SOURCE_KINDS = ["user_document", "l2_archive", "model_knowledge"] as const;
export type KnowledgeSourceKind = typeof KNOWLEDGE_SOURCE_KINDS[number];

/** How the original document entered L2. Mirrors `ManifestEntry.source.origin`. */
export type KnowledgeSourceOrigin = ManifestEntry["source"]["origin"];

const SOURCE_ORIGINS: readonly KnowledgeSourceOrigin[] = [
	"user_upload", "conversation", "web", "research", "agent_inferred",
];

/** How a user named a document. The value is kept verbatim for the audit trail. */
export type KnowledgeDesignationKind = "source_id" | "content_hash" | "source_identity";

const DESIGNATION_KINDS: readonly KnowledgeDesignationKind[] = ["source_id", "content_hash", "source_identity"];

/** Where inside a wiki page the adopted text came from. */
export type KnowledgeSnippetLocation =
	| { kind: "whole_page" }
	| { kind: "heading"; heading: string }
	| { kind: "line_range"; start_line: number; end_line: number };

/**
 * Identity of an archived source.
 *
 * `source_identity` mirrors `ManifestEntry.source.identity` verbatim (nullable
 * when that entry has none). Resolution of a `source_identity` designation is
 * therefore always a comparison against the manifest record, never a guess from
 * a caller-supplied label.
 *
 * `original_content_hash` is `ManifestEntry.contentHash`: the identity of the
 * *ingested original*. It says nothing about a wiki page that was edited after
 * ingest, which is why every adopted excerpt carries its own
 * {@link KnowledgeSnippet.content_hash}.
 */
export interface L2SourceProvenance {
	source_id: string;
	origin: KnowledgeSourceOrigin;
	original_content_hash: string;
	/** `ManifestEntry.source.identity`, trimmed; `null` when the entry has none. */
	source_identity: string | null;
}

/**
 * A stable snapshot of the text that was actually adopted.
 *
 * Taken at selection time from the page as read then. Comparing it later is
 * what detects "the source moved under the question"; comparing only
 * `original_content_hash` never could.
 */
export interface KnowledgeSnippet {
	/** Wiki-relative logical path, e.g. `wiki/concepts/closures.md`. */
	page_path: string;
	location: KnowledgeSnippetLocation;
	/** sha256[:16] over the exact adopted text. */
	content_hash: string;
	/** UTF-16 length of the adopted text, so a truncation is detectable. */
	char_count: number;
}

/** The wiki page's declared review status. Never a fact-check result. */
export type KnowledgePageReviewStatus = WikiPageStatus | "unknown";

const REVIEW_STATUSES: readonly KnowledgePageReviewStatus[] = ["draft", "reviewed", "outdated", "unknown"];

/**
 * What is actually established about a candidate.
 *
 * `available` means the excerpt could be re-read and still matches its
 * snapshot. That is traceability, not correctness. `reviewed` is a page-level
 * declaration. `contested` records disagreement; it is never cleared by
 * selection.
 */
export type KnowledgeAvailability = "available" | "snapshot_mismatch" | "missing";

const AVAILABILITIES: readonly KnowledgeAvailability[] = ["available", "snapshot_mismatch", "missing"];

export interface KnowledgeAssessment {
	availability: KnowledgeAvailability;
	review_status: KnowledgePageReviewStatus;
	contested: boolean;
}

/**
 * A document the user explicitly named. Only an L2-backed document can be
 * named, because L2 is the only store of user material.
 */
export interface UserDocumentKnowledgeSource {
	kind: "user_document";
	provenance: L2SourceProvenance;
	snippet: KnowledgeSnippet;
	assessment: KnowledgeAssessment;
	/** What the user pointed at, kept so "依据的是哪一份" is answerable later. */
	designation: { by: KnowledgeDesignationKind; value: string };
}

/** An archived source picked by policy because the request named none. */
export interface L2ArchiveKnowledgeSource {
	kind: "l2_archive";
	provenance: L2SourceProvenance;
	snippet: KnowledgeSnippet;
	assessment: KnowledgeAssessment;
	/**
	 * L2 ranking score that selected it. Unbounded and not normalised — compare
	 * it with the other hits of the same run, never against a fixed 0–1 scale.
	 * `null` when the hit was unscored.
	 */
	score: number | null;
}

/**
 * Model parametric knowledge.
 *
 * Structurally unable to carry a citation: there is no source id, page, url or
 * page number field. A model answer therefore cannot be dressed up as an
 * archived document or given a fabricated citation — the parser rejects any
 * such field instead of ignoring it.
 *
 * `model` must come from the runtime. When the provider cannot report a
 * revision it stays `null` with `version_source: "unavailable"`; a configured
 * model name must never be substituted for it.
 */
export interface ModelKnowledgeSource {
	kind: "model_knowledge";
	model: LearningModelIdentity;
	/** Why model knowledge was used at all. */
	ground: "no_source_requested" | "no_matching_source";
}

export type KnowledgeSource = UserDocumentKnowledgeSource | L2ArchiveKnowledgeSource | ModelKnowledgeSource;

/** A candidate the caller already resolved (designated lookup or retrieval). */
export interface KnowledgeCandidate {
	provenance: L2SourceProvenance;
	snippet: KnowledgeSnippet;
	assessment: KnowledgeAssessment;
	/** Where this candidate came from. Selection never mixes the two pools. */
	found_by: "designated" | "retrieval";
	/**
	 * L2 ranking score (BM25 + graph signals): unbounded non-negative relevance,
	 * not a probability. Only its ordering is meaningful; `null` when unscored.
	 */
	score: number | null;
}

/** What the caller is asking for. Parsed before use; no hidden defaults. */
export interface KnowledgeRequest {
	/** Present only when the user explicitly pointed at a document. */
	designated?: { by: KnowledgeDesignationKind; value: string };
	/** Learner-facing topic used to look for archived material. */
	query?: string;
	goal_id?: string;
	concept_id?: string;
	/**
	 * Whether model knowledge may stand in when nothing archived fits.
	 * Explicit because the product policy is a decision, not a default:
	 * a request that named a document never reaches the fallback path anyway.
	 */
	allow_model_fallback: boolean;
}

export type KnowledgeSelectionReason =
	| "designated_not_found"
	| "designated_ambiguous"
	| "conflicting_sources"
	| "no_matching_source"
	| "model_fallback_disallowed"
	| "model_identity_unavailable";

/**
 * Outcome of selection.
 *
 * `needs_input` is a first-class result, not an error: C0 refuses to guess when
 * a named document is missing, its identity is ambiguous, or sources disagree.
 * `designated_unavailable` carries the blocked candidates so the caller can say
 * *why* the named document cannot be used (page edited or gone), instead of
 * quietly answering from something else.
 */
export type KnowledgeSelection =
	| { status: "selected"; source: KnowledgeSource }
	| {
		status: "needs_input";
		reason: "designated_not_found" | "designated_ambiguous" | "conflicting_sources";
		/** Empty for `designated_not_found`; otherwise what the caller must choose between. */
		candidates: readonly KnowledgeCandidate[];
	}
	| {
		status: "unavailable";
		reason: "designated_unavailable";
		/** The designated excerpts that could not be used. */
		candidates: readonly KnowledgeCandidate[];
	}
	| {
		status: "unavailable";
		reason: "no_matching_source" | "model_fallback_disallowed" | "model_identity_unavailable";
	};

/**
 * What C1 will persist beside a generated question.
 *
 * Not written anywhere in C0 — no field is added to `LearningQuestion`, and
 * `LearningSessionRecord.schema_version` stays 1. See
 * `docs/knowledge-source-contract.md` for the migration plan.
 */
export interface KnowledgeBinding {
	question: LearningQuestionRef;
	source: KnowledgeSource;
	/** ISO timestamp of generation; later L2 edits must not rewrite this record. */
	bound_at: string;
}

export class KnowledgeSourceError extends Error {
	constructor(
		public readonly code: "invalid_source" | "invalid_request",
		message: string,
	) {
		super(message);
		this.name = "KnowledgeSourceError";
	}
}

// ---------------------------------------------------------------------------
// Validation. Every entry point is strict: unknown or extra fields are rejected
// rather than ignored, so untrusted metadata cannot smuggle a citation in.
// ---------------------------------------------------------------------------

function reject(code: "invalid_source" | "invalid_request", message: string): never {
	throw new KnowledgeSourceError(code, message);
}

function objectOf(
	value: unknown,
	allowed: readonly string[],
	code: "invalid_source" | "invalid_request",
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject(code, "Expected an object");
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) reject(code, `Unexpected field: ${key}`);
	}
	return record;
}

/** Same shape as the learning contracts' identifier rule. */
function identifier(value: unknown, code: "invalid_source" | "invalid_request", field: string): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) {
		reject(code, `Invalid ${field}`);
	}
	return value;
}

/**
 * A vendor label: provider id, model id or reported version.
 *
 * Model ids are not file names. Configured values in this repository are only
 * required to be non-empty (`config.ts` trims and compares them verbatim), and
 * real providers ship ids like `anthropic/claude-3.5-sonnet`,
 * `@cf/meta/llama-3.1-8b` or `Qwen/Qwen2.5-72B-Instruct`. Applying the
 * identifier/path rules here would reject working configurations, so only
 * control characters, surrounding whitespace and absurd length are refused.
 */
function vendorLabel(value: unknown, code: "invalid_source" | "invalid_request", field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 200) reject(code, `Invalid ${field}`);
	if (value !== value.trim()) reject(code, `Invalid ${field}`);
	if (/[\u0000-\u001f\u007f"\\]/.test(value)) reject(code, `Invalid ${field}`);
	return value;
}

/**
 * `ManifestEntry.source.identity` is a display/resolution name, not a path: it
 * can be a Chinese file name. Trimmed on both sides of a comparison, matching
 * `findManifestBySourceIdentity`.
 */
function sourceIdentity(value: unknown, code: "invalid_source" | "invalid_request"): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) {
		reject(code, "Invalid source identity");
	}
	return value.trim();
}

/** `sha256[:16]`, the hash convention already used by L2 and the index store. */
function contentHash16(value: unknown, code: "invalid_source" | "invalid_request", field: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value)) reject(code, `Invalid ${field}`);
	return value;
}

/**
 * Retrieval score.
 *
 * L2 ranks with BM25 and graph signals, so a score is an unbounded non-negative
 * relevance value, not a probability: `12.5` is normal and `0.42` means nothing
 * without the run's other scores. Only ordering is meaningful, so nothing here
 * assumes a 0–1 range.
 */
function retrievalScore(value: unknown, code: "invalid_source" | "invalid_request"): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) reject(code, "Invalid retrieval score");
	return value;
}

/**
 * Wiki-relative logical path only: no absolute paths, backslashes or traversal.
 *
 * Page basenames are title-derived and may be Chinese (`wiki-generator.ts`
 * deliberately keeps CJK basenames and builds slugs from `\p{L}\p{N}-`), so the
 * character class must be Unicode-aware. Safety comes from the segment rules
 * below, not from restricting the script.
 */
const WIKI_PAGE_PATH = /^wiki\/(?:[\p{L}\p{N}._-]+\/)*[\p{L}\p{N}._-]+\.md$/u;

function wikiPagePath(value: unknown, code: "invalid_source" | "invalid_request"): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 300) reject(code, "Invalid page path");
	if (value.includes("\\") || value.startsWith("/") || /[\u0000-\u001f\u007f]/.test(value)) reject(code, "Invalid page path");
	if (!WIKI_PAGE_PATH.test(value)) reject(code, "Invalid page path");
	// Character rules alone would let `..` through: it is a legal file name.
	if (value.split("/").some((segment) => segment === "." || segment === "..")) reject(code, "Invalid page path");
	return value;
}

function snippetLocation(value: unknown, code: "invalid_source" | "invalid_request"): KnowledgeSnippetLocation {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject(code, "Invalid snippet location");
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case "whole_page":
			objectOf(record, ["kind"], code);
			return { kind: "whole_page" };
		case "heading": {
			objectOf(record, ["kind", "heading"], code);
			const heading = record.heading;
			if (typeof heading !== "string" || !heading.trim() || heading.length > 200 || /[\r\n]/.test(heading)) {
				reject(code, "Invalid heading anchor");
			}
			return { kind: "heading", heading };
		}
		case "line_range": {
			objectOf(record, ["kind", "start_line", "end_line"], code);
			const start = record.start_line;
			const end = record.end_line;
			if (!Number.isSafeInteger(start) || (start as number) < 1) reject(code, "Invalid start line");
			if (!Number.isSafeInteger(end) || (end as number) < (start as number)) reject(code, "Invalid end line");
			return { kind: "line_range", start_line: start as number, end_line: end as number };
		}
		default:
			return reject(code, "Unknown snippet location");
	}
}

function snippet(value: unknown, code: "invalid_source" | "invalid_request"): KnowledgeSnippet {
	const record = objectOf(value, ["page_path", "location", "content_hash", "char_count"], code);
	const charCount = record.char_count;
	if (!Number.isSafeInteger(charCount) || (charCount as number) < 0) reject(code, "Invalid snippet length");
	return {
		page_path: wikiPagePath(record.page_path, code),
		location: snippetLocation(record.location, code),
		content_hash: contentHash16(record.content_hash, code, "snippet content hash"),
		char_count: charCount as number,
	};
}

function provenance(value: unknown, code: "invalid_source" | "invalid_request"): L2SourceProvenance {
	const record = objectOf(value, ["source_id", "origin", "original_content_hash", "source_identity"], code);
	if (!SOURCE_ORIGINS.includes(record.origin as KnowledgeSourceOrigin)) reject(code, "Unknown source origin");
	return {
		source_id: identifier(record.source_id, code, "source id"),
		origin: record.origin as KnowledgeSourceOrigin,
		original_content_hash: contentHash16(record.original_content_hash, code, "original content hash"),
		// Required (though nullable): an omitted identity would make a
		// `source_identity` designation silently unmatchable.
		source_identity: sourceIdentity(record.source_identity, code),
	};
}

function assessment(value: unknown, code: "invalid_source" | "invalid_request"): KnowledgeAssessment {
	const record = objectOf(value, ["availability", "review_status", "contested"], code);
	if (!AVAILABILITIES.includes(record.availability as KnowledgeAvailability)) reject(code, "Unknown availability");
	if (!REVIEW_STATUSES.includes(record.review_status as KnowledgePageReviewStatus)) reject(code, "Unknown review status");
	if (typeof record.contested !== "boolean") reject(code, "Invalid contested flag");
	return {
		availability: record.availability as KnowledgeAvailability,
		review_status: record.review_status as KnowledgePageReviewStatus,
		contested: record.contested,
	};
}

/**
 * A model identity the runtime actually observed.
 *
 * The two variants are mutually exclusive on purpose: an unreportable version
 * must be `null` + `unavailable`, and a reported version must be a real string.
 * This is what stops a configured model name from being presented as a
 * provider revision.
 */
export function parseLearningModelIdentity(value: unknown): LearningModelIdentity {
	const record = objectOf(value, ["provider_id", "model_id", "model_version", "version_source"], "invalid_source");
	const providerId = vendorLabel(record.provider_id, "invalid_source", "provider id");
	const modelId = vendorLabel(record.model_id, "invalid_source", "model id");
	if (record.version_source === "provider_reported") {
		const version = vendorLabel(record.model_version, "invalid_source", "reported model version");
		return { provider_id: providerId, model_id: modelId, model_version: version, version_source: "provider_reported" };
	}
	if (record.version_source === "unavailable") {
		if (record.model_version !== null) reject("invalid_source", "Unavailable model version must be null");
		return { provider_id: providerId, model_id: modelId, model_version: null, version_source: "unavailable" };
	}
	return reject("invalid_source", "Unknown version source");
}

function designation(value: unknown): { by: KnowledgeDesignationKind; value: string } {
	const record = objectOf(value, ["by", "value"], "invalid_source");
	if (!DESIGNATION_KINDS.includes(record.by as KnowledgeDesignationKind)) reject("invalid_source", "Unknown designation kind");
	const raw = record.value;
	if (typeof raw !== "string" || !raw.trim() || raw.length > 300 || /[\u0000-\u001f\u007f]/.test(raw)) {
		reject("invalid_source", "Invalid designation value");
	}
	// Each kind names a different manifest field, so each is validated the same
	// way that field is: a hash must be a hash, an id an id, an identity a name.
	switch (record.by as KnowledgeDesignationKind) {
		case "source_id":
			return { by: "source_id", value: identifier(raw, "invalid_source", "designated source id") };
		case "content_hash":
			return { by: "content_hash", value: contentHash16(raw, "invalid_source", "designated content hash") };
		case "source_identity":
			return { by: "source_identity", value: sourceIdentity(raw, "invalid_source") as string };
	}
}

/** Parse an untrusted knowledge source. Throws on anything unexpected. */
export function parseKnowledgeSource(value: unknown): KnowledgeSource {
	const record = objectOf(
		value,
		["kind", "provenance", "snippet", "assessment", "designation", "score", "model", "ground"],
		"invalid_source",
	);
	switch (record.kind) {
		case "user_document":
			objectOf(record, ["kind", "provenance", "snippet", "assessment", "designation"], "invalid_source");
			return {
				kind: "user_document",
				provenance: provenance(record.provenance, "invalid_source"),
				snippet: snippet(record.snippet, "invalid_source"),
				assessment: assessment(record.assessment, "invalid_source"),
				designation: designation(record.designation),
			};
		case "l2_archive": {
			objectOf(record, ["kind", "provenance", "snippet", "assessment", "score"], "invalid_source");
			return {
				kind: "l2_archive",
				provenance: provenance(record.provenance, "invalid_source"),
				snippet: snippet(record.snippet, "invalid_source"),
				assessment: assessment(record.assessment, "invalid_source"),
				score: retrievalScore(record.score, "invalid_source"),
			};
		}
		case "model_knowledge": {
			// No provenance/snippet/score field is allowed here, so a model answer
			// can never carry a citation the archive did not issue.
			objectOf(record, ["kind", "model", "ground"], "invalid_source");
			if (record.ground !== "no_source_requested" && record.ground !== "no_matching_source") {
				reject("invalid_source", "Unknown model ground");
			}
			return { kind: "model_knowledge", model: parseLearningModelIdentity(record.model), ground: record.ground };
		}
		default:
			return reject("invalid_source", "Unknown knowledge source kind");
	}
}

/** Parse an untrusted selection request. */
export function parseKnowledgeRequest(value: unknown): KnowledgeRequest {
	const record = objectOf(
		value,
		["designated", "query", "goal_id", "concept_id", "allow_model_fallback"],
		"invalid_request",
	);
	if (typeof record.allow_model_fallback !== "boolean") reject("invalid_request", "allow_model_fallback must be explicit");
	const request: KnowledgeRequest = { allow_model_fallback: record.allow_model_fallback };
	if (record.designated !== undefined) request.designated = designation(record.designated);
	if (record.query !== undefined) {
		if (typeof record.query !== "string" || !record.query.trim() || record.query.length > 2_000) {
			reject("invalid_request", "Invalid query");
		}
		request.query = record.query.trim();
	}
	if (record.goal_id !== undefined) request.goal_id = identifier(record.goal_id, "invalid_request", "goal id");
	if (record.concept_id !== undefined) request.concept_id = identifier(record.concept_id, "invalid_request", "concept id");
	return request;
}

/** Parse an untrusted candidate. Selection fails closed on a malformed one. */
export function parseKnowledgeCandidate(value: unknown): KnowledgeCandidate {
	const record = objectOf(value, ["provenance", "snippet", "assessment", "found_by", "score"], "invalid_source");
	if (record.found_by !== "designated" && record.found_by !== "retrieval") reject("invalid_source", "Unknown candidate origin");
	return {
		provenance: provenance(record.provenance, "invalid_source"),
		snippet: snippet(record.snippet, "invalid_source"),
		assessment: assessment(record.assessment, "invalid_source"),
		found_by: record.found_by,
		score: retrievalScore(record.score, "invalid_source"),
	};
}

// ---------------------------------------------------------------------------
// Snippet identity
// ---------------------------------------------------------------------------

/**
 * Snapshot the exact text being adopted.
 *
 * `contentHash` on the manifest cannot describe a wiki page that was edited
 * after ingest, so every adopted excerpt gets its own identity here.
 */
export function knowledgeSnippet(input: {
	page_path: string;
	location: KnowledgeSnippetLocation;
	text: string;
}): KnowledgeSnippet {
	const pagePath = wikiPagePath(input.page_path, "invalid_source");
	const location = snippetLocation(input.location, "invalid_source");
	if (typeof input.text !== "string" || input.text.length === 0) reject("invalid_source", "Empty snippet text");
	if (input.text.length > 200_000) reject("invalid_source", "Oversized snippet text");
	return {
		page_path: pagePath,
		location,
		content_hash: createHash("sha256").update(input.text).digest("hex").slice(0, 16),
		char_count: input.text.length,
	};
}

/** Identity comparison: two excerpts are the same only if path, location and text match. */
export function sameSnippet(a: KnowledgeSnippet, b: KnowledgeSnippet): boolean {
	if (a.page_path !== b.page_path || a.content_hash !== b.content_hash || a.char_count !== b.char_count) return false;
	const left = a.location;
	const right = b.location;
	if (left.kind !== right.kind) return false;
	if (left.kind === "heading" && right.kind === "heading") return left.heading === right.heading;
	if (left.kind === "line_range" && right.kind === "line_range") {
		return left.start_line === right.start_line && left.end_line === right.end_line;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * True when a candidate's manifest identity is the one the user named.
 *
 * Each designation kind maps to exactly one manifest field, and all three are
 * carried in `L2SourceProvenance`, so the comparison happens here against data
 * the caller read from the manifest. A candidate cannot be "the designated
 * document" merely because the caller set `found_by: "designated"`.
 */
function matchesDesignation(
	provenance: L2SourceProvenance,
	designation: { by: KnowledgeDesignationKind; value: string },
): boolean {
	switch (designation.by) {
		case "source_id":
			return provenance.source_id === designation.value;
		case "content_hash":
			return provenance.original_content_hash === designation.value;
		case "source_identity":
			// `null` means the manifest entry has no identity, so nothing can match.
			return provenance.source_identity !== null && provenance.source_identity === designation.value;
	}
}

/** Deterministic: highest score wins, ties break on path so runs are reproducible. */
function pickBest(candidates: readonly KnowledgeCandidate[]): KnowledgeCandidate {
	return [...candidates].sort((a, b) => {
		const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
		if (scoreDelta !== 0) return scoreDelta;
		return a.snippet.page_path.localeCompare(b.snippet.page_path);
	})[0];
}

/**
 * One entry per (source, excerpt). Two documents that happen to share a page
 * path must both stay visible when the caller is asked to resolve a conflict.
 */
function distinctCandidates(candidates: readonly KnowledgeCandidate[]): KnowledgeCandidate[] {
	const unique: KnowledgeCandidate[] = [];
	for (const candidate of candidates) {
		const duplicate = unique.some((existing) => existing.provenance.source_id === candidate.provenance.source_id
			&& sameSnippet(existing.snippet, candidate.snippet));
		if (!duplicate) unique.push(candidate);
	}
	return unique;
}

/**
 * Pick the knowledge a teaching turn is allowed to rely on.
 *
 * Order: an available document the user named → archived L2 material for the
 * request → model knowledge, and only when the request explicitly allows it.
 * A named document that cannot be resolved never falls through to the model:
 * that would be the silent substitution this contract exists to prevent.
 *
 * Pure: candidates are passed in, nothing is fetched. Malformed input fails
 * closed rather than degrading to model knowledge.
 */
export function selectKnowledgeSource(input: {
	request: KnowledgeRequest;
	candidates: readonly KnowledgeCandidate[];
	model: LearningModelIdentity | null;
}): KnowledgeSelection {
	const request = parseKnowledgeRequest(input.request);
	const candidates = input.candidates.map(parseKnowledgeCandidate);
	// Deliberately *not* parsed here: a model identity is only meaningful when
	// model knowledge is actually used, and an unused one must not fail the
	// selection of a perfectly good archived source.

	if (request.designated) {
		const designation = request.designated;
		// `found_by` is the caller's own label. Trusting it alone would let any
		// candidate be presented as the document the user named, so the identity
		// fields must actually match what was designated.
		const designated = candidates.filter((candidate) => candidate.found_by === "designated"
			&& matchesDesignation(candidate.provenance, designation));
		if (designated.length === 0) {
			return { status: "needs_input", reason: "designated_not_found", candidates: [] };
		}
		// The designation names a *document*; several excerpts of it are a
		// retrieval choice, several documents are an ambiguity for the user.
		const bySource = new Map<string, KnowledgeCandidate[]>();
		for (const candidate of designated) {
			const group = bySource.get(candidate.provenance.source_id);
			if (group) group.push(candidate);
			else bySource.set(candidate.provenance.source_id, [candidate]);
		}
		if (bySource.size > 1) {
			const representative = [...bySource.values()].map((group) => pickBest(group));
			return { status: "needs_input", reason: "designated_ambiguous", candidates: representative };
		}
		const [group] = [...bySource.values()];
		// A page that was edited after the snapshot, or is gone, cannot back a
		// claim that names it: report it instead of answering from elsewhere.
		const usable = group.filter((candidate) => candidate.assessment.availability === "available");
		if (usable.length === 0) {
			return { status: "unavailable", reason: "designated_unavailable", candidates: distinctCandidates(group) };
		}
		const chosen = pickBest(usable);
		return {
			status: "selected",
			source: {
				kind: "user_document",
				provenance: chosen.provenance,
				snippet: chosen.snippet,
				assessment: chosen.assessment,
				designation: { ...designation },
			},
		};
	}

	const hits = candidates.filter((candidate) => candidate.found_by === "retrieval" && candidate.assessment.availability === "available");

	// Disagreement between distinct documents is reported, never resolved here.
	if (hits.length > 0) {
		const distinctSources = new Set(hits.map((candidate) => candidate.provenance.source_id));
		if (distinctSources.size > 1 && hits.some((candidate) => candidate.assessment.contested)) {
			return { status: "needs_input", reason: "conflicting_sources", candidates: distinctCandidates(hits) };
		}
		const chosen = pickBest(hits);
		return {
			status: "selected",
			source: {
				kind: "l2_archive",
				provenance: chosen.provenance,
				snippet: chosen.snippet,
				assessment: chosen.assessment,
				score: chosen.score,
			},
		};
	}

	if (!request.allow_model_fallback) {
		return { status: "unavailable", reason: "model_fallback_disallowed" };
	}
	if (input.model === null) {
		// No archived material and no trustworthy model identity: stop rather
		// than emit an answer we cannot attribute.
		return { status: "unavailable", reason: "model_identity_unavailable" };
	}
	// Only now is the identity worth validating.
	const model = parseLearningModelIdentity(input.model);
	const asked = Boolean(request.query || request.goal_id || request.concept_id);
	return {
		status: "selected",
		source: { kind: "model_knowledge", model, ground: asked ? "no_matching_source" : "no_source_requested" },
	};
}
