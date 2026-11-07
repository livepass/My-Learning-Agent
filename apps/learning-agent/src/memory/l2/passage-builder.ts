import { splitSourceIntoSemanticChunks } from "./structural-chunker.js";

/**
 * E4.2c — turn a parsed document into retrieval-sized passages.
 *
 * `structural-chunker.ts` targets ~24k characters because it feeds whole-text
 * summarisation. Retrieval needs much smaller units: a question should adopt
 * the paragraph that answers it, not the first 4k characters of a 300-page
 * book. This builder reuses the same heading-aware splitter with a smaller
 * target and keeps the parser's page numbers when it has them.
 *
 * No locator is invented: `pageStart` / `pageEnd` exist only when the parser
 * reported per-page text, and `headingPath` only when the document itself has
 * headings.
 */

export const PASSAGE_TARGET_CHARS = 1_400;
export const PASSAGE_OVERLAP_CHARS = 120;
/** A 4000-passage cap keeps a malformed/huge upload from filling the disk. */
export const MAX_SOURCE_PASSAGES = 4_000;

export interface SourcePassage {
	ordinal: number;
	headingPath: string;
	text: string;
	pageStart?: number;
	pageEnd?: number;
}

export interface BuildPassagesInput {
	text: string;
	/** Page texts from the parser; omitted for formats without page boundaries. */
	pages?: Array<{ pageNumber: number; text: string }>;
	targetChars?: number;
	overlapChars?: number;
}

export class PassageBuildError extends Error {
	readonly code: "empty" | "too_many";

	constructor(code: "empty" | "too_many", message: string) {
		super(message);
		this.name = "PassageBuildError";
		this.code = code;
	}
}

function pushPassage(
	out: SourcePassage[],
	text: string,
	headingPath: string,
	pageStart?: number,
	pageEnd?: number,
): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	// A section-boundary flush can leave a heading with no body. It carries no
	// retrievable content and would only add an empty hit.
	const lines = trimmed.split("\n").filter((line) => line.trim());
	if (lines.length > 0 && lines.every((line) => /^#{1,6}\s/.test(line))) return;
	out.push({
		ordinal: out.length + 1,
		headingPath: headingPath.trim(),
		text: trimmed,
		...(pageStart !== undefined ? { pageStart } : {}),
		...(pageEnd !== undefined ? { pageEnd } : {}),
	});
}

export function buildSourcePassages(input: BuildPassagesInput): SourcePassage[] {
	const target = Math.max(400, Math.trunc(input.targetChars ?? PASSAGE_TARGET_CHARS));
	const overlap = Math.max(0, Math.trunc(input.overlapChars ?? PASSAGE_OVERLAP_CHARS));
	const pages = (input.pages ?? []).filter((page) => typeof page.text === "string" && page.text.trim());
	const out: SourcePassage[] = [];

	if (pages.length > 0) {
		for (const page of pages) {
			const chunks = splitSourceIntoSemanticChunks(page.text, target, overlap, { sectionBoundary: true });
			for (const chunk of chunks) {
				// The document's own heading path wins; the page fallback is not a
				// chapter title and is only used when the page has no headings.
				const heading = chunk.headingPath.trim() || `第 ${page.pageNumber} 页`;
				pushPassage(out, chunk.main, heading, page.pageNumber, page.pageNumber);
				if (out.length > MAX_SOURCE_PASSAGES) {
					throw new PassageBuildError("too_many", `文档分片超过 ${MAX_SOURCE_PASSAGES} 段，暂不支持入库`);
				}
			}
		}
	} else {
		const chunks = splitSourceIntoSemanticChunks(input.text, target, overlap, { sectionBoundary: true });
		for (const chunk of chunks) pushPassage(out, chunk.main, chunk.headingPath);
	}

	if (out.length === 0) throw new PassageBuildError("empty", "文档没有可用于检索的正文");
	if (out.length > MAX_SOURCE_PASSAGES) {
		throw new PassageBuildError("too_many", `文档分片超过 ${MAX_SOURCE_PASSAGES} 段，暂不支持入库`);
	}
	return out;
}
