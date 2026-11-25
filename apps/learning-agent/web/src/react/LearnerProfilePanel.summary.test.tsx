// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "./../i18n/index.js";
import { LearnerProfilePanel } from "./LearnerProfilePanel.js";
import { learnerStore } from "../stores/learner-store.js";
import type { KnowledgeState, LearnerProfile } from "../types/learner.js";

/**
 * 概览摘要 — read by default, edit on request.
 *
 * The section used to render a bare textarea, so an empty profile looked like
 * an unfinished form and every visit put the cursor in a prose field. It is now
 * a reading card with an explicit 「编辑摘要」 step. These cases pin that
 * behaviour and the rules that keep an edit safe: the dirty buffer survives a
 * store refresh, cancel restores the saved text, and a failed save keeps the
 * editor open with the learner's own words.
 */

const learnerApi = vi.hoisted(() => ({
	getLearnerProfile: vi.fn(),
	patchLearnerProfile: vi.fn(),
	getLearningRecommendations: vi.fn(),
}));

vi.mock("../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../api/learner.js")>("../api/learner.js");
	return { ...actual, ...learnerApi };
});

const profile = (summary: string): LearnerProfile => ({
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-01T00:00:00.000Z",
	goals: [],
	knowledge_states: [],
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: summary,
});

beforeEach(() => {
	vi.clearAllMocks();
	learnerStore.profile = null;
	learnerStore.isSaving = false;
	learnerStore.isLoading = false;
	learnerApi.getLearningRecommendations.mockResolvedValue({ recommendations: [], generated_at: "" });
	// The panel loads the profile on mount; without this the store would replace
	// the fixture with `undefined` as soon as the test awaited anything.
	learnerApi.getLearnerProfile.mockImplementation(async () => learnerStore.profile ?? profile(""));
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("profile summary section", () => {
	it("shows a compact empty state instead of a textarea", async () => {
		learnerStore.profile = profile("");
		render(<LearnerProfilePanel />);

		expect(screen.getByText(/还没有学习画像摘要/)).toBeTruthy();
		// Nothing editable is mounted until the learner asks for it.
		expect(screen.queryByRole("textbox", { name: "学习画像摘要" })).toBeNull();
		expect(screen.getByRole("button", { name: "编辑摘要" })).toBeTruthy();
	});

	it("renders a saved summary as reading text with its line breaks preserved", async () => {
		learnerStore.profile = profile("第一段：偏好示例优先。\n第二段：练习以小步为主。");
		render(<LearnerProfilePanel />);

		const text = screen.getByText(/第一段：偏好示例优先/);
		expect(text.textContent).toContain("\n第二段");
		expect(text.className).toContain("whitespace-pre-wrap");
		expect(screen.queryByRole("textbox", { name: "学习画像摘要" })).toBeNull();
	});

	it("opens the editor on request and saves through patchSummary", async () => {
		learnerStore.profile = profile("旧摘要");
		learnerApi.patchLearnerProfile.mockResolvedValue(profile("新摘要"));
		render(<LearnerProfilePanel />);

		fireEvent.click(screen.getByRole("button", { name: "编辑摘要" }));
		const editor = screen.getByRole("textbox", { name: "学习画像摘要" }) as HTMLTextAreaElement;
		expect(editor.value).toBe("旧摘要");
		// E4.9c: the editor uses the shared prose surface, which removes the
		// native resize handle via CSS; the height is set from the content.
		expect(editor.className).toContain("inno-ui-textarea--prose");

		fireEvent.change(editor, { target: { value: "新摘要" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(learnerApi.patchLearnerProfile).toHaveBeenCalledWith({ profile_summary: "新摘要" }));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "学习画像摘要" })).toBeNull());
		expect(await screen.findByText("新摘要")).toBeTruthy();
	});

	it("keeps the editor open with the learner's text when saving fails", async () => {
		learnerStore.profile = profile("旧摘要");
		learnerApi.patchLearnerProfile.mockRejectedValue(new Error("网络中断"));
		render(<LearnerProfilePanel />);

		fireEvent.click(screen.getByRole("button", { name: "编辑摘要" }));
		const editor = screen.getByRole("textbox", { name: "学习画像摘要" });
		fireEvent.change(editor, { target: { value: "还没保存的内容" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("保存失败"));
		// Still editing, text intact, nothing claimed as saved.
		const stillEditing = screen.getByRole("textbox", { name: "学习画像摘要" }) as HTMLTextAreaElement;
		expect(stillEditing.value).toBe("还没保存的内容");
		expect(screen.queryByText("还没保存的内容", { selector: "p" })).toBeNull();
	});

	it("asks before discarding unsaved text, and restores the saved summary on cancel", async () => {
		learnerStore.profile = profile("已保存的摘要");
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<LearnerProfilePanel />);

		fireEvent.click(screen.getByRole("button", { name: "编辑摘要" }));
		const editor = screen.getByRole("textbox", { name: "学习画像摘要" }) as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: "未保存的修改" } });

		// Declining the confirmation keeps the editor and its text.
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(confirm).toHaveBeenCalledOnce();
		expect((screen.getByRole("textbox", { name: "学习画像摘要" }) as HTMLTextAreaElement).value).toBe("未保存的修改");

		// Accepting discards the draft and returns to the reading card.
		confirm.mockReturnValue(true);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(screen.queryByRole("textbox", { name: "学习画像摘要" })).toBeNull();
		expect(screen.getByText("已保存的摘要")).toBeTruthy();
	});

	it("does not let a store refresh overwrite a dirty buffer", async () => {
		learnerStore.profile = profile("旧摘要");
		render(<LearnerProfilePanel />);

		fireEvent.click(screen.getByRole("button", { name: "编辑摘要" }));
		const editor = screen.getByRole("textbox", { name: "学习画像摘要" }) as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: "正在编辑" } });

		// A background refresh lands with different server text. Reassigning the
		// profile and notifying through the public path (the panel re-reads the
		// store snapshot on every change event) is what a real refresh does.
		learnerStore.profile = profile("服务端的新摘要");
		learnerApi.getLearnerProfile.mockResolvedValue(profile("服务端的新摘要"));
		void learnerStore.load();

		await waitFor(() =>
			expect((screen.getByRole("textbox", { name: "学习画像摘要" }) as HTMLTextAreaElement).value).toBe("正在编辑"));
	});

	it("gives the reading card, the empty state and the editor the same width as the stats", () => {
		learnerStore.profile = profile("一段摘要");
		render(<LearnerProfilePanel />);

		const card = screen.getByText("一段摘要").parentElement!;
		// No narrower measure: the summary belongs to the stat block above it.
		expect(card.className).not.toContain("max-w-");

		fireEvent.click(screen.getByRole("button", { name: "编辑摘要" }));
		const editor = screen.getByRole("textbox", { name: "学习画像摘要" });
		expect(editor.parentElement!.className).not.toContain("max-w-");
	});

	it("renders the add-goal button with one plus icon and no literal plus in its label", () => {
		learnerStore.profile = profile("");
		render(<LearnerProfilePanel />);

		const button = screen.getByRole("button", { name: "新增目标" });
		// The icon is the only plus: the label itself must not carry another one.
		expect(button.textContent?.trim()).toBe("新增目标");
		expect(button.querySelectorAll("svg")).toHaveLength(1);
	});
});

