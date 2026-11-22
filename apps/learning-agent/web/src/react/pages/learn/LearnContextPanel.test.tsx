// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningState } from "../../../api/learning.js";
import { hasRealCheckpoint, LearnContextPanel } from "./LearnContextPanel.js";

const activeState = (overrides: Partial<LearningState> = {}): LearningState => ({
	exists: true,
	checkpoint: {
		revision: 2,
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

function panel(overrides: Partial<Parameters<typeof LearnContextPanel>[0]> = {}) {
	const props = {
		currentSessionId: "s1",
		learning: { state: null, isLoading: false, isSaving: false, error: null },
		readOnlySession: false as const,
		// E4.9g-P2-2-R2: the page decides whether a checkpoint write is allowed;
		// the panel only renders it. These cases exercise the panel's own display
		// states, so the permission default is "allowed".
		canInitialize: true,
		canPause: false,
		canResume: false,
		onRetry: vi.fn(),
		onInit: vi.fn(),
		onPause: vi.fn(),
		onResume: vi.fn(),
		...overrides,
	};
	return { props, ...render(<LearnContextPanel {...props} />) };
}

afterEach(cleanup);

describe("LearnContextPanel — content", () => {
	it("renders its heading as a labelled section, without owning an open state", () => {
		panel();

		// E4.9g-P2-3: open/close moved to `LearnContextSheet`; the panel is
		// content only, so it always renders its body and no toggle.
		const region = screen.getByRole("region", { name: "本次学习" });
		expect(region).toBeTruthy();
		expect(screen.queryByRole("button", { name: /展开学习状态|收起学习状态/ })).toBeNull();
	});
});

describe("LearnContextPanel — read states", () => {
	it("explains that no session is open instead of offering initialisation", () => {
		panel({ currentSessionId: null });

		expect(screen.getByText("选择课程并开始一段学习对话后，这里会显示学习检查点。")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
	});

	it("shows the loading copy while the state is being read", () => {
		panel({ learning: { state: null, isLoading: true, isSaving: false, error: null } });

		expect(screen.getByText("正在读取学习状态…")).toBeTruthy();
	});

	it("shows the server error and retries through the page callback", () => {
		const { props } = panel({
			learning: { state: null, isLoading: false, isSaving: false, error: "学习状态暂时不可用" },
		});

		expect(screen.getByText("学习状态暂时不可用")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(props.onRetry).toHaveBeenCalledTimes(1);
	});

	it("never initialises on mount; the explicit button owns that action", () => {
		const { props } = panel({ learning: { state: { exists: false }, isLoading: false, isSaving: false, error: null } });

		expect(props.onInit).not.toHaveBeenCalled();
		expect(screen.getByText("这段会话还没有学习检查点。初始化后，学习状态会记录在本机。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "初始化学习记录" }));
		expect(props.onInit).toHaveBeenCalledTimes(1);
	});

	it("keeps archived sessions read-only, even when no checkpoint exists", () => {
		panel({
			learning: { state: { exists: false }, isLoading: false, isSaving: false, error: null },
			readOnlySession: "session",
		});

		expect(screen.getByText("这段会话没有学习检查点。归档期间不能新建记录，恢复后才能开始。")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
	});
});

describe("LearnContextPanel — checkpoint", () => {
	it("renders only the public checkpoint facts and pauses through the callback", () => {
		const { props } = panel({ learning: { state: activeState(), isLoading: false, isSaving: false, error: null }, canPause: true });

		expect(screen.getByText("进行中")).toBeTruthy();
		expect(screen.getByText("等待作答")).toBeTruthy();
		expect(screen.getByText("#2")).toBeTruthy();
		expect(screen.getByText("为什么交叉验证的方差会随 K 增大而增大？")).toBeTruthy();
		expect(screen.getByText("题号 q1 · 版本 v1")).toBeTruthy();
		expect(screen.getByText("已保存作答，等待评分")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /暂停学习/ }));
		expect(props.onPause).toHaveBeenCalledTimes(1);
	});

	it("offers resume only when the checkpoint is paused and resumable", () => {
		const paused = activeState({
			checkpoint: {
				revision: 3,
				status: "paused",
				step: "conversation",
				updated_at: "2026-11-21T00:00:00.000Z",
			},
			pending_action: undefined,
		});
		const { props } = panel({ learning: { state: paused, isLoading: false, isSaving: false, error: null }, canResume: true });

		fireEvent.click(screen.getByRole("button", { name: /继续学习/ }));
		expect(props.onResume).toHaveBeenCalledTimes(1);
	});

	it("locks a completed checkpoint and shows no resume action", () => {
		const completed = activeState({
			checkpoint: {
				revision: 5,
				status: "completed",
				step: "feedback",
				updated_at: "2026-11-21T00:00:00.000Z",
			},
			questions: [],
			pending_action: undefined,
		});
		panel({ learning: { state: completed, isLoading: false, isSaving: false, error: null } });

		expect(screen.getByText("已完成")).toBeTruthy();
		expect(screen.getByText("检查点已完成，不能恢复。")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /继续学习/ })).toBeNull();
	});
});

describe("hasRealCheckpoint", () => {
	it("treats the placeholder record as no progress", () => {
		expect(hasRealCheckpoint({ exists: false })).toBe(false);
		expect(hasRealCheckpoint({
			exists: true,
			checkpoint: { revision: 1, status: "active", step: "conversation", updated_at: "" },
			questions: [],
			attempts: [],
		})).toBe(false);
	});

	it("opens for a real step, a question, a revision or a non-active status", () => {
		expect(hasRealCheckpoint({
			exists: true,
			checkpoint: { revision: 1, status: "active", step: "awaiting_answer", updated_at: "" },
		})).toBe(true);
		expect(hasRealCheckpoint({
			exists: true,
			checkpoint: { revision: 1, status: "active", step: "conversation", updated_at: "" },
			questions: [{
				question_id: "q1",
				question_version: "v1",
				concept_id: "c1",
				prompt: "题目",
				kind: "free_recall",
			}],
		})).toBe(true);
		expect(hasRealCheckpoint({
			exists: true,
			checkpoint: { revision: 1, status: "paused", step: "conversation", updated_at: "" },
		})).toBe(true);
		expect(hasRealCheckpoint({
			exists: true,
			checkpoint: { revision: 2, status: "active", step: "conversation", updated_at: "" },
		})).toBe(true);
	});
});
