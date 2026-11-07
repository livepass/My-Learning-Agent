import { describe, expect, it } from "vitest";
import { buildSourcePassages, PassageBuildError } from "./passage-builder.js";

describe("E4.2c passage building", () => {
	it("keeps the document's own heading path for text without pages", () => {
		const text = [
			"# Python 教程",
			"",
			"## 第三章 装饰器",
			"",
			`装饰器是接收函数并返回函数的高阶函数。${"细节说明。".repeat(300)}`,
			"",
			"## 第四章 生成器",
			"",
			`生成器用 yield 逐个产出值。${"继续说明。".repeat(300)}`,
		].join("\n");
		const passages = buildSourcePassages({ text });
		expect(passages.length).toBeGreaterThan(1);
		expect(passages.some((passage) => passage.headingPath.includes("装饰器"))).toBe(true);
		// No page was reported, so none may appear.
		expect(passages.every((passage) => passage.pageStart === undefined)).toBe(true);
	});

	it("carries the parser's page numbers for page-aware documents", () => {
		const pages = [
			{ pageNumber: 12, text: `## 3.1 导数定义\n\n导数描述瞬时变化率。${"说明。".repeat(200)}` },
			{ pageNumber: 13, text: `## 3.2 求导法则\n\n链式法则用于复合函数。${"说明。".repeat(200)}` },
		];
		const passages = buildSourcePassages({ text: pages.map((page) => page.text).join("\n"), pages });
		expect(passages.length).toBeGreaterThanOrEqual(2);
		const first = passages.find((passage) => passage.pageStart === 12);
		expect(first).toBeTruthy();
		expect(first!.pageEnd).toBe(12);
		expect(first!.headingPath).toContain("导数");
		// A page without headings falls back to its page number, not an invented title.
		const noHeading = buildSourcePassages({
			pages: [{ pageNumber: 1, text: "x".repeat(100) }, { pageNumber: 2, text: "y".repeat(100) }],
			text: "",
		});
		expect(noHeading.map((passage) => passage.headingPath)).toEqual(["第 1 页", "第 2 页"]);
	});

	it("refuses an empty document instead of creating an empty source", () => {
		expect(() => buildSourcePassages({ text: "   \n\n" })).toThrow(PassageBuildError);
	});
});
