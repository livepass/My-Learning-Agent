import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeL2Memory, getL2Memory } from "./l2-memory.js";
import { ingestCourseDocument, reingestSource, CourseIngestError } from "./course-ingest.js";
import { parseFrontmatter } from "./wiki-maintainer.js";

/**
 * E4.2b/c — upload → parse → passages → manifest → index.
 *
 * Real files, real manifest, real SQLite index. Markdown/TXT are exercised
 * end-to-end here; PDF/DOCX parsing is covered separately because it needs a
 * binary fixture and the external parser.
 */

const roots: string[] = [];

async function makeDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "inno-course-ingest-"));
	roots.push(root);
	return join(root, "l2");
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		closeL2Memory(join(root, "l2"));
		await rm(root, { recursive: true, force: true });
	}
});

function markdownDocument(): string {
	const section = (heading: string, sentence: string) =>
		`## ${heading}\n\n${sentence}${"补充说明。".repeat(120)}\n`;
	return [
		"# Python 编程教材",
		"",
		section("第一章 变量与类型", "变量名绑定对象，类型属于对象。"),
		section("第二章 函数", "函数把输入映射为输出，参数按对象引用传递。"),
		section("第三章 装饰器", "装饰器是接收函数并返回函数的高阶函数，可在不修改原函数的情况下增加行为。"),
	].join("\n");
}