/**
 * E4.9i-P2-3 — the overview conclusion and the weak-knowledge card, wired into
 * the panel. The derivation and the two components have their own suites; these
 * cases pin the integration: the four original tiles keep their numbers, the
 * cards sit in the plan-A order, and a failed refresh never turns old data into
 * a fresh conclusion.
 */
describe("profile overview integration", () => {
	const knowledgeState = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
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

	const mixedProfile = (): LearnerProfile => ({
		...profile(""),
		knowledge_states: [
			knowledgeState({ concept_id: "c_stable", concept_name: "稳定项", state_label: "stable" }),
			knowledgeState({ concept_id: "c_learn", concept_name: "学习中项", state_label: "learning", next_actions: ["先做一次无提示提取。"] }),
			knowledgeState({ concept_id: "c_review", concept_name: "待复习项", state_label: "review_due" }),
			knowledgeState({ concept_id: "c_fragile", concept_name: "不稳定项", state_label: "fragile" }),
			knowledgeState({ concept_id: "c_misc", concept_name: "误区项", state_label: "misconception" }),
			knowledgeState({ concept_id: "c_unknown", concept_name: "证据不足项", state_label: "unknown" }),
		],
		misconceptions: [{
			misconception_id: "m1", concept_id: "c_misc", description: "误区", status: "active",
			severity: 0.5, confidence: 0.5, first_seen_at: "", last_seen_at: "", evidence_ids: [], repair_strategy: "",
		}],
	});

	/** The stat tile whose label is `label`. */
	function tileValue(label: string): string | undefined {
		return screen.getByText(label).parentElement?.querySelector(".text-2xl")?.textContent ?? undefined;
	}

	it("I01 keeps the four original tile numbers", () => {
		learnerStore.profile = mixedProfile();
		render(<LearnerProfilePanel />);

		expect(tileValue("活跃目标")).toBe("0");
		expect(tileValue("已追踪概念")).toBe("6");
		expect(tileValue("待复习状态")).toBe("1");
		expect(tileValue("未解决的误解")).toBe("1");
	});

	it("I02 renders the conclusion from the same numbers", async () => {
		learnerStore.profile = mixedProfile();
		render(<LearnerProfilePanel />);

		// The mount read must settle before a conclusion may be drawn.
		expect(await screen.findByText(/共记录 6 个知识点/)).toBeTruthy();
		expect(screen.getByText(/其中 4 个需要关注/)).toBeTruthy();
		expect(screen.getByText(/1 个状态稳定/)).toBeTruthy();
	});

	it("I03 places 需要关注的知识点 after 知识状态 and before 学习目标", () => {
		learnerStore.profile = mixedProfile();
		render(<LearnerProfilePanel />);

		const headings = [...document.querySelectorAll("h4")].map((node) => node.textContent);
		const knowledge = headings.findIndex((title) => title?.includes("知识状态"));
		const weak = headings.findIndex((title) => title?.includes("需要关注的知识点"));
		const goals = headings.findIndex((title) => title?.includes("学习目标"));
		expect(knowledge).toBeGreaterThanOrEqual(0);
		expect(weak).toBeGreaterThan(knowledge);
		expect(goals).toBeGreaterThan(weak);
	});

	it("I04 shows the stored next action in the weak card", async () => {
		learnerStore.profile = mixedProfile();
		render(<LearnerProfilePanel />);
		expect(await screen.findByText("下一步动作：先做一次无提示提取。")).toBeTruthy();
	});

	it("I05 shows the no-data empty states for a profile without knowledge", async () => {
		learnerStore.profile = profile("");
		render(<LearnerProfilePanel />);

		expect(await screen.findByText("还没有已记录的知识点。")).toBeTruthy();
		expect(screen.getByText(/还没有已记录的知识点。形成正式学习记录后/)).toBeTruthy();
	});

	it("I06 suspends the conclusion and the weak advice after a failed refresh", async () => {
		learnerStore.profile = mixedProfile();
		render(<LearnerProfilePanel />);
		// The conclusion is present while the read is healthy.
		expect(await screen.findByText(/共记录 6 个知识点/)).toBeTruthy();

		learnerApi.getLearnerProfile.mockRejectedValue(new Error("网络中断"));
		await act(async () => { await learnerStore.load(); });

		// Old data is still on screen, but it is not described as current…
		expect(screen.getByRole("alert").textContent).toContain("网络中断");
		expect(screen.getByText(/可能已过期/)).toBeTruthy();
		expect(screen.queryByText(/共记录 6 个知识点/)).toBeNull();
		expect(screen.getByText(/已暂停根据旧数据生成学习结论/)).toBeTruthy();
		expect(screen.getByText(/已暂停展示需要关注的知识点/)).toBeTruthy();
		// …the tiles and the knowledge list remain, and no draft is lost.
		expect(tileValue("已追踪概念")).toBe("6");
		expect(screen.getByRole("button", { name: /知识状态/ })).toBeTruthy();
	});

	it("I06b suspends the conclusion while a refresh is in flight", async () => {
		learnerStore.profile = mixedProfile();
		render(<LearnerProfilePanel />);
		expect(await screen.findByText(/共记录 6 个知识点/)).toBeTruthy();

		// A read that never settles keeps the store `isLoading` with the old
		// profile still assigned: that data must not read as the latest result.
		learnerApi.getLearnerProfile.mockImplementation(() => new Promise(() => {}));
		act(() => { void learnerStore.load(); });

		expect(screen.queryByText(/共记录 6 个知识点/)).toBeNull();
		expect(screen.getByText(/暂不生成学习结论/)).toBeTruthy();
		expect(screen.getByText(/暂不展示需要关注的知识点/)).toBeTruthy();
		// Tiles and the knowledge list stay usable during the read.
		expect(tileValue("已追踪概念")).toBe("6");
	});

	it("I07 does not fill a failed first read with local data", async () => {
		learnerApi.getLearnerProfile.mockRejectedValue(new Error("读取失败"));
		render(<LearnerProfilePanel />);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("读取失败"));
		// No profile, so no overview at all — and nothing invented in its place.
		expect(screen.queryByText(/共记录/)).toBeNull();
		expect(screen.queryByText(/已记录的知识点/)).toBeNull();
	});

	it("I08 renders the English conclusion and weak card after a language switch", async () => {
		learnerStore.profile = mixedProfile();
		render(<LearnerProfilePanel />);

		await act(async () => { await i18n.changeLanguage("en"); });

		await waitFor(() => expect(screen.getByText(/6 concepts recorded/)).toBeTruthy());
		expect(screen.getByText("Concepts needing attention")).toBeTruthy();
		expect(screen.getByText(/do not represent practice accuracy/)).toBeTruthy();
	});
});
