import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { logger } from "../../logger.js";
import { readTextAsync, writeTextAsync } from "../../storage/file-store.js";
import { parseDocument, DocumentParseError } from "./document-parser.js";
import { convertToExtractedAsync } from "./source-converter.js";
import { saveRawBufferAsync, saveRawTextAsync } from "./raw-store.js";
import { readManifestAsync, upsertManifestAsync } from "./manifest-store.js";
import { buildSourcePassages, PassageBuildError, type SourcePassage } from "./passage-builder.js";
import { extractDocxText, DocxExtractError } from "./docx-text.js";
import { createSourcePageAsync, serializeFrontmatter } from "./wiki-maintainer.js";
import { getL2Memory } from "./l2-memory.js";
import type { ManifestEntry, RawSourceType, WikiPageFrontmatter } from "./types.js";

/**
 * E4.2b — deterministic course-document ingest.
 *
 * Unlike the agent's `l2_archive` tool, this path never calls a model: an
 * upload must not sit behind an LLM summary to become searchable, and a failed
 * model call must not look like a successful archive. The pipeline is:
 *
 *   validate format → extract text → content hash (dedupe) → raw + extracted
 *   → passages (with page/heading locators) → manifest(extracted) → index
 *   → manifest(indexed)
 *
 * Status is only `indexed` after every page was handed to the index owner. Any
 * failure records `status: "error"` with a stable reason and keeps the source
 * retryable.
 */