describe("course document ingest", () => {
	it("stores, chunks and indexes a markdown document with section locators", async () => {
		const l2 = await makeDir();
		const result = await ingestCourseDocument({
			l2DataDir: l2,
			fileName: "python-textbook.md",
			mimeType: "text/markdown",
			data: Buffer.from(markdownDocument(), "utf-8"),
			title: "Python 教材",
		});

		expect(result).toMatchObject({ status: "indexed", duplicate: false, sourceType: "markdown" });
		expect(result.passageCount).toBeGreaterThan(1);

		const manifest = (await readFile(join(l2, "manifest.jsonl"), "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(manifest).toHaveLength(1);
		expect(manifest[0]).toMatchObject({
			id: result.sourceId,
			title: "Python 教材",
			status: "indexed",
			passageCount: result.passageCount,
			source: { origin: "user_upload", identity: "python-textbook.md" },
		});
		expect(manifest[0].wikiPages).toHaveLength(1);
		expect(manifest[0].passagePages).toHaveLength(result.passageCount);

		// Each passage is a real wiki page carrying the source id and locator.
		for (const pagePath of manifest[0].passagePages.slice(0, 3)) {
			const content = await readFile(join(l2, pagePath), "utf-8");
			const { frontmatter } = parseFrontmatter(content);
			expect(frontmatter?.source_ids).toEqual([result.sourceId]);
			expect(frontmatter?.passage?.source_id).toBe(result.sourceId);
			expect(frontmatter?.passage?.extracted_path).toContain("extracted/");
			// Markdown has no page boundaries: no page number may be invented.
			expect(frontmatter?.passage?.page_start).toBeUndefined();
		}

		const scoped = await getL2Memory(l2).search("装饰器 高阶函数", 5, { sourceIds: [result.sourceId] });
		expect(scoped?.length).toBeGreaterThan(0);
		expect(scoped!.every((hit) => hit.sourceIds.includes(result.sourceId))).toBe(true);
		const other = await getL2Memory(l2).search("装饰器", 5, { sourceIds: ["l2src_other"] });
		expect(other).toEqual([]);
	});

	it("deduplicates identical content without adding a second manifest row", async () => {
		const l2 = await makeDir();
		const input = {
			l2DataDir: l2,
			fileName: "notes.md",
			data: Buffer.from(markdownDocument(), "utf-8"),
			title: "笔记",
		};
		const first = await ingestCourseDocument(input);
		const second = await ingestCourseDocument(input);
		expect(second.duplicate).toBe(true);
		expect(second.sourceId).toBe(first.sourceId);
		const lines = (await readFile(join(l2, "manifest.jsonl"), "utf-8")).trim().split("\n");
		expect(lines).toHaveLength(1);
	});

	it("rejects unsupported and empty files with a stable reason", async () => {
		const l2 = await makeDir();
		await expect(ingestCourseDocument({
			l2DataDir: l2, fileName: "sheet.xlsx", data: Buffer.from("x"), title: "表格",
		})).rejects.toMatchObject({ code: "unsupported_format" });
		await expect(ingestCourseDocument({
			l2DataDir: l2, fileName: "empty.txt", data: Buffer.from("   "), title: "空",
		})).rejects.toMatchObject({ code: "empty_document" });
		expect(await readFile(join(l2, "manifest.jsonl"), "utf-8").catch(() => "")).toBe("");
	});

	it("retries an existing source without duplicating it", async () => {
		const l2 = await makeDir();
		const first = await ingestCourseDocument({
			l2DataDir: l2, fileName: "notes.md", data: Buffer.from(markdownDocument(), "utf-8"), title: "笔记",
		});
		const retried = await reingestSource(l2, first.sourceId);
		expect(retried).toMatchObject({ sourceId: first.sourceId, status: "indexed", duplicate: true });
		const lines = (await readFile(join(l2, "manifest.jsonl"), "utf-8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		await expect(reingestSource(l2, "l2src_missing")).rejects.toMatchObject({ code: "source_not_found" });
	});

	it("keeps a TXT upload searchable and exposes no page locator", async () => {
		const l2 = await makeDir();
		const text = `导数与极限\n\n${"导数描述函数在某一点的瞬时变化率。".repeat(100)}`;
		const result = await ingestCourseDocument({
			l2DataDir: l2, fileName: "calculus.txt", data: Buffer.from(text, "utf-8"), title: "高数笔记",
		});
		expect(result.sourceType).toBe("text");
		const hits = await getL2Memory(l2).search("瞬时变化率", 5, { sourceIds: [result.sourceId] });
		expect(hits?.length).toBeGreaterThan(0);
	});
});

describe("course ingest error shape", () => {
	it("maps an unsupported format to a retryable=false error", () => {
		const error = new CourseIngestError("unsupported_format", "x");
		expect(error.retryable).toBe(false);
	});
});

/** A minimal, valid one-page PDF (ASCII text, Type1 font) — no external package. */
function minimalPdf(text: string): Buffer {
	const stream = `BT /F1 14 Tf 50 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
	const objects: Record<number, string> = {
		1: "<< /Type /Catalog /Pages 2 0 R >>",
		2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		4: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	};
	let out = "%PDF-1.4\n";
	const offsets: number[] = [0];
	for (let index = 1; index <= 5; index += 1) {
		offsets[index] = Buffer.byteLength(out);
		out += `${index} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(out);
	out += "xref\n0 6\n0000000000 65535 f \n";
	for (let index = 1; index <= 5; index += 1) out += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

describe("PDF ingest", () => {
	// This is the only test that loads the real LiteParse parser (a heavy
	// native/WASM module imported on first use) and then indexes the result in
	// SQLite. Alone it takes ~0.5s, but under the full suite's parallel load the
	// first import has been observed at 13s and 24s, well past the 5s default.
	// The work is genuine, so the timeout is raised rather than mocked away.
	it("parses a real PDF and records the parser's page number", async () => {
		const l2 = await makeDir();
		const result = await ingestCourseDocument({
			l2DataDir: l2,
			fileName: "calculus.pdf",
			mimeType: "application/pdf",
			data: minimalPdf("Derivative measures the instantaneous rate of change."),
			title: "高数讲义",
		});
		expect(result).toMatchObject({ status: "indexed", sourceType: "pdf", pageCount: 1 });
		expect(result.passageCount).toBeGreaterThan(0);

		const manifest = (await readFile(join(l2, "manifest.jsonl"), "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
		const passagePath = manifest[0].passagePages[0] as string;
		const { frontmatter } = parseFrontmatter(await readFile(join(l2, passagePath), "utf-8"));
		expect(frontmatter?.passage?.page_start).toBe(1);
		expect(frontmatter?.passage?.page_end).toBe(1);

		const hits = await getL2Memory(l2).search("instantaneous rate", 5, { sourceIds: [result.sourceId] });
		expect(hits?.length).toBeGreaterThan(0);
		expect(await getL2Memory(l2).search("instantaneous rate", 5, { sourceIds: ["l2src_other"] })).toEqual([]);
	}, 60_000);
});

/** A minimal stored-entry ZIP (method 0) — enough for the DOCX text reader. */
function minimalDocx(text: string): Buffer {
	const files: Array<{ name: string; content: string }> = [
		{ name: "[Content_Types].xml", content: "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>" },
		{ name: "_rels/.rels", content: "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>" },
		{
			name: "word/document.xml",
			content: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
		},
	];
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const data = Buffer.from(file.content, "utf8");
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(0, 8); // method: stored
		local.writeUInt16LE(0, 10); // mod time
		local.writeUInt16LE(0, 12); // mod date
		local.writeUInt32LE(0, 14); // crc (reader does not verify)
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8); // flags
		central.writeUInt16LE(0, 10); // method
		central.writeUInt16LE(0, 12); // mod time
		central.writeUInt16LE(0, 14); // mod date
		central.writeUInt32LE(0, 16); // crc
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal
		central.writeUInt32LE(0, 38); // external
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + data.length;
	}
	const centralBuffer = Buffer.concat(centrals);
	const localBuffer = Buffer.concat(locals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(localBuffer.length, 16);
	return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

describe("DOCX ingest", () => {
	it("extracts DOCX text in-process without LibreOffice and invents no page number", async () => {
		const l2 = await makeDir();
		const result = await ingestCourseDocument({
			l2DataDir: l2,
			fileName: "notes.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			data: minimalDocx("DOCX 正文：导数描述瞬时变化率。"),
			title: "DOCX 讲义",
		});
		expect(result).toMatchObject({ status: "indexed", sourceType: "word" });
		expect(result.pageCount).toBeUndefined();

		const manifest = (await readFile(join(l2, "manifest.jsonl"), "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
		const { frontmatter } = parseFrontmatter(await readFile(join(l2, manifest[0].passagePages[0]), "utf-8"));
		expect(frontmatter?.passage?.page_start).toBeUndefined();
		const hits = await getL2Memory(l2).search("瞬时变化率", 5, { sourceIds: [result.sourceId] });
		expect(hits?.length).toBeGreaterThan(0);
	});
});
