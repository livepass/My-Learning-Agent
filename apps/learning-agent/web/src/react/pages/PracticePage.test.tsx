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
	submitAnswer: vi.fn(),
	evaluateAnswer: vi.fn(),
	finalizeAttempt: vi.fn(),
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

describe("practice page answering and evaluation", () => {
	const awaitingCheckpoint = (revision: number, pending?: string) => checkpoint(revision, {
		step: "awaiting_answer",
		question: { question_id: "q_saved", question_version: "1" },
		...(pending ? { pending_attempt_id: pending } : {}),
	});

	it("shows the answer box when a question is pending", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(2),
			questions: [savedQuestion],
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByLabelText("你的回答")).toBeTruthy());
		expect(screen.getByRole("button", { name: /提交作答/ })).toBeTruthy();
	});

	it("submits the answer and reveals the evaluate button", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(2),
			questions: [savedQuestion],
		});
		api.submitAnswer.mockResolvedValue({
			created: true,
			attempt: { attempt_id: "a1", question_id: "q_saved", question_version: "1", accepted_at: "x" },
			checkpoint: awaitingCheckpoint(3, "a1"),
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByLabelText("你的回答")).toBeTruthy());

		fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "我的作答" } });
		fireEvent.click(screen.getByRole("button", { name: /提交作答/ }));

		await waitFor(() => expect(screen.getByRole("button", { name: /开始评分/ })).toBeTruthy());
		expect(api.submitAnswer).toHaveBeenCalled();
	});

	it("evaluates and shows the assessment feedback and score", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(3, "a1"),
			questions: [savedQuestion],
		});
		api.evaluateAnswer.mockResolvedValue({
			replayed: false,
			pending_action: "publish_saved_evidence",
			assessment: {
				result: "partial",
				score: 0.5,
				feedback: "部分正确，缺少生命周期说明。",
				criteria: [{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" }],
			},
			checkpoint: awaitingCheckpoint(4, "a1"),
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /开始评分/ })).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: /开始评分/ }));

		await waitFor(() => expect(screen.getByText("部分正确，缺少生命周期说明。")).toBeTruthy());
		expect(screen.getByText(/得分 50 \/ 100/)).toBeTruthy();
		expect(screen.getByText(/部分答对/)).toBeTruthy();
	});

	it("shows a re-score action after a failed evaluation, not a plain start", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(5, "a1"),
			questions: [savedQuestion],
			attempts: [{
				attempt_id: "a1", question_id: "q_saved", question_version: "1",
				answer: "我的作答", accepted_at: "x", stage: "evaluation_failed",
				failure: { code: "timeout", message: "评估超时" },
				retryable: true, evaluation_attempts: 1,
			}],
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /重新评分/ })).toBeTruthy());
		expect(screen.getByText(/上次评分失败/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^开始评分$/ })).toBeNull();
	});

	it("shows an already-scored state without offering to score again", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(5, "a1"),
			questions: [savedQuestion],
			attempts: [{
				attempt_id: "a1", question_id: "q_saved", question_version: "1",
				answer: "我的作答", accepted_at: "x", stage: "evaluated",
				assessment: { result: "correct", score: 1, feedback: "准确", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByText(/已评分/)).toBeTruthy());
		expect(screen.getByText("准确")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /开始评分|重新评分/ })).toBeNull();
	});

	it("restores original answer and scoring feedback together after refresh", async () => {
		// Mock the initial state with a pending question
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(2),
			questions: [savedQuestion],
		});
		api.submitAnswer.mockResolvedValue({
			created: true,
			attempt: { attempt_id: "a1", question_id: "q_saved", question_version: "1", accepted_at: "2026-11-03T00:00:00.000Z" },
			checkpoint: awaitingCheckpoint(3, "a1"),
		});
		api.evaluateAnswer.mockResolvedValue({
			replayed: false,
			pending_action: "publish_saved_evidence",
			assessment: {
				result: "correct",
				score: 1,
				feedback: "回答非常准确，完整阐述了闭包原理。",
				criteria: [{ criterion_id: "c1", judgment: "met", explanation: "完整覆盖" }],
			},
			checkpoint: awaitingCheckpoint(4, "a1"),
		});

		const { unmount } = render(<PracticePage />);
		await waitFor(() => expect(screen.getByLabelText("你的回答")).toBeTruthy());

		// 1. Submit answer
		fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "闭包捕获了外部作用域的变量引用" } });
		fireEvent.click(screen.getByRole("button", { name: /提交作答/ }));

		await waitFor(() => expect(screen.getByRole("button", { name: /开始评分/ })).toBeTruthy());

		// 2. Evaluate answer
		fireEvent.click(screen.getByRole("button", { name: /开始评分/ }));
		await waitFor(() => expect(screen.getByText("回答非常准确，完整阐述了闭包原理。")).toBeTruthy());

		unmount();

		// 3. Simulate page refresh: reload from server with persisted attempt & assessment
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(4, "a1"),
			questions: [savedQuestion],
			attempts: [{
				attempt_id: "a1",
				question_id: "q_saved",
				question_version: "1",
				answer: "闭包捕获了外部作用域的变量引用",
				accepted_at: "2026-11-03T00:00:00.000Z",
				stage: "evaluated",
				assessment: {
					result: "correct",
					score: 1,
					feedback: "回答非常准确，完整阐述了闭包原理。",
					criteria: [{ criterion_id: "c1", judgment: "met", explanation: "完整覆盖" }],
				},
				retryable: false,
				evaluation_attempts: 1,
			}],
		});

		render(<PracticePage />);

		// 4. Verify both the original answer and the assessment feedback are restored
		await waitFor(() => expect(screen.getByText("回答非常准确，完整阐述了闭包原理。")).toBeTruthy());
		const textarea = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
		expect(textarea.value).toBe("闭包捕获了外部作用域的变量引用");
		expect(textarea.disabled).toBe(true);
		expect(screen.getByText(/得分 100 \/ 100/)).toBeTruthy();
		expect(screen.getByText(/^答对$/)).toBeTruthy();
		expect(screen.getByText(/已评分/)).toBeTruthy();
	});

	it("does not leak answers across A/B session switching", async () => {
		api.getLearningState.mockImplementation(async (sessionId: string) => {
			if (sessionId === "s1.jsonl") {
				return {
					exists: true,
					checkpoint: awaitingCheckpoint(3, "a1"),
					questions: [savedQuestion],
					attempts: [{
						attempt_id: "a1",
						question_id: "q_saved",
						question_version: "1",
						answer: "这是会话 A 的已保存回答",
						accepted_at: "2026-11-03T00:00:00.000Z",
						stage: "answer_saved",
						retryable: false,
						evaluation_attempts: 0,
					}],
				};
			}
			return {
				exists: true,
				checkpoint: checkpoint(2, {
					step: "awaiting_answer",
					question: { question_id: "q_b", question_version: "1" },
				}),
				questions: [{
					question_id: "q_b",
					question_version: "1",
					concept_id: "concept_b",
					prompt: "会话 B 的题目：解释事件循环",
					kind: "free_recall",
				}],
				attempts: [],
			};
		});

		render(<PracticePage />);

		// Session A shows its saved answer
		await waitFor(() => {
			const textarea = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
			expect(textarea.value).toBe("这是会话 A 的已保存回答");
			expect(textarea.disabled).toBe(true);
		});

		// Switch to Session B
		act(() => { sessionsStore.selectSession("s2.jsonl"); });

		// Session B must NOT show Session A's answer, and should have an editable empty draft
		await waitFor(() => {
			expect(screen.getByText("会话 B 的题目：解释事件循环")).toBeTruthy();
			const textarea = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
			expect(textarea.value).toBe("");
			expect(textarea.disabled).toBe(false);
		});

		// Type a draft in Session B
		fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "这是会话 B 正在编辑的草稿" } });
		expect((screen.getByLabelText("你的回答") as HTMLTextAreaElement).value).toBe("这是会话 B 正在编辑的草稿");

		// Switch back to Session A
		act(() => { sessionsStore.selectSession("s1.jsonl"); });

		// Session A must still show Session A's saved answer, NOT Session B's draft
		await waitFor(() => {
			expect(screen.getByText(savedQuestion.prompt)).toBeTruthy();
			const textarea = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
			expect(textarea.value).toBe("这是会话 A 的已保存回答");
			expect(textarea.disabled).toBe(true);
		});

		// Switch back to Session B
		act(() => { sessionsStore.selectSession("s2.jsonl"); });

		// Session B restores its local draft, never leaking Session A's answer
		await waitFor(() => {
			expect(screen.getByText("会话 B 的题目：解释事件循环")).toBeTruthy();
			const textarea = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
			expect(textarea.value).toBe("这是会话 B 正在编辑的草稿");
			expect(textarea.disabled).toBe(false);
		});
	});

	it("offers '记录本次学习结果' after evaluation and completes checkpoint on click (C3)", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: awaitingCheckpoint(5, "a1"),
			questions: [savedQuestion],
			attempts: [{
				attempt_id: "a1", question_id: "q_saved", question_version: "1",
				answer: "我的作答", accepted_at: "x", stage: "evaluated",
				assessment: { result: "correct", score: 1, feedback: "准确", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});
		api.finalizeAttempt.mockResolvedValue({
			replayed: false,
			profile_version: 2,
			attempt: { attempt_id: "a1", stage: "completed" },
			checkpoint: {
				revision: 6,
				status: "active",
				step: "feedback",
				updated_at: "2026-11-03T00:00:00.000Z",
				last_completed_attempt_id: "a1",
			},
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /记录本次学习结果/ })).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: /记录本次学习结果/ }));

		await waitFor(() => expect(api.finalizeAttempt).toHaveBeenCalledWith("s1.jsonl", "a1", 5));
		expect(learnerStore.load).toHaveBeenCalled();
	});

	it("renders '本题已记录' state when attempt is completed (C3)", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: {
				revision: 6,
				status: "active",
				step: "feedback",
				updated_at: "2026-11-03T00:00:00.000Z",
				last_completed_attempt_id: "a1",
				question: { question_id: "q_saved", question_version: "1" },
			},
			questions: [savedQuestion],
			attempts: [{
				attempt_id: "a1", question_id: "q_saved", question_version: "1",
				answer: "我的作答", accepted_at: "x", stage: "completed",
				assessment: { result: "correct", score: 1, feedback: "准确", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByText("本题已记录")).toBeTruthy());
		expect(screen.getByRole("button", { name: /查看我的学习档案/ })).toBeTruthy();
	});
});

