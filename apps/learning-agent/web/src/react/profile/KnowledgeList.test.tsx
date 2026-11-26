// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { KnowledgeList } from "./KnowledgeList.js";
import type { KnowledgeState, KnowledgeStateLabel } from "../../types/learner.js";

/**
 * E4.9i-P2-2 — the knowledge list as its own unit.
 *
 * The list was carved out of `LearnerProfilePanel` so that the row's three
 * modes (collapsed → reading → editing) could be tested without mounting the
 * whole profile page. These cases cover the list itself; the container wiring
 * (store calls, course scoping) is covered by the page-level suites.
 */

const knowledge = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
	concept_name: patch.concept_id,
	domain: "cet4",
	mastery: 0.5,
	confidence: 0.5,
	stability: 0.5,
	evidence_ids: [],
	diagnosis: "诊断文本",
	next_actions: ["下一步动作"],
	...patch,
});

const rowButton = (name: string) => screen.getByText(name).closest("button")!;

beforeEach(async () => {
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("KnowledgeList", () => {
	it("T01 renders the empty state for an empty list", () => {
		render(<KnowledgeList states={[]} />);
		expect(screen.getByText("暂未追踪任何概念。")).toBeTruthy();
	});

	it("T02 renders a single concept", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} />);
		expect(screen.getByText("c1")).toBeTruthy();
	});

	it("T03 keeps the server's order", () => {
		render(<KnowledgeList states={[
			knowledge({ concept_id: "alpha" }),
			knowledge({ concept_id: "beta" }),
			knowledge({ concept_id: "gamma" }),
		]} />);
		const names = screen.getAllByText(/^(alpha|beta|gamma)$/).map((el) => el.textContent);
		expect(names).toEqual(["alpha", "beta", "gamma"]);
	});

	it("T04 shows only the summary line by default", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", diagnosis: "只读诊断" })]} />);
		expect(screen.getByText("c1")).toBeTruthy();
		expect(screen.queryByText("只读诊断")).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
	});

	it("T05 opens the reading detail on click", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", diagnosis: "只读诊断", next_actions: ["先做提取"] })]} />);
		fireEvent.click(rowButton("c1"));
		expect(screen.getByText("只读诊断")).toBeTruthy();
		expect(screen.getByText("先做提取")).toBeTruthy();
	});

	it("T06 the reading detail has no editable inputs", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowButton("c1"));
		expect(screen.queryByRole("slider")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
		// …but the explicit edit entry exists.
		expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
	});

	it("T07 the form appears only after pressing 编辑", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowButton("c1"));
		expect(screen.queryByRole("slider")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		expect(screen.getByRole("slider")).toBeTruthy();
		expect(screen.getAllByRole("textbox")).toHaveLength(2);
	});

	it("T08 initialises the form from the saved values", () => {
		render(<KnowledgeList
			states={[knowledge({ concept_id: "c1", mastery: 0.37, diagnosis: "旧诊断", next_actions: ["旧建议"] })]}
			onSave={vi.fn()}
		/>);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("37");
		expect(screen.getByDisplayValue("旧诊断")).toBeTruthy();
		expect(screen.getByDisplayValue("旧建议")).toBeTruthy();
	});

	it("T09/T10/T11 edit mastery, diagnosis and next actions in the draft only", () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));

		fireEvent.change(screen.getByRole("slider"), { target: { value: "80" } });
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "新诊断" } });
		fireEvent.change(screen.getByDisplayValue("下一步动作"), { target: { value: "新建议" } });

		// Nothing is sent while the user is still typing.
		expect(onSave).not.toHaveBeenCalled();
		expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("80");
	});

	it("T12 sends exactly the three editable fields", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		render(<KnowledgeList
			states={[knowledge({ concept_id: "c1", mastery: 0.4, diagnosis: "旧诊断", next_actions: ["旧建议"] })]}
			onSave={onSave}
		/>);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(onSave).toHaveBeenCalledWith("c1", {
			diagnosis: "旧诊断",
			nextActions: ["旧建议"],
			mastery: 0.4,
		}));
	});

	it("T13 returns to reading after a successful save", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
	});

	it("T14/T15 keeps the draft and shows an error when saving fails", async () => {
		const onSave = vi.fn().mockRejectedValue(new Error("网络中断"));
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "没保存的诊断" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("保存失败");
		expect(screen.getByDisplayValue("没保存的诊断")).toBeTruthy();
		// Still editable, so the user can retry.
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("T16 retries after a failure and succeeds", async () => {
		const onSave = vi.fn()
			.mockRejectedValueOnce(new Error("网络中断"))
			.mockResolvedValueOnce(undefined);
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await screen.findByRole("alert");

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(onSave).toHaveBeenCalledTimes(2);
	});

	it("T17 cancelling an unchanged draft leaves editing without asking", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(confirm).not.toHaveBeenCalled();
		expect(screen.queryByRole("slider")).toBeNull();
		expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
	});

	it("T18/T19 a changed draft asks before discarding, and a refusal keeps it", () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={vi.fn()} />);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "改过的诊断" } });

		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(confirm).toHaveBeenCalledOnce();
		expect(screen.getByDisplayValue("改过的诊断")).toBeTruthy();

		confirm.mockReturnValue(true);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(screen.queryByRole("slider")).toBeNull();
		// Back in reading mode with the *saved* text, not the draft.
		expect(screen.getByText("诊断文本")).toBeTruthy();
	});

	it("T20 a draft stays with its own row and never reaches another one", () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		render(<KnowledgeList states={[
			knowledge({ concept_id: "alpha", diagnosis: "A 诊断" }),
			knowledge({ concept_id: "beta", diagnosis: "B 诊断" }),
		]} onSave={onSave} />);

		// Each row owns its mode (unchanged from P1), so opening beta must not
		// transplant alpha's draft: beta shows its own read view, and saving
		// beta must send beta's values.
		fireEvent.click(rowButton("alpha"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("A 诊断"), { target: { value: "A 草稿" } });

		fireEvent.click(rowButton("beta"));
		// Beta's own row carries its own text; alpha's draft stays in alpha.
		const betaRow = rowButton("beta").parentElement!;
		expect(betaRow.textContent).toContain("B 诊断");
		expect(betaRow.textContent).not.toContain("A 草稿");

		// Both rows can be open at once (each owns its mode), so target beta's
		// own form: its save must send beta's values, never alpha's draft.
		const betaForm = rowButton("beta").parentElement!;
		fireEvent.click([...betaForm.querySelectorAll("button")].find((b) => b.textContent?.trim() === "编辑")!);
		fireEvent.click([...betaForm.querySelectorAll("button")].find((b) => b.textContent?.trim() === "保存")!);
		return waitFor(() => expect(onSave).toHaveBeenCalledWith("beta", {
			diagnosis: "B 诊断",
			nextActions: ["下一步动作"],
			mastery: 0.5,
		}));
	});

	it("T22 a second submit while saving is ignored", async () => {
		let resolveSave: () => void = () => {};
		const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} onSave={onSave} />);
		fireEvent.click(rowButton("c1"));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));

		const save = screen.getByRole("button", { name: "保存" });
		fireEvent.click(save);
		// The button is disabled while in flight, so a double click cannot re-enter.
		await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
		fireEvent.click(save);
		expect(onSave).toHaveBeenCalledTimes(1);

		await act(async () => { resolveSave(); });
	});

	it("T23 renders all six states", () => {
		render(<KnowledgeList states={[
			knowledge({ concept_id: "a", state_label: "unknown" }),
			knowledge({ concept_id: "b", state_label: "learning" }),
			knowledge({ concept_id: "c", state_label: "fragile" }),
			knowledge({ concept_id: "d", state_label: "review_due" }),
			knowledge({ concept_id: "e", state_label: "stable" }),
			knowledge({ concept_id: "f", state_label: "misconception" }),
		]} />);
		for (const label of ["证据不足", "学习中", "不稳定", "待复习", "稳定", "存在误区"]) {
			expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
		}
	});

	it("T24 mastery never decides the state", () => {
		render(<KnowledgeList states={[
			knowledge({ concept_id: "low-learning", mastery: 0.05, state_label: "learning" }),
			knowledge({ concept_id: "high-review", mastery: 0.85, state_label: "review_due" }),
			knowledge({ concept_id: "low-stable", mastery: 0.2, state_label: "stable" }),
			knowledge({ concept_id: "high-missing", mastery: 0.95 }),
		]} />);
		const badgeOf = (name: string) => {
			const row = rowButton(name);
			return [...row.querySelectorAll(".mla-badge")].map((b) => b.textContent?.trim());
		};
		expect(badgeOf("low-learning")).toContain("学习中");
		expect(badgeOf("high-review")).toContain("待复习");
		expect(badgeOf("low-stable")).toContain("稳定");
		expect(badgeOf("high-missing")).toContain("证据不足");
	});

	it("T25 without onSave the row is read-only", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} />);
		fireEvent.click(rowButton("c1"));
		expect(screen.getByText("诊断文本")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
	});

	it("T27 renders the English labels after a language switch", async () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", state_label: "learning" })]} />);
		expect(screen.getByText("学习中")).toBeTruthy();
		await act(async () => { await i18n.changeLanguage("en"); });
		await waitFor(() => expect(screen.getByText("Learning")).toBeTruthy());
		expect(screen.queryByText("学习中")).toBeNull();
	});

	it("T28 the row header is a real button with aria-expanded", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} />);
		const header = rowButton("c1");
		expect(header.tagName).toBe("BUTTON");
		expect(header.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(header);
		expect(header.getAttribute("aria-expanded")).toBe("true");
	});
});

