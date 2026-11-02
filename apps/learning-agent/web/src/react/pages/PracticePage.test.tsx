import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PracticePage } from "./PracticePage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import type { LearningState } from "../../api/learning.js";

const api = vi.hoisted(() => ({
	getLearningState: vi.fn(),
	initLearning: vi.fn(),
	pauseLearning: vi.fn(),
	resumeLearning: vi.fn(),
	generateLearningQuestion: vi.fn(),
}));

vi.mock("../../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learning.js")>("../../api/learning.js");
	return { ...actual, ...api };
});

const checkpoint = (revision: number, overrides: Record<string, unknown> = {}) => ({
	revision, status: "active" as const, step: "conversation" as const,
	updated_at: "2026-11-02T00:00:00.000Z", ...overrides,
});

const savedQuestion = {
	question_id: "q_saved", question_version: "1", concept_id: "concept_closure",
	prompt: "已保存的题目：解释闭包为什么持有外层变量。", kind: "free_recall" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(learnerStore, "load").mockResolvedValue(undefined);
	learnerStore.profile = null;
	sessionsStore.currentSessionId = "s1.jsonl";
	learningStore.clear();
	learningStore.sessionId = "s1.jsonl";
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	sessionsStore.currentSessionId = null;
});

describe("practice page question generation", () => {
	it("offers the generation entry when no question is pending", async () => {
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(1), questions: [] });

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByRole("button", { name: /生成练习题/ })).toBeTruthy());
		expect(screen.getByLabelText("知识点")).toBeTruthy();
		// No fabricated question before one is generated.
		expect(screen.queryByText(/已保存的题目/)).toBeNull();
	});

	it("never creates a learning record implicitly", async () => {
		api.getLearningState.mockResolvedValue({ exists: false });

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByRole("button", { name: "初始化学习记录" })).toBeTruthy());
		expect(api.initLearning).not.toHaveBeenCalled();
	});

	it("generates a question and shows it with its source type", async () => {
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(1), questions: [] });
		api.generateLearningQuestion.mockResolvedValue({
			created: true,
			question: {
				question_id: "q_new", question_version: "1", concept_id: "concept_closure",
				prompt: "新生成的题目：闭包捕获的是什么？", kind: "free_recall",
			},
			checkpoint: checkpoint(2, {
				step: "awaiting_answer",
				question: { question_id: "q_new", question_version: "1" },
				knowledge: { kind: "model_knowledge" },
			}),
			knowledge: { kind: "model_knowledge" },
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /生成练习题/ })).toBeTruthy());

		fireEvent.change(screen.getByLabelText("知识点"), { target: { value: "Python 闭包" } });
		fireEvent.click(screen.getByRole("button", { name: /生成练习题/ }));

		await waitFor(() => expect(screen.getByText("新生成的题目：闭包捕获的是什么？")).toBeTruthy());
		expect(screen.getByText("模型知识")).toBeTruthy();

		const [sessionId, payload] = api.generateLearningQuestion.mock.calls[0] as [string, Record<string, unknown>];
		expect(sessionId).toBe("s1.jsonl");
		expect(payload.concept).toBe("Python 闭包");
		expect(payload.allow_model_fallback).toBe(true);
		expect(payload.expected_revision).toBe(1);
		expect(typeof payload.request_id).toBe("string");
		// The client never sends provenance or a model identity.
		expect(payload.provenance).toBeUndefined();
		expect(payload.model).toBeUndefined();
	});

	it("shows a saved question instead of offering another one", async () => {
		const state: LearningState = {
			exists: true,
			checkpoint: checkpoint(4, {
				step: "awaiting_answer",
				question: { question_id: "q_saved", question_version: "1" },
				knowledge: { kind: "l2_document" },
			}),
			questions: [savedQuestion],
		};
		api.getLearningState.mockResolvedValue(state);

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(savedQuestion.prompt)).toBeTruthy());
		expect(screen.getByText("L2 学习资料")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /生成练习题/ })).toBeNull();
		// Private material never reaches the page.
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("reference_answer");
		expect(text).not.toContain("rubric");
	});

	it("surfaces the server's explanation when generation fails", async () => {
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(1), questions: [] });
		const error = Object.assign(new Error("learning_state_invalid"), {
			status: 409,
			data: { error: "learning_state_invalid", message: "当前已有待作答的题目。" },
		});
		api.generateLearningQuestion.mockRejectedValue(error);

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /生成练习题/ })).toBeTruthy());

		fireEvent.change(screen.getByLabelText("知识点"), { target: { value: "Python 闭包" } });
		fireEvent.click(screen.getByRole("button", { name: /生成练习题/ }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("当前已有待作答的题目"));
	});

	it("does not show a previous session's question after switching", async () => {
		api.getLearningState.mockResolvedValueOnce({
			exists: true,
			checkpoint: checkpoint(3, {
				step: "awaiting_answer",
				question: { question_id: "q_saved", question_version: "1" },
			}),
			questions: [savedQuestion],
		}).mockResolvedValue({ exists: true, checkpoint: checkpoint(1), questions: [] });

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByText(savedQuestion.prompt)).toBeTruthy());

		act(() => { sessionsStore.selectSession("s2.jsonl"); });

		await waitFor(() => expect(screen.queryByText(savedQuestion.prompt)).toBeNull());
		expect(learningStore.sessionId).toBe("s2.jsonl");
	});
});