const SUPPORTED: Record<string, { sourceType: RawSourceType; pageAware: boolean }> = {
	".md": { sourceType: "markdown", pageAware: false },
	".markdown": { sourceType: "markdown", pageAware: false },
	".txt": { sourceType: "text", pageAware: false },
	".text": { sourceType: "text", pageAware: false },
	".pdf": { sourceType: "pdf", pageAware: true },
	".docx": { sourceType: "word", pageAware: true },
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_TITLE_CHARS = 200;

export type CourseIngestErrorCode =
	| "unsupported_format"
	| "empty_document"
	| "file_too_large"
	| "parse_failed"
	| "passage_failed"
	| "index_failed"
	| "source_not_found"
	| "not_retryable";

export class CourseIngestError extends Error {
	readonly code: CourseIngestErrorCode;
	readonly sourceId?: string;
	readonly retryable: boolean;

	constructor(code: CourseIngestErrorCode, message: string, options: { sourceId?: string; retryable?: boolean } = {}) {
		super(message);
		this.name = "CourseIngestError";
		this.code = code;
		this.sourceId = options.sourceId;
		this.retryable = options.retryable ?? false;
	}
}

export interface IngestCourseDocumentInput {
	l2DataDir: string;
	fileName: string;
	mimeType?: string;
	data: Uint8Array;
	/** Display title; defaults to the file name without extension. */
	title?: string;
}

export interface IngestCourseDocumentResult {
	sourceId: string;
	title: string;
	status: "indexed";
	duplicate: boolean;
	passageCount: number;
	pageCount?: number;
	sourceType: RawSourceType;
}

function formatOf(fileName: string): { sourceType: RawSourceType; pageAware: boolean; ext: string } {
	const ext = extname(fileName).toLowerCase();
	const format = SUPPORTED[ext];
	if (!format) {
		throw new CourseIngestError(
			"unsupported_format",
			"当前版本仅支持 PDF、DOCX、Markdown、TXT。XLSX 与 PPTX 的入库链路尚未验证，暂不接受。",
		);
	}
	return { ...format, ext };
}

function defaultTitle(fileName: string): string {
	const base = fileName.replace(/\.[^.]+$/, "").trim();
	return (base || "未命名资料").slice(0, MAX_TITLE_CHARS);
}

function safeError(err: unknown): string {
	if (err instanceof DocumentParseError) {
		// Parser messages can embed an absolute path; the manifest/API must not.
		switch (err.code) {
			case "FILE_NOT_FOUND":
				return "文件不可读";
			case "UNSUPPORTED_FORMAT":
				return "不支持的文件格式";
			case "FILE_TOO_LARGE":
				return "文件超过解析上限";
			case "EMPTY_RESULT":
				return "文件解析结果为空，可能是扫描件或空文件";
			default:
				return "文件解析失败";
		}
	}
	if (err instanceof PassageBuildError) return err.message.slice(0, 300);
	if (err instanceof CourseIngestError) return err.message.slice(0, 300);
	return "资料处理失败";
}

function contentHashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function passageTitle(sourceTitle: string, passage: SourcePassage): string {
	const range = passage.pageStart !== undefined
		? passage.pageEnd !== undefined && passage.pageEnd !== passage.pageStart
			? `P${passage.pageStart}–${passage.pageEnd}`
			: `P${passage.pageStart}`
		: "";
	return [sourceTitle.slice(0, 80), range, `片段 ${passage.ordinal}`].filter(Boolean).join(" · ");
}

async function writePassagePages(
	l2DataDir: string,
	entry: ManifestEntry,
	passages: SourcePassage[],
): Promise<string[]> {
	const created: string[] = [];
	const dir = `wiki/passages/${entry.id}`;
	for (const passage of passages) {
		const relative = `${dir}/p${String(passage.ordinal).padStart(4, "0")}.md`;
		const title = passageTitle(entry.title, passage);
		const fm: WikiPageFrontmatter = {
			title,
			created: new Date().toISOString().slice(0, 10),
			type: "passage",
			tags: [],
			sources: [entry.source.identity ?? entry.rawPath],
			source_ids: [entry.id],
			updated: new Date().toISOString().slice(0, 10),
			status: "draft",
			confidence: "medium",
			passage: {
				source_id: entry.id,
				ordinal: passage.ordinal,
				...(passage.headingPath ? { heading_path: passage.headingPath } : {}),
				...(passage.pageStart !== undefined ? { page_start: passage.pageStart } : {}),
				...(passage.pageEnd !== undefined ? { page_end: passage.pageEnd } : {}),
				extracted_path: entry.extractedPath ?? entry.rawPath,
			},
		};
		const pageRange = passage.pageStart !== undefined
			? passage.pageEnd !== undefined && passage.pageEnd !== passage.pageStart
				? `P${passage.pageStart}–${passage.pageEnd}`
				: `P${passage.pageStart}`
			: "";
		// The locator is part of the passage body, so the excerpt adopted by C1
		// carries exactly the position the parser reported — nothing is inferred
		// at question time.
		const locatorText = [passage.headingPath, pageRange].filter(Boolean).join(" · ");
		const location = locatorText ? `## 位置\n\n${locatorText}\n\n` : "";
		const body = `\n# ${title}\n\n${location}${passage.text}\n`;
		await writeTextAsync(join(l2DataDir, relative), serializeFrontmatter(fm) + body);
		created.push(relative);
	}
	return created;
}

async function removeStalePassages(l2DataDir: string, previous: readonly string[] | undefined, current: readonly string[]): Promise<void> {
	if (!previous?.length) return;
	const keep = new Set(current);
	for (const path of previous) {
		if (keep.has(path)) continue;
		await rm(join(l2DataDir, path), { force: true }).catch(() => undefined);
	}
}

/**
 * Finish an already-persisted source: passages → manifest(extracted) → index
 * → manifest(indexed). Shared by fresh uploads and retries.
 */
async function finishIngest(
	l2DataDir: string,
	entry: ManifestEntry,
	text: string,
	pages: Array<{ pageNumber: number; text: string }> | undefined,
	duplicate: boolean,
): Promise<IngestCourseDocumentResult> {
	const memory = getL2Memory(l2DataDir);

	let passages: SourcePassage[];
	try {
		passages = buildSourcePassages({ text, pages });
	} catch (err) {
		const message = safeError(err);
		await markError(l2DataDir, entry, message);
		throw new CourseIngestError("passage_failed", message, { sourceId: entry.id, retryable: true });
	}

	let passagePages: string[] = [];
	try {
		passagePages = await writePassagePages(l2DataDir, entry, passages);
	} catch (err) {
		logger.warn({ err, sourceId: entry.id }, "course ingest: failed to write passages");
		await markError(l2DataDir, entry, "片段写入失败");
		throw new CourseIngestError("index_failed", "片段写入失败", { sourceId: entry.id, retryable: true });
	}
	await removeStalePassages(l2DataDir, entry.passagePages, passagePages);

	let summaryPath: string;
	try {
		summaryPath = await createSourcePageAsync(
			l2DataDir,
			entry,
			`## 摘要\n\n${text.slice(0, 1_200)}\n\n## 检索\n\n完整正文已分片为 ${passages.length} 段，可在课程内检索。`,
			entry.extractedPath,
			entry.source.identity,
		);
	} catch (err) {
		logger.warn({ err, sourceId: entry.id }, "course ingest: failed to write source summary");
		await markError(l2DataDir, entry, "来源页面写入失败");
		throw new CourseIngestError("index_failed", "来源页面写入失败", { sourceId: entry.id, retryable: true });
	}

	entry.wikiPages = [summaryPath];
	entry.passagePages = passagePages;
	entry.passageCount = passages.length;
	entry.status = "extracted";
	entry.error = undefined;
	entry.updatedAt = new Date().toISOString();
	await upsertManifestAsync(l2DataDir, entry);

	try {
		await memory.indexPagesByPaths([summaryPath, ...passagePages]);
	} catch (err) {
		logger.warn({ err, sourceId: entry.id }, "course ingest: index update failed");
		await markError(l2DataDir, entry, "检索索引更新失败");
		throw new CourseIngestError("index_failed", "检索索引更新失败，可重试", { sourceId: entry.id, retryable: true });
	}

	// The index owner can be unavailable (node:sqlite missing). A source is not
	// "indexed" unless the index actually accepted it and can return it.
	const probe = await memory.search(text.slice(0, 30), 1, { sourceIds: [entry.id] });
	if (probe === null) {
		await markError(l2DataDir, entry, "检索索引不可用");
		throw new CourseIngestError("index_failed", "检索索引不可用，已保留原文，可稍后重试", { sourceId: entry.id, retryable: true });
	}

	entry.status = "indexed";
	entry.indexedAt = new Date().toISOString();
	entry.updatedAt = entry.indexedAt;
	entry.error = undefined;
	await upsertManifestAsync(l2DataDir, entry);

	return {
		sourceId: entry.id,
		title: entry.title,
		status: "indexed",
		duplicate,
		passageCount: passages.length,
		...(entry.pageCount !== undefined ? { pageCount: entry.pageCount } : {}),
		sourceType: entry.sourceType,
	};
}

async function markError(l2DataDir: string, entry: ManifestEntry, message: string): Promise<void> {
	entry.status = "error";
	entry.error = message;
	entry.updatedAt = new Date().toISOString();
	await upsertManifestAsync(l2DataDir, entry).catch((err) => {
		logger.warn({ err, sourceId: entry.id }, "course ingest: failed to persist error status");
	});
}

async function extractText(input: IngestCourseDocumentInput, format: { sourceType: RawSourceType; pageAware: boolean; ext: string }): Promise<{
	text: string;
	pages?: Array<{ pageNumber: number; text: string }>;
	pageCount?: number;
	rawPath?: string;
}> {
	if (!format.pageAware) {
		const text = Buffer.from(input.data).toString("utf8").replace(/^\uFEFF/, "").trim();
		if (!text) throw new CourseIngestError("empty_document", "文件内容为空");
		return { text };
	}

	// DOCX is extracted in-process: LiteParse would require LibreOffice, which is
	// not part of this deployment. Word stores no page numbers, so none are
	// reported and the passage builder must not invent them.
	if (format.sourceType === "word") {
		try {
			return { text: extractDocxText(input.data) };
		} catch (err) {
			const message = err instanceof DocxExtractError ? err.message : "DOCX 解析失败";
			throw new CourseIngestError("parse_failed", message, { retryable: false });
		}
	}

	// Parsing needs a real file. The raw copy is the preserved original anyway;
	// a duplicate upload removes this extra copy below.
	const rawPath = await saveRawBufferAsync(
		input.l2DataDir,
		input.title ?? defaultTitle(input.fileName),
		input.data,
		format.sourceType,
		input.fileName,
	);
	try {
		const parsed = await parseDocument(join(input.l2DataDir, rawPath));
		return {
			text: parsed.text,
			pages: parsed.pages.filter((page) => page.text.trim()).map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
			pageCount: parsed.pageCount,
			rawPath,
		};
	} catch (err) {
		// No manifest record exists yet, so this copy cannot be retried by id.
		// Removing it keeps a corrupt upload from accumulating orphan originals.
		await rm(join(input.l2DataDir, rawPath), { force: true }).catch(() => undefined);
		throw new CourseIngestError("parse_failed", safeError(err), { retryable: true });
	}
}

export async function ingestCourseDocument(input: IngestCourseDocumentInput): Promise<IngestCourseDocumentResult> {
	if (input.data.byteLength > MAX_UPLOAD_BYTES) {
		throw new CourseIngestError("file_too_large", "文件超过 100MB 上限");
	}
	if (!input.fileName.trim()) throw new CourseIngestError("unsupported_format", "缺少文件名");
	const format = formatOf(input.fileName);
	const title = (input.title?.trim() || defaultTitle(input.fileName)).slice(0, MAX_TITLE_CHARS);

	const extracted = await extractText({ ...input, title }, format);
	const contentHash = contentHashOf(extracted.text);
	const manifest = await readManifestAsync(input.l2DataDir);
	const existing = manifest.find((entry) => entry.contentHash === contentHash);
	const duplicate = existing?.status === "indexed";
	if (duplicate) {
		// A duplicate must not leave another raw copy behind.
		if (extracted.rawPath) await rm(join(input.l2DataDir, extracted.rawPath), { force: true }).catch(() => undefined);
		return {
			sourceId: existing!.id,
			title: existing!.title,
			status: "indexed",
			duplicate: true,
			passageCount: existing!.passageCount ?? existing!.passagePages?.length ?? 0,
			...(existing!.pageCount !== undefined ? { pageCount: existing!.pageCount } : {}),
			sourceType: existing!.sourceType,
		};
	}

	const id = existing?.id ?? `l2src_${randomUUID().slice(0, 8)}`;
	// A retry of the same bytes reuses its raw file; a new upload stores its own.
	const rawPath = extracted.rawPath
		?? (existing?.contentHash === contentHash && existing.rawPath
			? existing.rawPath
			: await saveRawTextAsync(input.l2DataDir, title, extracted.text, format.sourceType));
	const extractedPath = existing?.contentHash === contentHash && existing.extractedPath
		? existing.extractedPath
		: await convertToExtractedAsync(input.l2DataDir, title, extracted.text, format.sourceType);

	const entry: ManifestEntry = {
		...existing,
		id,
		title,
		sourceType: format.sourceType,
		rawPath,
		extractedPath,
		wikiPages: existing?.wikiPages ?? [],
		passagePages: existing?.passagePages ?? [],
		tags: existing?.tags ?? [],
		contentHash,
		status: "extracted",
		source: {
			...existing?.source,
			origin: "user_upload",
			identity: input.fileName.trim(),
		},
		createdAt: existing?.createdAt ?? new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...(extracted.pageCount !== undefined ? { pageCount: extracted.pageCount } : {}),
	};

	return finishIngest(input.l2DataDir, entry, extracted.text, extracted.pages, false);
}

function stripRawFrontmatter(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

/** Retry a failed source from its extracted text (or its preserved original). */
export async function reingestSource(l2DataDir: string, sourceId: string): Promise<IngestCourseDocumentResult> {
	const manifest = await readManifestAsync(l2DataDir);
	const entry = manifest.find((candidate) => candidate.id === sourceId);
	if (!entry) throw new CourseIngestError("source_not_found", "资料来源不存在");
	if (entry.status === "indexed" && entry.passageCount && entry.passagePages?.length) {
		return {
			sourceId: entry.id,
			title: entry.title,
			status: "indexed",
			duplicate: true,
			passageCount: entry.passageCount,
			...(entry.pageCount !== undefined ? { pageCount: entry.pageCount } : {}),
			sourceType: entry.sourceType,
		};
	}

	let text: string | undefined;
	let pages: Array<{ pageNumber: number; text: string }> | undefined;
	if (entry.extractedPath) {
		text = (await readTextAsync(join(l2DataDir, entry.extractedPath))).trim() || undefined;
	}
	if (!text && entry.sourceType === "word") {
		try {
			text = extractDocxText(await readFile(join(l2DataDir, entry.rawPath)));
		} catch (err) {
			throw new CourseIngestError(
				"not_retryable",
				err instanceof DocxExtractError ? err.message : "DOCX 原文不可用，无法重试",
				{ sourceId, retryable: false },
			);
		}
	}
	if (!text && entry.sourceType === "pdf") {
		const parsed = await parseDocument(join(l2DataDir, entry.rawPath));
		text = parsed.text;
		pages = parsed.pages.filter((page) => page.text.trim()).map((page) => ({ pageNumber: page.pageNumber, text: page.text }));
		entry.pageCount = parsed.pageCount;
	}
	if (!text) {
		const raw = await readTextAsync(join(l2DataDir, entry.rawPath));
		text = stripRawFrontmatter(raw) || undefined;
	}
	if (!text) throw new CourseIngestError("not_retryable", "原始文件与提取文本均不可用，无法重试", { sourceId, retryable: false });

	return finishIngest(l2DataDir, entry, text, pages, false);
}
