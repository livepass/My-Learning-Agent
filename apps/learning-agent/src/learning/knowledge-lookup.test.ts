import { describe, expect, it } from "vitest";
import { adoptableExcerpt, designatedCandidates, retrievalCandidates } from "./knowledge-lookup.js";
import type { ManifestEntry } from "../memory/l2/types.js";

const PAGE = `---
title: 闭包与词法作用域
type: concept
status: draft
contested: false
---

闭包捕获的是变量本身，而不是变量在创建时的值。
`;

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
	return {
		id: "src_closure",
		title: "闭包笔记",
		sourceType: "markdown",
		rawPath: "raw/2026-01-01-closures.md",
		wikiPages: ["wiki/concepts/闭包.md"],
		tags: ["javascript"],
		contentHash: "aaaaaaaaaaaaaaaa",
		status: "indexed",
		source: { origin: "user_upload", identity: "闭包笔记.md" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

const pages: Record<string, string> = { "wiki/concepts/闭包.md": PAGE };
const deps = {
	manifest: async () => [entry()],
	page: async (_dir: string, path: string) => pages[path] ?? null,
};

describe("designated candidates", () => {
	it("resolves by source id, content hash and source identity", async () => {
		for (const designation of [
			{ by: "source_id" as const, value: "src_closure" },
			{ by: "content_hash" as const, value: "aaaaaaaaaaaaaaaa" },
			{ by: "source_identity" as const, value: "闭包笔记.md" },
		]) {
			const candidates = await designatedCandidates("/l2", designation, deps);
			expect(candidates, designation.by).toHaveLength(1);
			expect(candidates[0].found_by).toBe("designated");
			expect(candidates[0].score).toBeNull();
			expect(candidates[0].provenance.source_id).toBe("src_closure");
			// Provenance is copied from the manifest, never invented.
			expect(candidates[0].provenance.original_content_hash).toBe("aaaaaaaaaaaaaaaa");
			expect(candidates[0].provenance.source_identity).toBe("闭包笔记.md");
			expect(candidates[0].snippet.page_path).toBe("wiki/concepts/闭包.md");
		}
	});

	it("returns nothing for a designation the manifest does not contain", async () => {
		expect(await designatedCandidates("/l2", { by: "source_id", value: "src_missing" }, deps)).toEqual([]);
		expect(await designatedCandidates("/l2", { by: "content_hash", value: "9999999999999999" }, deps)).toEqual([]);
		expect(await designatedCandidates("/l2", { by: "source_identity", value: "other.md" }, deps)).toEqual([]);
	});

	it("returns nothing when the entry has no readable page", async () => {
		const noPage = { ...deps, manifest: async () => [entry({ wikiPages: [] })] };
		expect(await designatedCandidates("/l2", { by: "source_id", value: "src_closure" }, noPage)).toEqual([]);

		const unreadable = { ...deps, page: async () => null };
		expect(await designatedCandidates("/l2", { by: "source_id", value: "src_closure" }, unreadable)).toEqual([]);
	});

	it("ignores a page that is only frontmatter", async () => {
		const empty = { ...deps, page: async () => "---\ntitle: x\n---\n\n" };
		expect(await designatedCandidates("/l2", { by: "source_id", value: "src_closure" }, empty)).toEqual([]);
	});
});

describe("retrieval candidates", () => {
	const result = (sourceIds: string[], path = "wiki/concepts/闭包.md") => ({
		path, title: "闭包", type: "concept", sourceIds, score: 7.5, via: ["lexical" as const],
	});

	it("attributes a hit only when exactly one manifest source matches", async () => {
		const single = { ...deps, search: async () => [result(["src_closure"])] };
		const ok = await retrievalCandidates("/l2", "闭包", single);
		expect(ok.status).toBe("ok");
		expect(ok.candidates[0].found_by).toBe("retrieval");
		expect(ok.candidates[0].score).toBe(7.5);

		// A merged page must not be pinned onto one arbitrary source.
		const mixed = { ...deps, search: async () => [result(["src_closure", "src_other"])] };
		const skipped = await retrievalCandidates("/l2", "闭包", mixed);
		expect(skipped.candidates).toEqual([]);
		expect(skipped.status).toBe("empty");

		// Nor may an unknown id be attributed to anything.
		const unknown = { ...deps, search: async () => [result(["src_ghost"])] };
		expect((await retrievalCandidates("/l2", "闭包", unknown)).candidates).toEqual([]);
	});

	it("distinguishes no matches from unavailable retrieval", async () => {
		expect((await retrievalCandidates("/l2", "闭包", { ...deps, search: async () => [] })).status).toBe("empty");
		expect((await retrievalCandidates("/l2", "闭包", { ...deps, search: async () => null })).status).toBe("unavailable");
		expect((await retrievalCandidates("/l2", "闭包", {
			...deps, search: async () => { throw new Error("index broken"); },
		})).status).toBe("unavailable");
	});

	it("marks a contested page as contested instead of picking a side", async () => {
		const contestedPage = PAGE.replace("contested: false", "contested: true");
		const contested = { ...deps, page: async () => contestedPage, search: async () => [result(["src_closure"])] };
		const found = await retrievalCandidates("/l2", "闭包", contested);
		expect(found.candidates[0].assessment.contested).toBe(true);
		expect(found.candidates[0].assessment.review_status).toBe("draft");
		expect(found.candidates[0].assessment.availability).toBe("available");
	});
});

describe("excerpt extraction", () => {
	it("strips frontmatter and bounds the adopted text", () => {
		const excerpt = adoptableExcerpt(PAGE);
		expect(excerpt).not.toContain("---");
		expect(excerpt).toContain("闭包捕获的是变量本身");

		const huge = `---\ntitle: x\n---\n\n${"闭".repeat(10_000)}`;
		expect(adoptableExcerpt(huge)!.length).toBe(4_000);
	});

	it("returns null when there is no body", () => {
		expect(adoptableExcerpt("---\ntitle: x\n---\n")).toBeNull();
		expect(adoptableExcerpt("")).toBeNull();
	});
});
