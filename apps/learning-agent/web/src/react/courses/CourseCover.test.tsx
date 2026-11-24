// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import { CourseCover, TaskCover, coverClass, coverVariant } from "./CourseCover.js";

/**
 * UI-C01 — one course identity glyph.
 *
 * The tile used to render the title's first character, so Chinese and Latin
 * courses looked like two different products (`同` / `机` vs `P` / `D`). These
 * cases pin the shared glyph, the decorative semantics and the stable palette
 * index that keeps a course's colour after a reload.
 */

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

const tile = (container: HTMLElement) => container.querySelector(".mla-today-cover") as HTMLElement;

describe("CourseCover — shared glyph", () => {
	it("renders the same icon for a Chinese and an English course", () => {
		const { container: zh } = render(<CourseCover course={{ course_id: "course_cn", title: "同义替换" }} />);
		const zhIcon = tile(zh).querySelector("svg");
		expect(zhIcon).toBeTruthy();
		// The lucide icon carries its own class; the title's first character is gone.
		expect(zhIcon!.getAttribute("class")).toContain("lucide-book-marked");
		expect(tile(zh).textContent).toBe("");
		cleanup();

		const { container: en } = render(<CourseCover course={{ course_id: "course_en", title: "Python Basics" }} />);
		const enIcon = tile(en).querySelector("svg");
		expect(enIcon).toBeTruthy();
		expect(enIcon!.getAttribute("class")).toBe(zhIcon!.getAttribute("class"));
		expect(tile(en).textContent).toBe("");
	});

	it("never falls back to a title character for a single-character or empty title", () => {
		const { container } = render(<CourseCover course={{ course_id: "course_odd", title: "数" }} />);
		expect(tile(container).textContent).toBe("");
		expect(tile(container).querySelector("svg")).toBeTruthy();
	});

	it("keeps the palette index stable for the same course id", () => {
		const course = { course_id: "course_python", title: "Python 编程" };
		expect(coverVariant(course)).toBe(coverVariant({ ...course }));
		expect(coverClass(course)).toBe(`is-cover-${coverVariant(course)}`);
		// Different ids can differ, but every variant stays inside the 1..3 palette.
		const variants = ["a", "b", "c", "d", "e"].map((id) =>
			coverVariant({ course_id: `course_${id}`, title: "课程" }));
		for (const variant of variants) expect([1, 2, 3]).toContain(variant);
	});

	it("keeps both sizes on the same decorative tile", () => {
		const { container: sm } = render(<CourseCover course={{ course_id: "course_sm", title: "同义替换" }} size="sm" />);
		expect(tile(sm).className).toContain("mla-today-cover--sm");
		cleanup();
		const { container: md } = render(<CourseCover course={{ course_id: "course_md", title: "同义替换" }} size="md" />);
		expect(tile(md).className).toContain("mla-today-cover--md");
	});

	it("stays decorative: no accessible name is invented for the tile", () => {
		const { container } = render(<CourseCover course={{ course_id: "course_cn", title: "同义替换" }} />);
		expect(tile(container).getAttribute("aria-hidden")).toBe("true");
	});
});

describe("TaskCover — stage and duration", () => {
	it("shows a real stage title and the estimated minutes", () => {
		const { container } = render(
			<TaskCover course={{ course_id: "course_cn", title: "同义替换" }} stage="第一阶段：词义辨析" minutes={25} />,
		);
		expect(container.querySelector(".mla-today-cover-kicker")?.textContent).toBe("第一阶段：词义辨析");
		expect(container.querySelector(".mla-today-cover-minutes")?.textContent).toBe("25 分钟");
	});

	it("does not repeat the course title when the server has no stage", () => {
		const { container } = render(
			<TaskCover course={{ course_id: "course_cn", title: "同义替换" }} minutes={25} />,
		);
		expect(container.querySelector(".mla-today-cover-kicker")).toBeNull();
		expect(container.querySelector(".mla-today-cover-minutes")?.textContent).toBe("25 分钟");
	});

	it("does not repeat a stage that is the course title", () => {
		const { container } = render(
			<TaskCover course={{ course_id: "course_cn", title: "同义替换" }} stage="同义替换" minutes={10} />,
		);
		expect(container.querySelector(".mla-today-cover-kicker")).toBeNull();
	});
});
