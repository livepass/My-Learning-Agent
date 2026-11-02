import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAttachmentContext,
	parseChatAttachments,
	validateChatAttachments,
	type ChatAttachments,
} from "./attachments.js";
import {
	clearSessionAttachments,
	mergeSessionAttachments,
	recordSessionAttachments,
	resetAttachmentsStoreForTests,
} from "./attachments-store.js";

describe("parseChatAttachments", () => {
	it("returns null for missing or malformed payloads", () => {
		expect(parseChatAttachments(undefined)).toBeNull();
		expect(parseChatAttachments("nope")).toBeNull();
		expect(parseChatAttachments({})).toBeNull();
		expect(parseChatAttachments({ bindings: [], loose: [] })).toBeNull();
	});

	it("parses bindings and loose refs, dropping broken entries", () => {
		const parsed = parseChatAttachments({
			bindings: [
				{ word: "pdf", wordIndex: 2, files: [{ path: "a.pdf", kind: "pdf", source: "workspace" }] },
				{ word: "", files: [{ path: "x" }] },
				{ word: "no-files", files: [] },
				{ word: "doc", files: [{ path: " b.docx ", kind: "bogus" }] },
			],
			loose: [{ path: "c.xlsx", kind: "xls", source: "upload" }, { path: "" }],
		});
		expect(parsed).not.toBeNull();
		expect(parsed!.bindings.map((b) => b.word)).toEqual(["pdf", "doc"]);
		expect(parsed!.bindings[0].wordIndex).toBe(2);
		expect(parsed!.bindings[1].files[0]).toEqual({ path: "b.docx", kind: "file", source: "workspace" });
		expect(parsed!.loose).toEqual([{ path: "c.xlsx", kind: "xls", source: "upload" }]);
	});

	it("normalizes presentation prefixes and Windows separators", () => {
		const parsed = parseChatAttachments({
			loose: [{ path: " .\\docs\\paper.pdf ", kind: "pdf", source: "workspace" }],
		});
		expect(parsed!.loose).toEqual([{ path: "docs/paper.pdf", kind: "pdf", source: "workspace" }]);
	});
});

describe("validateChatAttachments + buildAttachmentContext", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "inno-attachments-"));
		writeFileSync(join(root, "a.pdf"), "pdf");
		writeFileSync(join(root, "b.pdf"), "pdf");
		writeFileSync(join(root, "c.xlsx"), "xls");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("drops refs outside the workspace or pointing at missing files", () => {
		const attachments: ChatAttachments = {
			bindings: [
				{
					word: "pdf",
					wordIndex: 0,
					files: [
						{ path: "a.pdf", kind: "pdf", source: "workspace" },
						{ path: "../escape.pdf", kind: "pdf", source: "workspace" },
						{ path: "missing.pdf", kind: "pdf", source: "workspace" },
					],
				},
				{ word: "gone", wordIndex: 1, files: [{ path: "nope.docx", kind: "doc", source: "upload" }] },
			],
			loose: [{ path: "c.xlsx", kind: "xls", source: "workspace" }, { path: "/etc/passwd", kind: "file", source: "workspace" }],
		};
		const validated = validateChatAttachments(attachments, root);
		expect(validated.bindings).toHaveLength(1);
		expect(validated.bindings[0].files).toEqual([{ path: "a.pdf", kind: "pdf", source: "workspace" }]);
		expect(validated.loose).toEqual([{ path: "c.xlsx", kind: "xls", source: "workspace" }]);

		const context = buildAttachmentContext(validated);
		expect(context).toContain("第1个「pdf」→ a.pdf");
		expect(context).toContain("普通附件");
		expect(context).toContain("- c.xlsx");
		expect(context).not.toContain("escape");
	});

	it("returns an empty context when nothing survives", () => {
		const validated = validateChatAttachments(
			{ bindings: [{ word: "pdf", wordIndex: 0, files: [{ path: "gone.pdf", kind: "pdf", source: "workspace" }] }], loose: [] },
			root,
		);
		expect(validated.bindings).toHaveLength(0);
		expect(buildAttachmentContext(validated)).toBe("");
	});

	it("omits the loose section when only bindings exist", () => {
		const context = buildAttachmentContext({
			bindings: [{ word: "pdf", wordIndex: 0, files: [{ path: "a.pdf", kind: "pdf", source: "workspace" }, { path: "b.pdf", kind: "pdf", source: "workspace" }] }],
			loose: [],
		});
		expect(context).toContain("第1个「pdf」→ a.pdf、b.pdf");
		expect(context).not.toContain("普通附件");
	});

	it("labels repeated keyword occurrences so the model can distinguish their files", () => {
		const context = buildAttachmentContext({
			bindings: [
				{ word: "pdf", wordIndex: 0, files: [{ path: "first.pdf", kind: "pdf", source: "workspace" }] },
				{ word: "pdf", wordIndex: 1, files: [{ path: "second.pdf", kind: "pdf", source: "workspace" }] },
			],
			loose: [],
		});
		expect(context).toContain("第1个「pdf」→ first.pdf");
		expect(context).toContain("第2个「pdf」→ second.pdf");
	});
});

describe("attachments sidecar store", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "inno-attachments-store-"));
		mkdirSync(join(dataDir, "sessions"), { recursive: true });
		resetAttachmentsStoreForTests();
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
		resetAttachmentsStoreForTests();
	});

	const attachments: ChatAttachments = {
		bindings: [{ word: "pdf", wordIndex: 0, files: [{ path: "a.pdf", kind: "pdf", source: "workspace" }] }],
		loose: [],
	};

	it("merges recorded entries into matching user messages FIFO and skips non-matching ones", () => {
		recordSessionAttachments(dataDir, "s1", { promptContent: "请读这份pdf", attachments, timestamp: 1 });
		recordSessionAttachments(dataDir, "s1", { promptContent: "再看一次", attachments, timestamp: 2 });
		recordSessionAttachments(dataDir, "s1", { promptContent: "请读这份pdf", attachments, timestamp: 3 });

		const merged = mergeSessionAttachments(dataDir, "s1", [
			{ role: "assistant", content: "好的", timestamp: 0 },
			{ role: "user", content: "请读这份pdf", timestamp: 1 },
			{ role: "assistant", content: "完成", timestamp: 2 },
			{ role: "user", content: "请读这份pdf", timestamp: 3 },
		]);
		expect(merged[1].attachments).toEqual(attachments);
		expect(merged[3].attachments).toEqual(attachments);
		expect(merged[0].attachments).toBeUndefined();

		// Unmatched entries (no "再看一次" message) stay inert for other sessions.
		const other = mergeSessionAttachments(dataDir, "s2", [
			{ role: "user", content: "请读这份pdf", timestamp: 4 },
		]);
		expect(other[0].attachments).toBeUndefined();
	});

	it("clears entries for a deleted session only", () => {
		recordSessionAttachments(dataDir, "s1", { promptContent: "p", attachments, timestamp: 1 });
		recordSessionAttachments(dataDir, "s2", { promptContent: "p", attachments, timestamp: 2 });
		clearSessionAttachments(dataDir, "s1");
		const merged = mergeSessionAttachments(dataDir, "s1", [{ role: "user", content: "p", timestamp: 1 }]);
		expect(merged[0].attachments).toBeUndefined();
		const kept = mergeSessionAttachments(dataDir, "s2", [{ role: "user", content: "p", timestamp: 2 }]);
		expect(kept[0].attachments).toEqual(attachments);
	});
});