describe("practice page continuation (C4)", () => {
	const questionB = {
		question_id: "q_next", question_version: "1", concept_id: "concept_closure",
		prompt: "下一题：闭包在循环里捕获变量时会发生什么？", kind: "free_recall" as const,
	};
	const completedA = {
		attempt_id: "a1", question_id: "q_saved", question_version: "1",
		answer: "A 的回答：闭包捕获变量绑定。", accepted_at: "x", stage: "completed" as const,
		assessment: { result: "correct" as const, score: 1, feedback: "A 的评分反馈", criteria: [] },
		retryable: false, evaluation_attempts: 1,
	};
	const feedbackState = () => ({
		exists: true,
		checkpoint: checkpoint(6, {
			step: "feedback",
			question: { question_id: "q_saved", question_version: "1" },
			last_completed_attempt_id: "a1",
		}),
		questions: [savedQuestion],
		attempts: [completedA],
	});
	const awaitingB = (attempts: unknown[] = [completedA]) => ({
		exists: true,
		checkpoint: checkpoint(7, {
			step: "awaiting_answer",
			question: { question_id: "q_next", question_version: "1" },
			last_completed_attempt_id: "a1",
		}),
		questions: [savedQuestion, questionB],
		attempts,
	});

	it("offers '再练一道' and the profile link once the previous result is recorded", async () => {
		api.getLearningState.mockResolvedValue(feedbackState());

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText("本题已记录")).toBeTruthy());
		expect(screen.getByRole("button", { name: /再练一道/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /查看我的学习档案/ })).toBeTruthy();
		expect(screen.getByText("A 的评分反馈")).toBeTruthy();
	});

	it("prefills the same concept and binds the continuation to the completed attempt", async () => {
		learnerStore.profile = {
			knowledge_states: [{
				concept_id: "concept_closure", concept_name: "Python 闭包", domain: "programming",
				mastery: 0.5, estimate_confidence: 0.4, stability_days: 1, exposure_count: 1,
				retrieval_count: 1, lapse_count: 0, successful_transfer_count: 0,
				active_misconception_ids: [], evidence_ids: [], state_label: "learning",
				diagnosis: "", next_actions: [],
			}],
			goals: [],
		} as never;
		api.getLearningState.mockResolvedValue(feedbackState());
		api.generateLearningQuestion.mockResolvedValue({
			created: true,
			question: questionB,
			checkpoint: awaitingB().checkpoint,
			knowledge: { kind: "model_knowledge" },
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /再练一道/ })).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: /再练一道/ }));
		const conceptInput = await waitFor(() => screen.getByLabelText("知识点") as HTMLInputElement);
		expect(conceptInput.value).toBe("Python 闭包");
		fireEvent.change(screen.getByLabelText(/题型/), { target: { value: "application" } });
		fireEvent.click(screen.getByRole("button", { name: /生成下一题/ }));

		await waitFor(() => expect(api.generateLearningQuestion).toHaveBeenCalled());
		const payload = api.generateLearningQuestion.mock.calls[0][1];
		expect(payload.after_attempt_id).toBe("a1");
		expect(payload.concept).toBe("Python 闭包");
		expect(payload.concept_id).toBe("concept_closure");
		expect(payload.kind).toBe("application");
		expect(payload.expected_revision).toBe(6);
	});

	it("asks the learner to choose a concept when the profile has no trusted label", async () => {
		// No knowledge_states on purpose: deriving a name from an id would be a
		// guess, so the field stays empty and generation stays disabled.
		api.getLearningState.mockResolvedValue(feedbackState());

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /再练一道/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /再练一道/ }));

		const conceptInput = await waitFor(() => screen.getByLabelText("知识点") as HTMLInputElement);
		expect(conceptInput.value).toBe("");
		expect((screen.getByRole("button", { name: /生成下一题/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("shows a blank, editable answer box for the new question instead of the previous answer", async () => {
		api.getLearningState.mockResolvedValue(awaitingB());

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(questionB.prompt)).toBeTruthy());
		const textarea = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
		expect(textarea.value).toBe("");
		expect(textarea.disabled).toBe(false);
		// A1's completed state must not be painted onto B.
		expect(screen.queryByText("本题已记录")).toBeNull();
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
		expect(screen.queryByText(/已评分/)).toBeNull();
	});

	it("submits B with B's own question identity", async () => {
		api.getLearningState.mockResolvedValue(awaitingB());
		api.submitAnswer.mockResolvedValue({
			created: true,
			attempt: { attempt_id: "b1", question_id: "q_next", question_version: "1", accepted_at: "x" },
			checkpoint: checkpoint(8, {
				step: "awaiting_answer",
				question: { question_id: "q_next", question_version: "1" },
				pending_attempt_id: "b1", last_completed_attempt_id: "a1",
			}),
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByLabelText("你的回答")).toBeTruthy());

		fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "B 的回答" } });
		fireEvent.click(screen.getByRole("button", { name: /提交作答/ }));

		await waitFor(() => expect(api.submitAnswer).toHaveBeenCalled());
		const payload = api.submitAnswer.mock.calls[0][1];
		expect(payload.question_id).toBe("q_next");
		expect(payload.answer).toBe("B 的回答");
	});

	it("shows B1's answer after refresh, not A1's", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(9, {
				step: "feedback",
				question: { question_id: "q_next", question_version: "1" },
				last_completed_attempt_id: "b1",
			}),
			questions: [savedQuestion, questionB],
			attempts: [
				completedA,
				{
					attempt_id: "b1", question_id: "q_next", question_version: "1",
					answer: "B 的回答：循环共用一个变量绑定。", accepted_at: "x", stage: "completed" as const,
					assessment: { result: "correct" as const, score: 1, feedback: "B 的评分反馈", criteria: [] },
					retryable: false, evaluation_attempts: 1,
				},
			],
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(questionB.prompt)).toBeTruthy());
		const textarea = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
		expect(textarea.value).toBe("B 的回答：循环共用一个变量绑定。");
		expect(screen.getByText("B 的评分反馈")).toBeTruthy();
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
	});

	it("keeps B's draft per question across an A/B session switch", async () => {
		const questionC = {
			question_id: "q_other", question_version: "1", concept_id: "concept_loop",
			prompt: "另一个会话的题目", kind: "free_recall" as const,
		};
		api.getLearningState
			.mockResolvedValueOnce(awaitingB())
			.mockResolvedValue({
				exists: true,
				checkpoint: checkpoint(2, {
					step: "awaiting_answer", question: { question_id: "q_other", question_version: "1" },
				}),
				questions: [questionC],
				attempts: [],
			});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByText(questionB.prompt)).toBeTruthy());
		fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "B 的草稿" } });

		act(() => { sessionsStore.selectSession("s2.jsonl"); });
		await waitFor(() => expect(screen.getByText("另一个会话的题目")).toBeTruthy());
		expect((screen.getByLabelText("你的回答") as HTMLTextAreaElement).value).toBe("");
	});

	it("keeps the previous feedback visible when the continuation model call fails", async () => {
		api.getLearningState.mockResolvedValue(feedbackState());
		api.generateLearningQuestion.mockRejectedValue(Object.assign(new Error("model_timeout"), {
			status: 503,
			data: { error: "model_timeout", message: "模型响应超时，请稍后重试。" },
		}));

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /再练一道/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /再练一道/ }));
		fireEvent.change(await waitFor(() => screen.getByLabelText("知识点")), { target: { value: "Python 闭包" } });
		fireEvent.click(screen.getByRole("button", { name: /生成下一题/ }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("模型响应超时"));
		// The completed question is still recorded and its feedback still renders.
		expect(screen.getByText("本题已记录")).toBeTruthy();
		expect(screen.getByText("A 的评分反馈")).toBeTruthy();
		// And a retry is still possible.
		expect(screen.getByRole("button", { name: /生成下一题/ })).toBeTruthy();
	});
});

