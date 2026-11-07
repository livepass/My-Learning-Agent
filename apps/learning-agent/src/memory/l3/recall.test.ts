import { describe, expect, it } from "vitest";
import { recall } from "./recall.js";
import type { L3SearchHit, L3Store } from "./sqlite-store.js";

/**
 * E4.1a — course-scoped L3 recall contract.
 *
 * The L3 index stores chunks per session; the course boundary is applied to
 * the candidate stream by session id, before relevance scoring. These tests
 * pin the contract E4.4 will wire to the persisted course binding.
 */

function hit(sessionId: string, text: string, bm25 = -1): L3SearchHit {
	return { id: `${sessionId}:1`, sessionId, role: "assistant", text, ts: 1, bm25 };
}

function store(hits: L3SearchHit[]): L3Store {
	return { searchLexical: () => hits } as unknown as L3Store;
}

describe("course-scoped recall", () => {
	it("keeps only sessions inside the course scope", () => {
		const results = recall(
			store([
				hit("python.jsonl", "Python 装饰器会返回一个包装函数"),
				hit("math.jsonl", "Python 装饰器在这里只是举例"),
			]),
			"Python 装饰器",
			{ allowedSessionIds: new Set(["python.jsonl"]) },
		);
		expect(results.map((result) => result.sessionId)).toEqual(["python.jsonl"]);
	});

	it("does not fall back to all history for a course with no sessions", () => {
		const results = recall(
			store([hit("math.jsonl", "极限的定义与计算方法")]),
			"极限 定义",
			{ allowedSessionIds: new Set() },
		);
		expect(results).toEqual([]);
	});

	it("keeps the legacy global scope when no course is given", () => {
		const results = recall(
			store([
				hit("a.jsonl", "闭包捕获变量绑定"),
				hit("b.jsonl", "闭包捕获的是变量本身"),
			]),
			"闭包 变量",
		);
		expect(results.map((result) => result.sessionId).sort()).toEqual(["a.jsonl", "b.jsonl"]);
	});

	it("still excludes the active session inside the course scope", () => {
		const results = recall(
			store([
				hit("current.jsonl", "闭包捕获变量绑定"),
				hit("past.jsonl", "闭包捕获的是变量本身"),
			]),
			"闭包 变量",
			{ allowedSessionIds: new Set(["current.jsonl", "past.jsonl"]), excludeSessionId: "current.jsonl" },
		);
		expect(results.map((result) => result.sessionId)).toEqual(["past.jsonl"]);
	});
});
