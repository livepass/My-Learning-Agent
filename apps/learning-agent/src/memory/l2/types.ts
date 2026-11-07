// ============================================================================
// L2 Wiki Memory — Type Definitions
// ============================================================================

/** Raw source types. MVP supports text, markdown, conversation. */
export type RawSourceType = "text" | "markdown" | "conversation" | "pdf" | "word" | "image";

/** Built-in wiki page types. Project schemas may add further string types. */
export type BuiltInWikiPageType =
	| "source-summary"
	| "source"
	| "entity"
	| "concept"
	| "query"
	| "comparison"
	| "synthesis"
	| "analysis";

export type WikiPageType = BuiltInWikiPageType | (string & {});

/** Page review status. */
export type WikiPageStatus = "draft" | "reviewed" | "outdated";

/** Confidence level for wiki content. */
export type ConfidenceLevel = "low" | "medium" | "high";

export interface WikiPrerequisite {
	concept_id: string;
	relation?: "required" | "supporting";
	required_level?: number;
	importance?: number;
	source?: "curated" | "teacher" | "imported" | "model_inferred";
	source_confidence?: number;
	rationale?: string;
	scope?: string;
}

/** Processing status for manifest entries. */
export type ManifestStatus = "pending" | "extracted" | "indexed" | "error";

/**
 * Manifest entry — one per ingested source.
 * Stored as a line in data/l2/manifest.jsonl (append-only).
 */
export interface ManifestEntry {
	id: string;
	title: string;
	sourceType: RawSourceType;
	rawPath: string;
	extractedPath?: string;
	wikiPages: string[];
	/** E4.2c: retrieval units derived from the full text (wiki-relative paths). */
	passagePages?: string[];
	passageCount?: number;
	/** PDF/document page count when the parser reported it. */
	pageCount?: number;
	tags: string[];
	contentHash: string;
	status: ManifestStatus;
	/** E4.2b: stable, user-facing failure reason; never a stack trace or a path. */
	error?: string;
	indexedAt?: string;
	source: {
		origin: "user_upload" | "conversation" | "web" | "research" | "agent_inferred";
		/** Stable model-visible identity used by ingest and merge prompts. */
		identity?: string;
		url?: string;
		sessionId?: string;
	};
	createdAt: string;
	updatedAt: string;
}

/**
 * YAML frontmatter for wiki pages.
 */
export interface WikiPageFrontmatter {
	title: string;
	created: string;
	type: WikiPageType;
	tags: string[];
	/** Bare page slugs, union-preserved across ingests. */
	related?: string[];
	sources: string[];
	source_ids: string[];
	updated: string;
	status: WikiPageStatus;
	confidence: ConfidenceLevel;
	contested?: boolean;
	contradictions?: string[];
	/** Stable concept identifier used by learner-state prerequisite resolution. */
	concept_id?: string;
	/** Explicit teaching dependencies. Ordinary wikilinks remain non-directional relatedness. */
	prerequisites?: WikiPrerequisite[];
	/**
	 * E4.2c: present only on passage pages. The locator is copied from the
	 * parser/indexer, never inferred: an absent page range means "unknown".
	 */
	passage?: WikiPassageLocator;
}

/** Where a passage came from inside its source document. */
export interface WikiPassageLocator {
	source_id: string;
	ordinal: number;
	/** Heading path from the document's own headings; absent when it has none. */
	heading_path?: string;
	page_start?: number;
	page_end?: number;
	/** Relative path of the full extracted text this passage belongs to. */
	extracted_path: string;
}

/**
 * Result returned from an ingest operation.
 */
export interface IngestResult {
	id: string;
	title: string;
	rawPath: string;
	extractedPath: string;
	wikiPagePath: string;
	message: string;
}
