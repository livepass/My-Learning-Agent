// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider } from "../../test-utils.js";
import i18n from "../../../i18n/index.js";
import type { LearningState } from "../../../api/learning.js";
import { LearnContextSheet } from "./LearnContextSheet.js";

/**
 * E4.9g-P2-3 — the learning-context sheet.
 *
 * The component under test is the presentation shell: modality, focus, close
 * paths and the sections it composes. Business permissions are computed in
 * `LearnPage` (E4.9g-P2-2-R2) and passed in, so these cases pass them
 * explicitly and never re-derive them here.
 */

const activeState = (overrides: Partial<LearningState> = {}): LearningState => ({
	exists: true,
	checkpoint: {
		revision: 3,
		status: "active",
		step: "awaiting_answer",
		updated_at: "2026-11-21T00:00:00.000Z",
		question: { question_id: "q1", question_version: "v1" },
	},
	questions: [{
		question_id: "q1",
		question_version: "v1",
		concept_id: "c1",
		prompt: "为什么交叉验证的方差会随 K 增大而增大？",
		kind: "free_recall",
	}],
	pending_action: "evaluate",
	attempts: [],
	...overrides,
});

const course = {
	course_id: "course_python",
	title: "Python 编程",
	status: "in_progress" as const,
};

function sheet(overrides: Partial<Parameters<typeof LearnContextSheet>[0]> = {}) {
	const props = {
		open: true,
		modal: false,
		currentSessionId: "s1.jsonl",
		course,
		taskTitle: "理解装饰器的求值顺序" as string | null,
		stageTitle: "第二阶段：函数与作用域" as string | null,
		unclassified: false,
		learning: { state: null, isLoading: false, isSaving: false, error: null },
		readOnlySession: false as const,
		canInitialize: true,
		canPause: false,
		canResume: false,
		onClose: vi.fn(),
		onRetry: vi.fn(),
		onInit: vi.fn(),
		onPause: vi.fn(),
		onResume: vi.fn(),
		...overrides,
	};
	return { props, ...renderWithTooltipProvider(<LearnContextSheet {...props} />) };
}

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("LearnContextSheet — modality", () => {
	it("is a non-modal region on desktop and a modal dialog on a phone", () => {
		const desktop = sheet();
		const region = screen.getByRole("region", { name: "学习上下文" });
		// Desktop: readable beside the chat, never claimed as a modal.
		expect(region.getAttribute("aria-modal")).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
		desktop.unmount();

		sheet({ modal: true });
		const dialog = screen.getByRole("dialog", { name: "学习上下文" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		// The phone backdrop is its own close target.
		expect(document.querySelector(".mla-sheet-backdrop")).toBeTruthy();
	});

	it("renders nothing at all while closed, so no hidden control stays in the Tab order", () => {
		sheet({ open: false });

		expect(screen.queryByRole("region", { name: "学习上下文" })).toBeNull();
		expect(screen.queryByRole("button", { name: "关闭学习上下文" })).toBeNull();
		expect(document.querySelector(".mla-sheet")).toBeNull();
	});

	it("moves focus into the sheet and gives it back to the trigger on close", async () => {
		const trigger = document.createElement("button");
		trigger.textContent = "trigger";
		document.body.appendChild(trigger);
		trigger.focus();

		const { props, unmount } = sheet();
		const panel = screen.getByRole("region", { name: "学习上下文" });
		await waitFor(() => expect(document.activeElement).toBe(panel));

		act(() => {
			unmount();
		});
		expect(document.activeElement).toBe(trigger);
		expect(props.onClose).not.toHaveBeenCalled();
		trigger.remove();
	});
});

describe("LearnContextSheet — closing", () => {
	it("closes through the close button", () => {
		const { props } = sheet();

		fireEvent.click(screen.getByRole("button", { name: "关闭学习上下文" }));
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape", () => {
		const { props } = sheet();

		fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on an outside click on desktop but not on a click inside", () => {
		const { props } = sheet();

		const inside = screen.getByRole("heading", { name: "学习上下文" });
		fireEvent.pointerDown(inside);
		expect(props.onClose).not.toHaveBeenCalled();

		fireEvent.pointerDown(document.body);
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on the phone backdrop", () => {
		const { props } = sheet({ modal: true });

		const backdrop = document.querySelector(".mla-sheet-backdrop") as HTMLElement;
		expect(backdrop).toBeTruthy();
		fireEvent.click(backdrop);
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it("keeps Tab inside the sheet when it is modal", () => {
		sheet({ modal: true });
		const panel = screen.getByRole("dialog", { name: "学习上下文" });
		const focusables = Array.from(panel.querySelectorAll<HTMLElement>("button"));
		const last = focusables[focusables.length - 1]!;
		last.focus();

		fireEvent.keyDown(last, { key: "Tab" });
		expect(panel.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).toBe(focusables[0]);
	});
});

describe("LearnContextSheet — content", () => {
	it("names the conversation's course, task and stage", () => {
		sheet();

		const panel = screen.getByRole("region", { name: "学习上下文" });
		expect(within(panel).getByText("Python 编程")).toBeTruthy();
		expect(within(panel).getByText("理解装饰器的求值顺序")).toBeTruthy();
		expect(within(panel).getByText("第二阶段：函数与作用域")).toBeTruthy();
	});

	it("shows free learning when the conversation has no task", () => {
		sheet({ taskTitle: null, stageTitle: null });

		expect(screen.getByText("自由学习")).toBeTruthy();
		expect(screen.queryByText("理解装饰器的求值顺序")).toBeNull();
	});

	it("labels an unclassified conversation instead of naming a course", () => {
		sheet({ course: null, taskTitle: null, stageTitle: null, unclassified: true });

		expect(screen.getByText("未归类对话")).toBeTruthy();
		expect(screen.queryByText("Python 编程")).toBeNull();
	});

	it("says the binding is unconfirmed rather than inventing a course", () => {
		sheet({ course: null, taskTitle: null, stageTitle: null });

		expect(screen.getByText("尚未确认这段会话的课程绑定。")).toBeTruthy();
	});

	it("shows the real checkpoint: step, revision, question and pending action", () => {
		sheet({ learning: { state: activeState(), isLoading: false, isSaving: false, error: null } });

		expect(screen.getByText("为什么交叉验证的方差会随 K 增大而增大？")).toBeTruthy();
		expect(screen.getByText("#3")).toBeTruthy();
		expect(screen.getByText("等待作答")).toBeTruthy();
		expect(screen.getByText(/已保存作答，等待评分/)).toBeTruthy();
	});

	it("shows the loading and error states from the store", () => {
		const first = sheet({ learning: { state: null, isLoading: true, isSaving: false, error: null } });
		expect(screen.getByText("正在读取学习状态…")).toBeTruthy();
		first.unmount();

		sheet({ learning: { state: null, isLoading: false, isSaving: false, error: "学习状态暂时不可用" } });
		expect(screen.getByText("学习状态暂时不可用")).toBeTruthy();
		expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
	});

	it("never initialises on open and only calls the store from the explicit button", () => {
		const { props } = sheet({ learning: { state: { exists: false }, isLoading: false, isSaving: false, error: null } });

		expect(props.onInit).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "初始化学习记录" }));
		expect(props.onInit).toHaveBeenCalledTimes(1);
	});

	it("hides the initialise action when the page says it is not allowed", () => {
		sheet({
			learning: { state: { exists: false }, isLoading: false, isSaving: false, error: null },
			canInitialize: false,
		});

		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
	});

	it("keeps a read-only conversation read-only", () => {
		sheet({
			learning: { state: { exists: false }, isLoading: false, isSaving: false, error: null },
			readOnlySession: "session",
			canInitialize: false,
		});

		expect(screen.getByText(/归档期间不能新建记录/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
	});

	it("routes pause and resume to the page callbacks", () => {
		const pausing = sheet({
			learning: { state: activeState(), isLoading: false, isSaving: false, error: null },
			canPause: true,
		});
		fireEvent.click(screen.getByRole("button", { name: "暂停学习" }));
		expect(pausing.props.onPause).toHaveBeenCalledTimes(1);
		pausing.unmount();

		const paused = sheet({
			learning: {
				state: activeState({
					checkpoint: { revision: 4, status: "paused", step: "conversation", updated_at: "2026-11-21T00:00:00.000Z" },
				}),
				isLoading: false,
				isSaving: false,
				error: null,
			},
			canResume: true,
		});
		fireEvent.click(screen.getByRole("button", { name: "继续学习" }));
		expect(paused.props.onResume).toHaveBeenCalledTimes(1);
	});

	it("does not offer resume for a completed checkpoint", () => {
		// `LearnPage` derives `canPause` / `canResume` from the checkpoint status,
		// so a completed checkpoint arrives with both false. The panel must then
		// show the locked notice and no action.
		sheet({
			learning: {
				state: activeState({
					checkpoint: { revision: 9, status: "completed", step: "feedback", updated_at: "2026-11-21T00:00:00.000Z" },
				}),
				isLoading: false,
				isSaving: false,
				error: null,
			},
			canPause: false,
			canResume: false,
		});

		expect(screen.getByText("检查点已完成，不能恢复。")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "继续学习" })).toBeNull();
		expect(screen.queryByRole("button", { name: "暂停学习" })).toBeNull();
	});

	it("explains the no-session state", () => {
		sheet({ currentSessionId: null, learning: { state: null, isLoading: false, isSaving: false, error: null } });

		expect(screen.getByText("选择课程并开始一段学习对话后，这里会显示学习检查点。")).toBeTruthy();
	});

	it("switches all of its copy with the language", async () => {
		sheet({ learning: { state: activeState(), isLoading: false, isSaving: false, error: null }, canPause: true });

		await act(async () => {
			await i18n.changeLanguage("en");
		});

		expect(screen.getByRole("region", { name: "Learning context" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Close learning context" })).toBeTruthy();
		expect(screen.getByText("Course and task")).toBeTruthy();
		expect(screen.getByText("Learning checkpoint")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Pause learning/ })).toBeTruthy();
	});
});
