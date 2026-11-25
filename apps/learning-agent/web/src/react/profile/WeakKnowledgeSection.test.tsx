// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import type { KnowledgeState } from "../../types/learner.js";
import { WeakKnowledgeSection } from "./WeakKnowledgeSection.js";

/**
 * E4.9i-P2-3 — the weak-knowledge card.
 *
 * The card is display only. These cases pin what it shows (the stored next
 * action, the formal badge, the domain), what it refuses to invent (a
 * suggestion, a state from mastery), and that the three-item cap is a display
 * cut over the server's order rather than a new ranking.
 */

const knowledge = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
	concept_name: patch.concept_id,
	domain: "cet4",
	mastery: 0.5,
	confidence: 0.5,
	stability: 0.5,
	evidence_ids: [],
	diagnosis: "",
	next_actions: [],
	...patch,
});

function renderSection(states: KnowledgeState[], totalConcepts = states.length, unknownCount = 0) {
	return render(
		<WeakKnowledgeSection weakConcepts={states} totalConcepts={totalConcepts} unknownCount={unknownCount} />,
	);
}

/** The strong element holding a concept's display name. */
const nameNode = (name: string) => screen.getByText(name, { selector: "strong" });

beforeEach(async () => {
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("WeakKnowledgeSection", () => {
	it("W01 renders each weak state with its formal badge", () => {
		renderSection([
			knowledge({ concept_id: "a", concept_name: "学习中项", state_label: "learning" }),
			knowledge({ concept_id: "b", concept_name: "不稳定项", state_label: "fragile" }),
			knowledge({ concept_id: "c", concept_name: "待复习项", state_label: "review_due" }),
		]);
		expect(nameNode("学习中项")).toBeTruthy();
		expect(nameNode("不稳定项")).toBeTruthy();
		expect(nameNode("待复习项")).toBeTruthy();
		for (const label of ["学习中", "不稳定", "待复习"]) {
			expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
		}
	});

	it("W01b renders the misconception state, which is also weak", () => {
		renderSection([knowledge({ concept_id: "d", concept_name: "误区项", state_label: "misconception" })]);
		expect(nameNode("误区项")).toBeTruthy();
		expect(screen.getByText("存在误区")).toBeTruthy();
	});

	it("W02 keeps the array order it is given", () => {
		renderSection([
			knowledge({ concept_id: "z", concept_name: "第一", state_label: "learning" }),
			knowledge({ concept_id: "y", concept_name: "第二", state_label: "fragile" }),
			knowledge({ concept_id: "x", concept_name: "第三", state_label: "review_due" }),
		]);
		const names = [...document.querySelectorAll("strong")].map((node) => node.textContent);
		expect(names).toEqual(["第一", "第二", "第三"]);
	});

	it("W03 caps the preview at three and announces the remainder", () => {
		renderSection(
			Array.from({ length: 5 }, (_, index) => knowledge({
				concept_id: `c${index + 1}`,
				concept_name: `概念 ${index + 1}`,
				state_label: "learning",
			})),
		);
		expect(screen.getByText("概念 1", { selector: "strong" })).toBeTruthy();
		expect(screen.getByText("概念 3", { selector: "strong" })).toBeTruthy();
		expect(screen.queryByText("概念 4", { selector: "strong" })).toBeNull();
		expect(screen.getByText(/另有 2 个需要关注的知识点/)).toBeTruthy();
	});

	it("W04 shows no remainder note when three or fewer are shown", () => {
		renderSection(
			Array.from({ length: 3 }, (_, index) => knowledge({
				concept_id: `c${index + 1}`,
				concept_name: `概念 ${index + 1}`,
				state_label: "learning",
			})),
		);
		expect(screen.queryByText(/另有/)).toBeNull();
	});

	it("W05 renders the stored next action verbatim", () => {
		renderSection([
			knowledge({ concept_id: "a", concept_name: "同义替换", state_label: "learning", next_actions: ["先做一次无提示提取。"] }),
		]);
		expect(screen.getByText("下一步动作：先做一次无提示提取。")).toBeTruthy();
	});

	it("W06 shows only the first stored action", () => {
		renderSection([
			knowledge({ concept_id: "a", concept_name: "同义替换", state_label: "learning", next_actions: ["第一步。", "第二步。"] }),
		]);
		expect(screen.getByText(/第一步。/)).toBeTruthy();
		expect(screen.queryByText(/第二步。/)).toBeNull();
	});

	it("W07 shows the empty-action note when next_actions is empty", () => {
		renderSection([
			knowledge({ concept_id: "a", concept_name: "同义替换", state_label: "learning", next_actions: [] }),
		]);
		expect(screen.getByText("暂无记录的下一步动作。")).toBeTruthy();
	});

	it("W08 never substitutes the diagnosis for a next action", () => {
		renderSection([
			knowledge({ concept_id: "a", concept_name: "同义替换", state_label: "learning", diagnosis: "只能部分回忆", next_actions: [] }),
		]);
		expect(screen.queryByText(/只能部分回忆/)).toBeNull();
		expect(screen.getByText("暂无记录的下一步动作。")).toBeTruthy();
	});

	it("W09 renders the domain only when present", () => {
		renderSection([
			knowledge({ concept_id: "a", concept_name: "有领域", state_label: "learning", domain: "cet4" }),
			knowledge({ concept_id: "b", concept_name: "无领域", state_label: "learning", domain: "" }),
		]);
		expect(screen.getByText("cet4")).toBeTruthy();
		// The second row shows no stray domain text.
		const secondRow = nameNode("无领域").closest("div")!;
		expect(secondRow.textContent).not.toContain("cet4");
	});

	it("W10 falls back for a blank concept name without leaking an id", () => {
		renderSection([
			knowledge({ concept_id: "c_123", concept_name: "   ", state_label: "learning" }),
		]);
		expect(screen.getByText("知识点名称待确认", { selector: "strong" })).toBeTruthy();
		expect(screen.queryByText("c_123")).toBeNull();
	});

	it("W11 allows a long name to wrap instead of clipping", () => {
		const longName = "一个非常长的知识点名称用于检查卡片内的换行行为不会裁切内容";
		renderSection([knowledge({ concept_id: "a", concept_name: longName, state_label: "learning" })]);
		const node = nameNode(longName);
		// The class carries the wrap rule; no truncate/nowrap class is present.
		expect(node.className).toContain("[overflow-wrap:anywhere]");
		expect(node.className).not.toContain("truncate");
	});

	it("W12 shows the no-data empty state when nothing is recorded", () => {
		renderSection([], 0, 0);
		expect(screen.getByText(/还没有已记录的知识点/)).toBeTruthy();
	});

	it("W13 shows the no-weak empty state and explains unknown states", () => {
		renderSection([], 2, 2);
		expect(screen.getByText("当前没有标记为需要关注的知识点。")).toBeTruthy();
		expect(screen.getByText(/其中 2 个知识点证据不足/)).toBeTruthy();
	});

	it("W14 omits the unknown note when there are none", () => {
		renderSection([], 2, 0);
		expect(screen.getByText("当前没有标记为需要关注的知识点。")).toBeTruthy();
		expect(screen.queryByText(/证据不足/)).toBeNull();
	});

	it("W15 exposes no write, practice or review control", () => {
		renderSection([knowledge({ concept_id: "a", concept_name: "同义替换", state_label: "learning" })]);
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("W16 never paints a state from mastery — the badge is the only state", () => {
		renderSection([
			knowledge({ concept_id: "a", concept_name: "低掌握稳定", state_label: "stable", mastery: 0.01 }),
			knowledge({ concept_id: "b", concept_name: "高掌握待复习", state_label: "review_due", mastery: 0.99 }),
		]);
		expect(nameNode("低掌握稳定").parentElement!.textContent).toContain("稳定");
		expect(nameNode("高掌握待复习").parentElement!.textContent).toContain("待复习");
	});

	it("W17 renders the English copy after a language switch", async () => {
		renderSection([knowledge({ concept_id: "a", concept_name: "Synonyms", state_label: "learning" })]);
		await act(async () => { await i18n.changeLanguage("en"); });
		expect(screen.getByText("Learning")).toBeTruthy();
		expect(screen.getByText("No next action recorded yet.")).toBeTruthy();
		expect(screen.queryByText("学习中")).toBeNull();
	});
});

/**
 * E4.9i-P2-3-R1 / F02 — abnormal `next_actions` must not crash the card.
 *
 * The fields come from a persisted profile that may predate them or be edited
 * by hand, so the tests build malformed values through a cast; the production
 * type is unchanged. `render` throwing here would take the whole panel down.
 */
describe("WeakKnowledgeSection — abnormal next_actions (R07–R14)", () => {
	/** Render one weak concept whose next_actions is the given abnormal value. */
	function renderWithActions(value: unknown, patch: Partial<KnowledgeState> = {}) {
		const state = knowledge({ concept_id: "a", concept_name: "同义替换", state_label: "learning", ...patch });
		(state as unknown as { next_actions: unknown }).next_actions = value;
		return renderSection([state]);
	}

	const expectEmptyAction = () => {
		expect(screen.getByText("暂无记录的下一步动作。")).toBeTruthy();
		expect(screen.queryByText(/^下一步动作：/)).toBeNull();
	};

	it("R07 shows a single valid action", () => {
		renderWithActions(["完成一道变式练习"]);
		expect(screen.getByText("下一步动作：完成一道变式练习")).toBeTruthy();
	});

	it("R08 shows the empty note for an empty array", () => {
		renderWithActions([]);
		expectEmptyAction();
	});

	it("R09 shows the empty note for undefined", () => {
		renderWithActions(undefined);
		expectEmptyAction();
	});

	it("R10 shows the empty note for null", () => {
		renderWithActions(null);
		expectEmptyAction();
	});

	it("R11 shows the empty note when every entry is blank", () => {
		renderWithActions(["", " "]);
		expectEmptyAction();
	});

	it("R12 shows the first non-blank entry", () => {
		renderWithActions(["", "完成练习"]);
		expect(screen.getByText("下一步动作：完成练习")).toBeTruthy();
	});

	it("R13 degrades safely for a non-array value", () => {
		renderWithActions("完成练习");
		expectEmptyAction();
	});

	it("R14 never substitutes the diagnosis for a missing action", () => {
		renderWithActions(undefined, { diagnosis: "只能部分回忆" });
		expect(screen.queryByText(/只能部分回忆/)).toBeNull();
		expectEmptyAction();
	});

	it("shows only the first valid action, in the stored order", () => {
		renderWithActions(["第一步。", "第二步。"]);
		expect(screen.getByText(/第一步。/)).toBeTruthy();
		expect(screen.queryByText(/第二步。/)).toBeNull();
	});

	it("does not mutate the array it reads", () => {
		const actions = ["", "完成练习"];
		renderWithActions(actions);
		expect(actions).toEqual(["", "完成练习"]);
	});
});

/**
 * E4.9i-P2-3-R1 / F03 — a stored name may be a machine identity.
 *
 * The rule is the practice page's (`trustedConceptLabel`), reused rather than
 * reimplemented, so both surfaces degrade identically.
 */
describe("WeakKnowledgeSection — synthetic concept names (R15–R21)", () => {
	it("R15 shows a normal Chinese name as-is", () => {
		renderSection([knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" })]);
		expect(nameNode("同义替换")).toBeTruthy();
	});

	it("R16 shows a normal English name as-is", () => {
		renderSection([knowledge({ concept_id: "c1", concept_name: "Synonyms", state_label: "learning" })]);
		expect(nameNode("Synonyms")).toBeTruthy();
	});

	it("R17 falls back for an empty name", () => {
		renderSection([knowledge({ concept_id: "c1", concept_name: "", state_label: "learning" })]);
		expect(nameNode("知识点名称待确认")).toBeTruthy();
	});

	it("R18 falls back for a whitespace-only name", () => {
		renderSection([knowledge({ concept_id: "c1", concept_name: "   ", state_label: "learning" })]);
		expect(nameNode("知识点名称待确认")).toBeTruthy();
	});

	it("R19 degrades a derived concept id", () => {
		renderSection([knowledge({ concept_id: "concept_45125622e640", concept_name: "concept_45125622e640", state_label: "learning" })]);
		expect(nameNode("知识点名称待确认")).toBeTruthy();
		expect(screen.queryByText("concept_45125622e640")).toBeNull();
	});

	it("R20 degrades the older spaced machine title", () => {
		renderSection([knowledge({ concept_id: "concept_45125622e640", concept_name: "concept 45125622e640", state_label: "learning" })]);
		expect(nameNode("知识点名称待确认")).toBeTruthy();
		expect(screen.queryByText("concept 45125622e640")).toBeNull();
	});

	it("R21 keeps a legitimate long name intact and wraps it", () => {
		const longName = "一个非常长的知识点名称用于检查卡片内的换行行为不会裁切内容";
		renderSection([knowledge({ concept_id: "c1", concept_name: longName, state_label: "learning" })]);
		const node = nameNode(longName);
		expect(node.className).toContain("[overflow-wrap:anywhere]");
		expect(node.className).not.toContain("truncate");
	});
});
