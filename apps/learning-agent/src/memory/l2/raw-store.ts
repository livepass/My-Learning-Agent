import { join, extname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { ensureDir, writeBinaryAsync, writeText, writeTextAsync } from "../../storage/file-store.js";
import type { RawSourceType } from "./types.js";

/** Map source type to subdirectory under raw/. */
const TYPE_DIR_MAP: Record<RawSourceType, string> = {
	text: "uploads",
	markdown: "uploads",
	conversation: "conversations",
	pdf: "uploads",
	word: "uploads",
	image: "uploads",
};

function generateFilename(title: string, sourceType: RawSourceType): string {
	const date = new Date().toISOString().slice(0, 10);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const ext = sourceType === "markdown" ? "md" : "txt";
	return `${date}-${slug}-${randomUUID().slice(0, 6)}.${ext}`;
}

function rawFrontmatter(content: string, sourceType: RawSourceType, sourceUrl?: string): string {
	const today = new Date().toISOString().slice(0, 10);
	const sha256 = createHash("sha256").update(content).digest("hex");
	return [
		"---",
		...(sourceUrl ? [`source_url: ${JSON.stringify(sourceUrl)}`] : []),
		`source_type: ${sourceType}`,
		`ingested: ${today}`,
		`sha256: ${sha256}`,
		"---",
		"",
	].join("\n");
}

const filenameBase = (title: string): string =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);

/** Async text ingest for request paths: original text + ingest frontmatter. */
export async function saveRawTextAsync(
	l2DataDir: string,
	title: string,
	content: string,
	sourceType: RawSourceType,
	sourceUrl?: string,
): Promise<string> {
	const date = new Date().toISOString().slice(0, 10);
	const ext = sourceType === "markdown" ? "md" : "txt";
	const filename = `${date}-${filenameBase(title)}-${randomUUID().slice(0, 6)}.${ext}`;
	const relative = ["raw", TYPE_DIR_MAP[sourceType], filename].join("/");
	await writeTextAsync(join(l2DataDir, relative), rawFrontmatter(content, sourceType, sourceUrl) + content);
	return relative;
}

/**
 * Async binary ingest for request paths: preserve the original bytes under a
 * human-readable name. Extension is validated by the caller (format gate).
 */
export async function saveRawBufferAsync(
	l2DataDir: string,
	title: string,
	data: Uint8Array,
	sourceType: RawSourceType,
	originalFileName: string,
): Promise<string> {
	const date = new Date().toISOString().slice(0, 10);
	const ext = extname(originalFileName).toLowerCase() || (sourceType === "pdf" ? ".pdf" : ".bin");
	const filename = `${date}-${filenameBase(basename(title)) || "upload"}-${randomUUID().slice(0, 6)}${ext}`;
	const relative = ["raw", TYPE_DIR_MAP[sourceType], filename].join("/");
	await writeBinaryAsync(join(l2DataDir, relative), data);
	return relative;
}

/**
 * Save raw content to data/l2/raw/<subdir>/<filename>.
 * Returns the relative path from l2DataDir.
 */
export function saveRaw(
	l2DataDir: string,
	title: string,
	content: string,
	sourceType: RawSourceType,
	sourceUrl?: string,
): string {
	const subdir = TYPE_DIR_MAP[sourceType];
	const dir = join(l2DataDir, "raw", subdir);
	ensureDir(dir);
	const filename = generateFilename(title, sourceType);
	writeText(join(dir, filename), rawFrontmatter(content, sourceType, sourceUrl) + content);
	return join("raw", subdir, filename);
}

/**
 * Copy an original binary file to data/l2/raw/<subdir>/<filename>.
 * Used for PDF/Word/Image files where we preserve the original.
 * Returns the relative path from l2DataDir.
 */
export function saveRawFile(
	l2DataDir: string,
	title: string,
	originalFilePath: string,
	sourceType: RawSourceType,
): string {
	const subdir = TYPE_DIR_MAP[sourceType];
	const dir = join(l2DataDir, "raw", subdir);
	ensureDir(dir);
	const date = new Date().toISOString().slice(0, 10);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const ext = extname(originalFilePath);
	const filename = `${date}-${slug}-${randomUUID().slice(0, 6)}${ext}`;
	copyFileSync(originalFilePath, join(dir, filename));
	return join("raw", subdir, filename);
}