describe("practice page assessment isolation (C4-P1)", () => {
	const questionB = {
		question_id: "q_next", question_version: "1", concept_id: "concept_closure",
		prompt: "下一题：闭包在循环里捕获变量时会发生什么？", kind: "free_recall" as const,
	};
	const completedA = {
		attempt_id: "a1", question_id: "q_saved", question_version: "1",
		answer: "A 的回答", accepted_at: "x", stage: "completed" as const,
		assessment: { result: "correct" as const, score: 1, feedback: "A 的评分反馈", criteria: [] },
		retryable: false, evaluation_attempts: 1,
	};
	const awaitingA = () => ({
		exists: true,
		checkpoint: checkpoint(3, {
			step: "awaiting_answer", question: { question_id: "q_saved", question_version: "1" },
			pending_attempt_id: "a1",
		}),
		questions: [savedQuestion],
	});
	const aFeedback = () => ({
		exists: true,
		checkpoint: checkpoint(5, {
			step: "feedback", question: { question_id: "q_saved", question_version: "1" },
			last_completed_attempt_id: "a1",
		}),
		questions: [savedQuestion],
		attempts: [completedA],
	});
	const bAwaiting = (pending?: string) => ({
		exists: true,
		checkpoint: checkpoint(7, {
			step: "awaiting_answer", question: { question_id: "q_next", question_version: "1" },
			...(pending ? { pending_attempt_id: pending } : {}),
			last_completed_attempt_id: "a1",
		}),
		questions: [savedQuestion, questionB],
		attempts: [completedA],
	});

	/** Populate the response-scoped score through the store, as the app does. */
	async function scoreA(): Promise<void> {
		learningStore.state = awaitingA();
		api.evaluateAnswer.mockResolvedValue({
			replayed: false,
			assessment: { result: "correct", score: 1, feedback: "A 的评分反馈", criteria: [] },
			checkpoint: checkpoint(4, {
				step: "awaiting_answer", question: { question_id: "q_saved", question_version: "1" },
				pending_attempt_id: "a1",
			}),
		});
		api.getLearningState.mockResolvedValueOnce(aFeedback());
		await learningStore.evaluateAnswer();
		expect(learningStore.assessment?.feedback).toBe("A 的评分反馈");
	}

	it("does not paint A's score on B after continuing, before B is answered", async () => {
		await scoreA();
		api.getLearningState.mockResolvedValue(bAwaiting());
		api.generateLearningQuestion.mockResolvedValue({
			created: true, question: questionB,
			checkpoint: bAwaiting().checkpoint,
			knowledge: { kind: "model_knowledge" },
		});
		await learningStore.generate({ concept: "Python 闭包", allow_model_fallback: true, after_attempt_id: "a1" });

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(questionB.prompt)).toBeTruthy());
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
		expect(screen.queryByText(/得分/)).toBeNull();
		expect(screen.queryByText(/^答对$/)).toBeNull();
	});

	it("does not paint A's score after B's answer is saved but not evaluated", async () => {
		await scoreA();
		api.getLearningState.mockResolvedValue(bAwaiting("b1"));
		api.generateLearningQuestion.mockResolvedValue({
			created: true, question: questionB,
			checkpoint: checkpoint(7, {
				step: "awaiting_answer", question: { question_id: "q_next", question_version: "1" },
				last_completed_attempt_id: "a1",
			}),
			knowledge: { kind: "model_knowledge" },
		});
		await learningStore.generate({ concept: "Python 闭包", allow_model_fallback: true, after_attempt_id: "a1" });
		api.submitAnswer.mockResolvedValue({
			created: true,
			attempt: { attempt_id: "b1", question_id: "q_next", question_version: "1", accepted_at: "x" },
			checkpoint: bAwaiting("b1").checkpoint,
		});
		await learningStore.submitAnswer("B 的作答");

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByRole("button", { name: /开始评分/ })).toBeTruthy());
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
		expect(screen.queryByText(/得分/)).toBeNull();
	});

	it("shows B's failure, never A's successful result, when B's evaluation fails", async () => {
		await scoreA();
		learningStore.state = bAwaiting("b1");
		api.getLearningState
			.mockResolvedValueOnce(bAwaiting("b1"))
			.mockResolvedValue({
				exists: true,
				checkpoint: bAwaiting("b1").checkpoint,
				questions: [savedQuestion, questionB],
				attempts: [{
					attempt_id: "b1", question_id: "q_next", question_version: "1",
					answer: "B 的作答", accepted_at: "x", stage: "evaluation_failed" as const,
					failure: { code: "model_error", message: "评分服务暂时不可用" },
					retryable: true, evaluation_attempts: 1,
				}],
			});
		api.evaluateAnswer.mockRejectedValue(Object.assign(new Error("model_error"), {
			status: 502, data: { error: "model_error", message: "评分服务暂时不可用" },
		}));

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /开始评分/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /开始评分/ }));

		await waitFor(() => expect(screen.getAllByText(/评分失败/).length).toBeGreaterThan(0));
		expect(screen.getAllByText(/评分服务暂时不可用/).length).toBeGreaterThan(0);
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
		expect(screen.queryByText(/得分 100 \/ 100/)).toBeNull();
	});

	it("shows only B's score and feedback after B is evaluated", async () => {
		await scoreA();
		learningStore.state = bAwaiting("b1");
		api.getLearningState
			.mockResolvedValueOnce(bAwaiting("b1"))
			.mockResolvedValue({
				exists: true,
				checkpoint: bAwaiting("b1").checkpoint,
				questions: [savedQuestion, questionB],
				attempts: [{
					attempt_id: "b1", question_id: "q_next", question_version: "1",
					answer: "B 的作答", accepted_at: "x", stage: "evaluated" as const,
					assessment: { result: "partial" as const, score: 0.5, feedback: "B 的部分正确", criteria: [] },
					retryable: false, evaluation_attempts: 1,
				}],
			});
		api.evaluateAnswer.mockResolvedValue({
			replayed: false,
			assessment: { result: "partial", score: 0.5, feedback: "B 的部分正确", criteria: [] },
			checkpoint: bAwaiting("b1").checkpoint,
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /开始评分/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /开始评分/ }));

		await waitFor(() => expect(screen.getByText("B 的部分正确")).toBeTruthy());
		expect(screen.getByText(/得分 50 \/ 100/)).toBeTruthy();
		expect(screen.getByText(/部分答对/)).toBeTruthy();
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
	});

	it("restores the score of the current question after a reload", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(9, {
				step: "feedback", question: { question_id: "q_next", question_version: "1" },
				last_completed_attempt_id: "b1",
			}),
			questions: [savedQuestion, questionB],
			attempts: [completedA, {
				attempt_id: "b1", question_id: "q_next", question_version: "1",
				answer: "B 的回答", accepted_at: "x", stage: "completed" as const,
				assessment: { result: "correct" as const, score: 1, feedback: "B 的评分反馈", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText("B 的评分反馈")).toBeTruthy());
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
	});

	it("clears the score when switching to another session", async () => {
		await scoreA();
		api.getLearningState.mockResolvedValueOnce(aFeedback()).mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(2, {
				step: "awaiting_answer",
				question: { question_id: "q_other", question_version: "1" },
			}),
			questions: [{
				question_id: "q_other", question_version: "1", concept_id: "concept_loop",
				prompt: "另一个会话的题目", kind: "free_recall" as const,
			}],
			attempts: [],
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByText(/A 的评分反馈/)).toBeTruthy());

		act(() => { sessionsStore.selectSession("s2.jsonl"); });

		await waitFor(() => expect(screen.getByText("另一个会话的题目")).toBeTruthy());
		expect(screen.queryByText("A 的评分反馈")).toBeNull();
		expect(learningStore.assessment).toBeNull();
	});
});

