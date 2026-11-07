import { describe, expect, it } from "vitest";

import { segmentForFts } from "../l3/sqlite-store.js";
import type { L2IndexStore, L2LexHit, L2PageMeta } from "./l2-index-store.js";
import { searchL2 } from "./l2-search.js";

function page(path: string, title: string, body: string, sourceIds: string[] = [], type = "concept"): L2PageMeta {
	return { path, title, body, sourceIds, type, tags: [] };
}

function lexicalHit(value: L2PageMeta): L2LexHit {
	return { ...value, bm25: -1 };
}

function fakeStore(pages: L2PageMeta[], hits: L2LexHit[]): L2IndexStore {
	return {
		getAllPages: () => pages,
		searchLexical: () => hits,
	} as unknown as L2IndexStore;
}

describe("L2 retrieval", () => {
	it("segments CJK runs into discriminative bigrams", () => {
		expect(segmentForFts("学习计划 Agent42")).toBe("学习 习计 计划 agent42");
	});

	it("expands lexical hits to directly linked pages", async () => {
		const alpha = page("wiki/concepts/alpha.md", "Alpha", "关联 [[Beta]]");
		const beta = page("wiki/concepts/beta.md", "Beta", "Beta details");
		const results = await searchL2(fakeStore([alpha, beta], [lexicalHit(alpha)]), "alpha", { limit: 5 });

		expect(results.map((result) => result.path)).toEqual([alpha.path, beta.path]);
		expect(results[1].via).toContain("graph");
	});

	it("uses shared source provenance as a graph signal", async () => {
		const seed = page("wiki/concepts/seed.md", "Seed", "Seed body", ["source-1"]);
		const sibling = page("wiki/entities/sibling.md", "Sibling", "Sibling body", ["source-1"], "entity");
		const unrelated = page("wiki/entities/other.md", "Other", "Other body", ["source-2"], "entity");
		const results = await searchL2(
			fakeStore([seed, sibling, unrelated], [lexicalHit(seed)]),
			"seed",
			{ limit: 5 },
		);

		expect(results.map((result) => result.path)).toEqual([seed.path, sibling.path]);
		expect(results.find((result) => result.path === sibling.path)?.via).toContain("graph");
	});

	it("restricts lexical candidates and graph expansion to a course's sources", async () => {
		const ownSeed = page("wiki/concepts/own.md", "函数", "函数 定义 域 [[极限]]", ["source-python"]);
		const otherSeed = page("wiki/concepts/other.md", "函数", "函数 定义 域", ["source-math"]);
		// ownSeed links to a page of another course: graph expansion must not
		// follow the link out of scope.
		const outOfScope = page("wiki/concepts/limit.md", "极限", "极限 定义", ["source-math"]);
		const store = fakeStore([ownSeed, otherSeed, outOfScope], [lexicalHit(ownSeed), lexicalHit(otherSeed)]);

		const results = await searchL2(store, "函数", { limit: 5, sourceIds: ["source-python"] });
		expect(results.map((result) => result.path)).toEqual([ownSeed.path]);
		expect(results[0].sourceIds).toEqual(["source-python"]);
	});

	it("treats an empty course scope as no material, not as no filter", async () => {
		const alpha = page("wiki/concepts/alpha.md", "Alpha", "Alpha body", ["source-1"]);
		const results = await searchL2(fakeStore([alpha], [lexicalHit(alpha)]), "alpha", { limit: 5, sourceIds: [] });
		expect(results).toEqual([]);
	});

	it("excludes a page that mixes in-scope and out-of-scope sources", async () => {
		// A merged page cannot be attributed to one course without leaking the
		// other course's text, so E4.2 excludes it from every course scope.
		const shared = page("wiki/concepts/shared.md", "Shared", "Shared body", ["source-1", "source-2"]);
		const results = await searchL2(fakeStore([shared], [lexicalHit(shared)]), "shared", {
			limit: 5,
			sourceIds: ["source-2"],
		});
		expect(results).toEqual([]);
	});

	it("still returns a page whose only source is in scope", async () => {
		const single = page("wiki/concepts/single.md", "Single", "Single body", ["source-2"]);
		const results = await searchL2(fakeStore([single], [lexicalHit(single)]), "single", {
			limit: 5,
			sourceIds: ["source-2"],
		});
		expect(results.map((result) => result.path)).toEqual([single.path]);
	});
});
