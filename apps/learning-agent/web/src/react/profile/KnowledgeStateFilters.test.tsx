// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { KnowledgeStateFilters } from "./KnowledgeStateFilters.js";
import type { KnowledgeFilter, KnowledgeFilterCounts } from "./knowledge-filter.js";

/**
 * E4.9i-P2-4 — the filter row as its own unit.
 *
 * It is controlled and presentational: these cases pin the six options and
 * their order, the single `aria-pressed`, that zero counts stay selectable,
 * and that it reports the choice instead of deciding it.
 */

const counts = (patch: Partial<KnowledgeFilterCounts> = {}): KnowledgeFilterCounts => ({
	all: 8,
	needs_attention: 4,
	review_due: 1,
	misconception: 1,
	stable: 1,
	unknown: 3,
	...patch,
});

function renderFilters(value: KnowledgeFilter = "all", override: Partial<KnowledgeFilterCounts> = {}) {
	const onChange = vi.fn();
	const utils = render(<KnowledgeStateFilters value={value} counts={counts(override)} onChange={onChange} />);
	return { onChange, ...utils };
}

const filterButton = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(async () => {
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("KnowledgeStateFilters", () => {
	it("C01 marks 全部 pressed by default", () => {
		renderFilters();
		expect(filterButton("全部").getAttribute("aria-pressed")).toBe("true");
	});

	it("C02 renders the six options in the documented order", () => {
		renderFilters();
		const names = screen.getAllByRole("button").map((button) => button.textContent?.replace(/\d+$/, "").trim());
		expect(names).toEqual(["全部", "需要关注", "待复习", "存在误区", "稳定", "证据不足"]);
	});

	it("C03 shows each count", () => {
		renderFilters();
		expect(filterButton("全部").textContent).toContain("8");
		expect(filterButton("需要关注").textContent).toContain("4");
		expect(filterButton("待复习").textContent).toContain("1");
		expect(filterButton("证据不足").textContent).toContain("3");
	});

	it("C04 keeps exactly one pressed at a time", () => {
		const { rerender } = renderFilters("stable");
		const pressed = () => screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
		expect(pressed()).toHaveLength(1);
		expect(pressed()[0].textContent).toContain("稳定");

		rerender(<KnowledgeStateFilters value="review_due" counts={counts()} onChange={vi.fn()} />);
		expect(pressed()).toHaveLength(1);
		expect(pressed()[0].textContent).toContain("待复习");
	});

	it("C05 reports the chosen filter on click", () => {
		const { onChange } = renderFilters();
		fireEvent.click(filterButton("存在误区"));
		expect(onChange).toHaveBeenCalledWith("misconception");
	});

	it("C05b activates with the keyboard (native button Enter)", () => {
		const { onChange } = renderFilters();
		const button = filterButton("待复习");
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("type")).toBe("button");
		// jsdom does not synthesise a click from Enter; the browser does. What the
		// test can pin is that the element is a real button, which is what makes
		// Enter/Space work, and that it is focusable.
		button.focus();
		expect(document.activeElement).toBe(button);
	});

	it("C06 allows selecting a filter whose count is zero", () => {
		const { onChange } = renderFilters("all", { review_due: 0 });
		const button = filterButton("待复习");
		expect(button.textContent).toContain("0");
		expect((button as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(button);
		expect(onChange).toHaveBeenCalledWith("review_due");
	});

	it("C08 renders the English labels after a language switch", async () => {
		renderFilters();
		await act(async () => { await i18n.changeLanguage("en"); });
		for (const label of ["All", "Needs attention", "Review due", "Misconception", "Stable", "Insufficient evidence"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${label}`) }), label).toBeTruthy();
		}
		expect(screen.queryByText("全部")).toBeNull();
	});

	it("exposes the group with an accessible name", () => {
		renderFilters();
		const group = screen.getByRole("group", { name: "按知识状态筛选" });
		expect(group).toBeTruthy();
	});

	it("carries the review-due caveat", () => {
		renderFilters();
		expect(screen.getByText("待复习仅表示知识状态分类，不代表已达到正式复习资格。")).toBeTruthy();
	});

	it("never renders the empty-filter message itself", () => {
		// The container owns that state; the row only reports a selection.
		renderFilters("review_due", { review_due: 0 });
		expect(screen.queryByText(/当前筛选下没有知识点/)).toBeNull();
	});
});