describe("practice page concept label trust (C4-P2)", () => {
	const syntheticId = "concept_45125622e640";
	const syntheticQuestion = {
		question_id: "q_syn", question_version: "1", concept_id: syntheticId,
		prompt: "合成知识点上的题目", kind: "free_recall" as const,
	};
	const feedbackState = () => ({
		exists: true,
		checkpoint: checkpoint(6, {
			step: "feedback", question: { question_id: "q_syn", question_version: "1" },
			last_completed_attempt_id: "a1",
		}),
		questions: [syntheticQuestion],
		attempts: [{
			attempt_id: "a1", question_id: "q_syn", question_version: "1",
			answer: "作答", accepted_at: "x", stage: "completed" as const,
			assessment: { result: "correct" as const, score: 1, feedback: "已记录", criteria: [] },
			retryable: false, evaluation_attempts: 1,
		}],
	});
	const state = (conceptName: string) => ({
		knowledge_states: [{
			concept_id: syntheticId, concept_name: conceptName, domain: "general",
			mastery: 0.5, estimate_confidence: 0.4, stability_days: 1, exposure_count: 1,
			retrieval_count: 1, lapse_count: 0, successful_transfer_count: 0,
			active_misconception_ids: [], evidence_ids: [], state_label: "learning",
			diagnosis: "", next_actions: [],
		}],
		goals: [],
	});

	it.each([
		["the id itself", syntheticId],
		["the old title-cased hash", "concept 45125622e640"],
	])("does not prefill %s as a topic", async (_label, conceptName) => {
		learnerStore.profile = state(conceptName) as never;
		api.getLearningState.mockResolvedValue(feedbackState());

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /再练一道/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /再练一道/ }));

		const input = await waitFor(() => screen.getByLabelText("知识点") as HTMLInputElement);
		expect(input.value).toBe("");
		expect((screen.getByRole("button", { name: /生成下一题/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("prefills a real name and reuses the derived concept id", async () => {
		learnerStore.profile = state("Python 闭包") as never;
		api.getLearningState.mockResolvedValue(feedbackState());
		api.generateLearningQuestion.mockResolvedValue({
			created: true,
			question: {
				question_id: "q_second", question_version: "1", concept_id: syntheticId,
				prompt: "第二题", kind: "free_recall",
			},
			checkpoint: checkpoint(7, {
				step: "awaiting_answer", question: { question_id: "q_second", question_version: "1" },
				last_completed_attempt_id: "a1",
			}),
			knowledge: { kind: "model_knowledge" },
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /再练一道/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /再练一道/ }));

		const input = await waitFor(() => screen.getByLabelText("知识点") as HTMLInputElement);
		expect(input.value).toBe("Python 闭包");
		fireEvent.click(screen.getByRole("button", { name: /生成下一题/ }));

		await waitFor(() => expect(api.generateLearningQuestion).toHaveBeenCalled());
		const payload = api.generateLearningQuestion.mock.calls[0][1];
		expect(payload.concept).toBe("Python 闭包");
		expect(payload.concept_id).toBe(syntheticId);
	});

	it("blocks a manually typed machine identity and explains why", async () => {
		api.getLearningState.mockResolvedValue(feedbackState());

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /再练一道/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /再练一道/ }));

		const input = await waitFor(() => screen.getByLabelText("知识点"));
		fireEvent.change(input, { target: { value: "concept 45125622e640" } });

		expect(screen.getByText(/不是知识点名称/)).toBeTruthy();
		expect((screen.getByRole("button", { name: /生成下一题/ }) as HTMLButtonElement).disabled).toBe(true);
	});
});
