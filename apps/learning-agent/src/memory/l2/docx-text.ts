import { inflateRawSync } from "node:zlib";

/**
 * E4.2b — minimal DOCX text extraction without LibreOffice.
 *
 * `@llamaindex/liteparse` converts office documents through LibreOffice, which
 * is not available in every deployment. A DOCX is a ZIP containing
 * `word/document.xml`; for course material we only need its text. This reader
 * walks the ZIP central directory (store or deflate entries) and extracts the
 * paragraph/run text. It is deliberately narrow: no images, tables, styles or
 * page layout, and no page numbers (Word pagination is not stored in the XML).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_XML_BYTES = 64 * 1024 * 1024;

export class DocxExtractError extends Error {
	readonly code: "not_docx" | "missing_document" | "corrupt" | "too_large";

	constructor(code: "not_docx" | "missing_document" | "corrupt" | "too_large", message: string) {
		super(message);
		this.name = "DocxExtractError";
		this.code = code;
	}
}

interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	localOffset: number;
}

function findEndOfCentralDirectory(data: Buffer): number {
	const minimum = Math.max(0, data.length - 66_000);
	for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
		if (data.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return -1;
}

function listEntries(data: Buffer): ZipEntry[] {
	const eocd = findEndOfCentralDirectory(data);
	if (eocd < 0) throw new DocxExtractError("not_docx", "文件不是有效的 DOCX（缺少 ZIP 目录）");
	const total = data.readUInt16LE(eocd + 10);
	let cursor = data.readUInt32LE(eocd + 16);
	const entries: ZipEntry[] = [];
	for (let index = 0; index < total; index += 1) {
		if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
			throw new DocxExtractError("corrupt", "DOCX 目录结构损坏");
		}
		const method = data.readUInt16LE(cursor + 10);
		const compressedSize = data.readUInt32LE(cursor + 20);
		const nameLength = data.readUInt16LE(cursor + 28);
		const extraLength = data.readUInt16LE(cursor + 30);
		const commentLength = data.readUInt16LE(cursor + 32);
		const localOffset = data.readUInt32LE(cursor + 42);
		const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		entries.push({ name, method, compressedSize, localOffset });
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function readEntry(data: Buffer, entry: ZipEntry): Buffer {
	const offset = entry.localOffset;
	if (offset + 30 > data.length || data.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
		throw new DocxExtractError("corrupt", "DOCX 条目偏移损坏");
	}
	const nameLength = data.readUInt16LE(offset + 26);
	const extraLength = data.readUInt16LE(offset + 28);
	const start = offset + 30 + nameLength + extraLength;
	const compressed = data.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) return compressed;
	if (entry.method !== 8) throw new DocxExtractError("corrupt", "DOCX 使用了不支持的压缩方式");
	try {
		const inflated = inflateRawSync(compressed);
		if (inflated.byteLength > MAX_XML_BYTES) {
			throw new DocxExtractError("too_large", "DOCX 正文超过可处理的体积上限");
		}
		return inflated;
	} catch (err) {
		if (err instanceof DocxExtractError) throw err;
		throw new DocxExtractError("corrupt", "DOCX 正文解压失败");
	}
}

function decodeXmlEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
		if (entity === "amp") return "&";
		if (entity === "lt") return "<";
		if (entity === "gt") return ">";
		if (entity === "quot") return "\"";
		if (entity === "apos") return "'";
		if (entity.startsWith("#x")) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		if (entity.startsWith("#")) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return whole;
	});
}

/** Extract plain text from a DOCX buffer; paragraphs become newlines. */
export function extractDocxText(data: Uint8Array): string {
	const buffer = Buffer.from(data);
	const entry = listEntries(buffer).find((candidate) => candidate.name === "word/document.xml");
	if (!entry) throw new DocxExtractError("not_docx", "DOCX 缺少 word/document.xml");
	const xml = readEntry(buffer, entry).toString("utf8");
	const text = decodeXmlEntities(
		xml
			.replace(/<w:tab\b[^>]*\/>/g, "\t")
			.replace(/<w:br\b[^>]*\/>/g, "\n")
			.replace(/<\/w:p>/g, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!text) throw new DocxExtractError("missing_document", "DOCX 没有可提取的正文");
	return text;
}
