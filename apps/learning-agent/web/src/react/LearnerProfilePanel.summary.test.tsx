// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./../i18n/index.js";
import { LearnerProfilePanel } from "./LearnerProfilePanel.js";
import { learnerStore } from "../stores/learner-store.js";
import type { LearnerProfile } from "../types/learner.js";

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
		// No native resize handle; the field grows with its content instead.
		expect(editor.style.resize).toBe("none");

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