/**
 * E4.9i-P2-5 — the responsive structure of the knowledge row.
 *
 * jsdom does no layout, so these cases assert the *structure* the CSS depends on
 * rather than computed widths: the container-query hook, the semantic parts, and
 * the rule that nothing which must stay visible is hidden or dropped. The real
 * widths are measured in `qa_p2_5.py` against Chromium at seven viewports.
 */
describe("E4.9i-P2-5 — knowledge row layout structure", () => {
	const rowOf = (name: string) => rowButton(name).closest(".mla-knowledge-row") as HTMLElement;

	it("L01 puts the container-query context on the list, not the page", () => {
		const { container } = render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} />);
		const list = container.querySelector(".mla-knowledge-list") as HTMLElement;
		expect(list).toBeTruthy();
		// The rows live inside it, so `@container` on the list can see them.
		expect(list.querySelector(".mla-knowledge-row")).toBeTruthy();
	});

	it("L02 renders every part the narrow layout rearranges", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", state_label: "learning" })]} />);
		const row = rowOf("c1");
		for (const part of ["identity", "name", "domain", "mastery", "progress", "percentage", "badge", "toggle"]) {
			expect(row.querySelector(`.mla-knowledge-row__${part}`), part).toBeTruthy();
		}
	});

	it("L03 the header is a grid of the five desktop parts, with the badge present", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", state_label: "learning" })]} />);
		const header = rowOf("c1").querySelector(".mla-knowledge-row__header") as HTMLElement;
		// DOM order drives the desktop grid areas; the badge is second-to-last so
		// a row without a date still places the chevron in the last track.
		const parts = [...header.children].map((child) =>
			[...child.classList].find((c) => c.startsWith("mla-knowledge-row__"))?.replace("mla-knowledge-row__", ""));
		expect(parts).toEqual(["identity", "mastery", "badge", "toggle"]);
	});

	it("L04 a row with a review date adds the date part", () => {
		render(<KnowledgeList states={[
			knowledge({ concept_id: "c1", review_due_at: "2026-12-01T00:00:00.000Z" }),
		]} />);
		const date = rowOf("c1").querySelector(".mla-knowledge-row__date");
		expect(date).toBeTruthy();
		// The label is CSS-hidden on desktop and shown when stacked, so both the
		// label and the value must exist in the DOM.
		expect(date!.querySelector(".mla-knowledge-row__date-label")).toBeTruthy();
		expect(date!.querySelector(".mla-knowledge-row__date-value")?.textContent).toBeTruthy();
	});

	it("L05 a row without a review date renders no empty date placeholder", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} />);
		expect(rowOf("c1").querySelector(".mla-knowledge-row__date")).toBeNull();
		// A dash would read as "no review needed", which is the server's call.
		expect(rowOf("c1").textContent).not.toContain("-");
	});

	it("L06 the badge is never hidden, for any state", () => {
		const labels: KnowledgeStateLabel[] = ["learning", "fragile", "review_due", "misconception", "stable", "unknown"];
		render(<KnowledgeList states={labels.map((label, index) =>
			knowledge({ concept_id: `c${index}`, concept_name: `n${index}`, state_label: label }))} />);
		for (let index = 0; index < labels.length; index += 1) {
			const badge = rowOf(`n${index}`).querySelector(".mla-knowledge-row__badge") as HTMLElement;
			expect(badge, labels[index]).toBeTruthy();
			expect(badge.textContent?.trim()).not.toBe("");
			// No display:none / hidden attribute anywhere on the badge's path.
			expect(badge.getAttribute("hidden")).toBeNull();
			expect(badge.className).not.toContain("hidden");
		}
	});

	it("L07 the name and domain no longer carry a fixed pixel width or truncation", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1" })]} />);
		const row = rowOf("c1");
		for (const part of ["identity", "name", "domain"]) {
			const node = row.querySelector(`.mla-knowledge-row__${part}`) as HTMLElement;
			// The old markup used `w-[170px]` + `truncate`; the class list must not
			// reintroduce either. Wrapping itself is asserted in the browser suite.
			expect(node.className, part).not.toMatch(/w-\[\d+px\]/);
			expect(node.className, part).not.toContain("truncate");
		}
	});

	it("L08 the percentage keeps its full text and no fixed width", () => {
		render(<KnowledgeList states={[
			knowledge({ concept_id: "c1", mastery: 0 }),
			knowledge({ concept_id: "c2", concept_name: "n2", mastery: 1 }),
			knowledge({ concept_id: "c3", concept_name: "n3", mastery: 0.5 }),
		]} />);
		expect(rowOf("c1").querySelector(".mla-knowledge-row__percentage")?.textContent).toBe("0%");
		expect(rowOf("n2").querySelector(".mla-knowledge-row__percentage")?.textContent).toBe("100%");
		expect(rowOf("n3").querySelector(".mla-knowledge-row__percentage")?.textContent).toBe("50%");
		const pct = rowOf("c1").querySelector(".mla-knowledge-row__percentage") as HTMLElement;
		expect(pct.className).not.toMatch(/w-\[\d+px\]/);
	});

	it("L09 the progress bar element exists and takes the mastery width", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", mastery: 0.25 })]} />);
		const bar = rowOf("c1").querySelector(".mla-knowledge-row__bar") as HTMLElement;
		expect(bar).toBeTruthy();
		expect(bar.style.width).toBe("25%");
	});

	it("L10 a long name is rendered in full, not truncated in markup", () => {
		const longName = "这是一个非常非常长的中文知识点名称用来测试换行行为是否正常";
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: longName })]} />);
		// The row shows the name, not the id, so look it up by what it renders.
		const name = rowOf(longName).querySelector(".mla-knowledge-row__name") as HTMLElement;
		expect(name.textContent).toBe(longName);
	});
});

