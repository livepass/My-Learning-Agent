import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openL2IndexStore, type L2IndexStore, type L2PageDoc } from "./l2-index-store.js";
import { searchL2 } from "./l2-search.js";

/**
 * E4.2a — course scoping inside SQLite FTS.
 *
 * These tests use a real `index.db` (no fake store): the point is that source
 * filtering happens in the WHERE clause, before bm25 ordering and LIMIT. A
 * global top-N made only of another course's pages must not hide the course's
 * own material.
 */

const roots: string[] = [];
const opened: L2IndexStore[] = [];

async function openStore(): Promise<L2IndexStore | null> {
	const root = await mkdtemp(join(tmpdir(), "inno-l2-index-"));
	roots.push(root);
	const store = await openL2IndexStore(join(root, "l2"));
	if (store) opened.push(store);
	return store;
}

afterEach(async () => {
	for (const store of opened.splice(0)) store.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function doc(path: string, title: string, body: string, sourceIds: string[]): L2PageDoc {
	return {
		path,
		title,
		type: "concept",
		tags: [],
		sourceIds,
		body,
		contentHash: `hash-${path}`,
		mtimeMs: 1,
	};
}

describe("L2 index source scope", () => {
	it("finds a course page even when 250 higher-ranked pages belong to another course", async () => {
		const store = await openStore();
		if (!store) return; // node:sqlite unavailable on this runtime

		// Decoys repeat the query token many times → stronger bm25 than the
		// target, which mentions it once. Without SQL-level scoping the target
		// would never enter the global top 200.
		const decoys = Array.from({ length: 250 }, (_, index) =>
			doc(`wiki/concepts/other-${index}.md`, `Other ${index}`, `装饰器 装饰器 装饰器 装饰器 无关内容 ${index}`, ["src_math"]),
		);
		store.upsertPages(decoys);
		store.upsertPage(doc("wiki/concepts/target.md", "Python 装饰器", "装饰器 是接收函数并返回函数的高阶函数", ["src_python"]));

		const scoped = await searchL2(store, "装饰器", { limit: 5, sourceIds: ["src_python"] });
		expect(scoped.map((hit) => hit.path)).toEqual(["wiki/concepts/target.md"]);

		// The same query with a one-result limit still returns the course page:
		// LIMIT is applied after the scope filter, not before it.
		expect(store.searchLexical("装饰器", 1, { sourceIds: ["src_python"] })).toHaveLength(1);
	});

	it("treats an empty scope as no material and a missing scope as legacy global", async () => {
		const store = await openStore();
		if (!store) return;
		store.upsertPage(doc("wiki/concepts/closure.md", "闭包", "闭包捕获变量绑定", ["src_python"]));

		expect(store.searchLexical("闭包", 10, { sourceIds: [] })).toEqual([]);
		expect(store.getPages({ sourceIds: [] })).toEqual([]);
		expect(store.searchLexical("闭包", 10)).toHaveLength(1);
		expect(store.searchLexical("闭包", 10, { sourceIds: ["src_python"] })).toHaveLength(1);
		expect(store.searchLexical("闭包", 10, { sourceIds: ["src_math"] })).toEqual([]);
	});

	it("excludes a mixed-source page instead of leaking the other course", async () => {
		const store = await openStore();
		if (!store) return;
		store.upsertPage(doc("wiki/concepts/mixed.md", "混合页", "导数 与 装饰器 同页", ["src_python", "src_math"]));

		expect(store.searchLexical("导数", 10, { sourceIds: ["src_python"] })).toEqual([]);
		expect(store.searchLexical("导数", 10, { sourceIds: ["src_math"] })).toEqual([]);
		expect(store.getPages({ sourceIds: ["src_python"] })).toEqual([]);
	});

	it("updates page_sources on upsert and removes it on delete", async () => {
		const store = await openStore();
		if (!store) return;
		store.upsertPage(doc("wiki/concepts/rotate.md", "轮换", "闭包 初版", ["src_a"]));
		expect(store.searchLexical("闭包", 10, { sourceIds: ["src_a"] })).toHaveLength(1);
		expect(store.searchLexical("闭包", 10, { sourceIds: ["src_b"] })).toEqual([]);

		store.upsertPage(doc("wiki/concepts/rotate.md", "轮换", "闭包 改版", ["src_b"]));
		expect(store.searchLexical("闭包", 10, { sourceIds: ["src_a"] })).toEqual([]);
		expect(store.searchLexical("闭包", 10, { sourceIds: ["src_b"] })).toHaveLength(1);

		store.deletePage("wiki/concepts/rotate.md");
		expect(store.searchLexical("闭包", 10, { sourceIds: ["src_b"] })).toEqual([]);
	});

	it("does not let a cross-course link pull a page into the scoped graph", async () => {
		const store = await openStore();
		if (!store) return;
		store.upsertPages([
			doc("wiki/concepts/derivative.md", "导数", "导数 定义 [[装饰器]]", ["src_math"]),
			doc("wiki/concepts/decorator.md", "装饰器", "装饰器 定义", ["src_python"]),
		]);

		const math = await searchL2(store, "导数", { limit: 5, sourceIds: ["src_math"] });
		expect(math.map((hit) => hit.path)).toEqual(["wiki/concepts/derivative.md"]);
		const python = await searchL2(store, "导数", { limit: 5, sourceIds: ["src_python"] });
		expect(python).toEqual([]);
	});
});
