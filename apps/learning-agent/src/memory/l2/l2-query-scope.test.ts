import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createL2Tools, type L2CourseScopeResolution } from "./l2-tools.js";
import { upsertManifest } from "./manifest-store.js";
import { writeText } from "../../storage/file-store.js";
import type { L2Memory } from "./l2-memory.js";
import type { L2SearchResult } from "./l2-search.js";

/**
 * E4.2d — `l2_query` must never widen a course session to global material.
 *
 * The tool receives only a server-side resolver; there is no `course_id`
 * parameter the model could set. These tests pin the three scopes and the
 * fail-closed behaviour when the course store cannot be read.
 */

const roots: string[] = [];

function makeDir(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-l2-query-scope-"));
	roots.push(root);
	mkdirSync(join(root, "wiki"), { recursive: true });
	writeFileSync(join(root, "wiki", "index.md"), "# 全局索引\n\n- [[sources/math]]\n");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function memory(root: string, results: L2SearchResult[] | null): L2Memory {
	return {
		dataDir: root,
		search: vi.fn().mockResolvedValue(results),
	} as unknown as L2Memory;
}

function queryTool(resolver?: (sessionId: string | undefined) => Promise<L2CourseScopeResolution>) {
	const root = makeDir();
	const store = memory(root, [{
		path: "wiki/passages/l2src_python/p0001.md",
		title: "Python 教材 · 片段 1",
		type: "passage",
		sourceIds: ["l2src_python"],
		score: 1,
		via: ["lexical"],
	}]);
	writeText(join(root, "wiki/passages/l2src_python/p0001.md"),
		"---\ntitle: Python 教材 · 片段 1\ntype: passage\nsource_ids: [l2src_python]\n---\n\n装饰器是接收函数并返回函数的高阶函数。");
	const tool = createL2Tools(root, undefined, store, undefined, resolver)[1];
	const run = (args: { query?: string }) => (tool.execute as (...input: any[]) => Promise<any>)(
		"call-1", args, undefined, undefined,
		{ sessionManager: { getSessionFile: () => "/data/sessions/s1.jsonl" } },
	);
	return { root, store, run };
}

describe("l2_query course scope", () => {
	it("passes the course's active source ids to the index", async () => {
		const { store, run } = queryTool(async () => ({ status: "course", courseId: "course_py", sourceIds: ["l2src_python"] }));
		const result = await run({ query: "装饰器" });
		expect(store.search).toHaveBeenCalledWith("装饰器", 5, { sourceIds: ["l2src_python"] });
		expect(result.content[0].text).toContain("装饰器是接收函数并返回函数的高阶函数");
		expect(result.details.course_id).toBe("course_py");
	});

	it("refuses to search when the course has no material", async () => {
		const { store, run } = queryTool(async () => ({ status: "course", courseId: "course_py", sourceIds: [] }));
		const result = await run({ query: "装饰器" });
		expect(store.search).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("尚未关联任何资料");
	});

	it("fails closed when the course scope cannot be resolved", async () => {
		const { store, run } = queryTool(async () => { throw new Error("corrupt course store"); });
		const result = await run({ query: "装饰器" });
		expect(store.search).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("课程资料范围暂不可用");
		expect(result.details.error).toBe("course_scope_unavailable");
	});

	it("keeps the legacy global scope for an unclassified session", async () => {
		const { store, run } = queryTool(async () => ({ status: "unclassified" }));
		await run({ query: "装饰器" });
		expect(store.search).toHaveBeenCalledWith("装饰器", 5, {});
	});

	it("shows only course sources in the scoped overview, never the global wiki index", async () => {
		const { root, run } = queryTool(async () => ({ status: "course", courseId: "course_py", sourceIds: ["l2src_python"] }));
		upsertManifest(root, {
			id: "l2src_python",
			title: "Python 教材",
			sourceType: "markdown",
			rawPath: "raw/uploads/python.md",
			wikiPages: [],
			tags: [],
			contentHash: "aaaaaaaaaaaaaaaa",
			status: "indexed",
			passageCount: 3,
			source: { origin: "user_upload", identity: "python.md" },
			createdAt: "2026-11-07T00:00:00.000Z",
			updatedAt: "2026-11-07T00:00:00.000Z",
		});
		const result = await run({ query: "" });
		expect(result.content[0].text).toContain("Python 教材");
		expect(result.content[0].text).not.toContain("高等数学");
		expect(result.content[0].text).not.toContain("全局索引");
	});
});