/**
 * E4.9i-P2-5-R1 (F01) — the full concept name is readable.
 *
 * The desktop header still ellipsises a long name to one line (that is the
 * layout P2-5 preserved). Before this the name appeared nowhere else, so a long
 * name could not actually be read — the acceptance report said otherwise. These
 * cases pin the fix: the reading view carries the whole name, unclipped, in both
 * languages, and it does so without turning the row into a second editor.
 *
 * jsdom has no layout, so "wraps instead of clipping" is asserted as *structure*
 * here (the value is complete text in a wrapping-capable node); the real pixel
 * measurement is `p25-r1-*` in `qa_p2_5.py`.
 */
describe("E4.9i-P2-5-R1 — the full name is readable once expanded", () => {
	const LONG_ZH = "这是一个非常非常长的中文知识点名称用来测试换行行为是否正常";
	const LONG_EN = "A very long English concept name that should wrap instead of being clipped";

	const fullNameOf = (name: string) =>
		rowButton(name).parentElement!.querySelector(".mla-knowledge-row__full-name") as HTMLElement | null;

	it("R1-1 the collapsed row does not show the labelled full name", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: LONG_ZH })]} />);
		expect(fullNameOf(LONG_ZH)).toBeNull();
	});

	it("R1-2 expanding a Chinese long name shows it in full", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: LONG_ZH })]} />);
		fireEvent.click(rowButton(LONG_ZH));

		const full = fullNameOf(LONG_ZH);
		expect(full).toBeTruthy();
		// The whole name, not a prefix and not an ellipsis.
		expect(full!.textContent).toContain(LONG_ZH);
		expect(full!.textContent).not.toContain("…");
	});

	it("R1-3 expanding an English long name shows it in full", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: LONG_EN })]} />);
		fireEvent.click(rowButton(LONG_EN));

		const full = fullNameOf(LONG_EN);
		expect(full).toBeTruthy();
		expect(full!.textContent).toContain(LONG_EN);
		expect(full!.textContent).not.toContain("…");
	});

	it("R1-4 the full name carries no truncation class or fixed pixel width", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: LONG_ZH })]} />);
		fireEvent.click(rowButton(LONG_ZH));

		const full = fullNameOf(LONG_ZH)!;
		// `truncate` / `w-[Npx]` would reintroduce exactly the desktop clipping
		// that made the header unreadable in the first place.
		expect(full.className).not.toContain("truncate");
		expect(full.className).not.toMatch(/w-\[\d+px\]/);
	});

	it("R1-5 the name comes from the stored record, not a new source", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: "存储中的名称" })]} />);
		fireEvent.click(rowButton("存储中的名称"));
		expect(fullNameOf("存储中的名称")!.textContent).toContain("存储中的名称");
	});

	it("R1-6 reading the full name does not open an editor", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: LONG_ZH })]} onSave={vi.fn()} />);
		fireEvent.click(rowButton(LONG_ZH));
		// Still the reading view: the full name is information, not a control.
		expect(fullNameOf(LONG_ZH)).toBeTruthy();
		expect(screen.queryByRole("slider")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("R1-7 the full name is present while editing too, so the draft's concept is identifiable", () => {
		render(<KnowledgeList states={[knowledge({ concept_id: "c1", concept_name: LONG_ZH })]} onSave={vi.fn()} />);
		fireEvent.click(rowButton(LONG_ZH));
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		// Editing replaces the read view, so this asserts the header name is still
		// the concept's own name rather than an id fallback.
		const header = rowButton(LONG_ZH).parentElement!
			.querySelector(".mla-knowledge-row__name") as HTMLElement;
		expect(header.textContent).toBe(LONG_ZH);
		expect(screen.getByRole("slider")).toBeTruthy();
	});
});
