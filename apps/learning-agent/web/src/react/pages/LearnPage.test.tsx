import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnPage } from "./LearnPage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { learningStore } from "../../stores/learning-store.js";

vi.mock("../MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));

const api = vi.hoisted(() => ({
	getLearningState: vi.fn(),
	initLearning: vi.fn(),
	pauseLearning: vi.fn(),
	resumeLearning: vi.fn(),
}));

vi.mock("../../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learning.js")>("../../api/learning.js");
	return { ...actual, ...api };
});

const question = {
	question_id: "q1", question_version: "1", concept_id: "closure", goal_id: "g1",
	prompt: "请解释闭包与词法作用域的关系。", kind: "free_recall" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	sessionsStore.sessions = [];
	sessionsStore.currentSessionId = "s1.jsonl";
	learningStore.clear();
	learningStore.sessionId = "s1.jsonl";
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	sessionsStore.currentSessionId = null;
});

describe("learn page learning state", () => {
	it("shows the current question and the pause action, without private scoring material", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 4, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z", question: { question_id: "q1", question_version: "1" } },
			questions: [question],
			pending_action: "evaluate",
		});

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByText("请解释闭包与词法作用域的关系。")).toBeTruthy());
		expect(screen.getByRole("button", { name: /暂停学习/ })).toBeTruthy();
		expect(screen.getByText(/等待评分（评分尚未开放）/)).toBeTruthy();

		// No private material may reach the DOM.
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("reference_answer");
		expect(text).not.toContain("rubric");
		expect(text).not.toContain("hints");
	});

	it("offers an explicit initialise action for a missing record and never auto-initialises", async () => {
		api.getLearningState.mockResolvedValue({ exists: false });

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByRole("button", { name: "初始化学习记录" })).toBeTruthy());
		expect(api.initLearning).not.toHaveBeenCalled();

		api.initLearning.mockResolvedValue({ revision: 1, status: "active", step: "conversation", updated_at: "2026-11-02T00:00:00.000Z" });
		fireEvent.click(screen.getByRole("button", { name: "初始化学习记录" }));
		await waitFor(() => expect(api.initLearning).toHaveBeenCalledWith("s1.jsonl", undefined));
	});

	it("cannot resume a completed checkpoint", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 9, status: "completed", step: "feedback", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
		});

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByText("检查点已完成，不能恢复。")).toBeTruthy());
		expect(screen.queryByRole("button", { name: /继续学习/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /暂停学习/ })).toBeNull();
	});
});
