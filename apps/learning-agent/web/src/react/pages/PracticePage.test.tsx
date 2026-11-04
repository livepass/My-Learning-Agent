import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PracticePage } from "./PracticePage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import type { LearningState } from "../../api/learning.js";

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../shell/navigation.js", () => ({ navigate: nav.navigate }));

const learnerApi = vi.hoisted(() => ({
	getLearningRecommendations: vi.fn(),
	getLearnerProfile: vi.fn(),
}));
vi.mock("../../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learner.js")>("../../api/learner.js");
	return { ...actual, ...learnerApi };
});

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
	vi.spyOn(learnerStore, "loadRecommendations").mockResolvedValue(undefined);
	vi.spyOn(learnerStore, "loadConceptRecommendation").mockResolvedValue(undefined);
	learnerStore.profile = null;
	learnerStore.recommendations = null;
	learnerStore.recommendationsError = null;
	learnerStore.conceptRecommendation = null;
	learnerStore.conceptRecommendationConceptId = null;
	learnerStore.conceptRecommendationError = null;
	sessionsStore.currentSessionId = "s1.jsonl";
	sessionsStore.sessions = [];
	learningStore.clear();
	learningStore.sessionId = "s1.jsonl";
	window.history.replaceState(null, "", "/");
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

describe("practice page long-term recommendation (C4-B)", () => {
	const completedQuestion = {
		question_id: "q_rec", question_version: "1", concept_id: "concept_closure",
		prompt: "已完成题目：解释闭包。", kind: "free_recall" as const,
	};
	const completedState = () => ({
		exists: true,
		checkpoint: checkpoint(8, {
			step: "feedback", question: { question_id: "q_rec", question_version: "1" },
			last_completed_attempt_id: "a1",
		}),
		questions: [completedQuestion],
		attempts: [{
			attempt_id: "a1", question_id: "q_rec", question_version: "1",
			answer: "作答", accepted_at: "x", stage: "completed" as const,
			assessment: { result: "correct" as const, score: 1, feedback: "C2 的评分反馈", criteria: [] },
			retryable: false, evaluation_attempts: 1,
		}],
	});
	const recommendation = (overrides: Record<string, unknown> = {}) => ({
		concept_id: "concept_closure",
		concept_name: "Python 闭包",
		name_available: true,
		action: "diagnose" as const,
		suggested_kind: "free_recall" as const,
		reason_code: "learning_needs_diagnosis" as const,
		reason: "这个知识点已开始学习但证据还不充分，建议先用自由回忆补充一次独立证据。",
		also_matches: [],
		evidence_basis: {
			state_label: "learning" as const, evidence_count: 1,
			has_active_misconception: false, provenance_limited: false, exposure_only: false,
		},
		...overrides,
	});
	const snapshotWith = (items: unknown[], conceptId = "concept_closure") => ({
		as_of: "2026-11-03T12:00:00.000Z",
		generated_at: "2026-11-03T12:00:00.000Z",
		profile_version: 5,
		recommendations: items as never[],
		status: items.length > 0 ? "ok" as const : "empty" as const,
		limit: 3,
		concept_id: conceptId,
	});

	it("shows the current concept's long-term advice separately from the C2 score", async () => {
		api.getLearningState.mockResolvedValue(completedState());
		learnerStore.conceptRecommendation = snapshotWith([recommendation()]);
		learnerStore.conceptRecommendationConceptId = "concept_closure";

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText("下一步学习建议")).toBeTruthy());
		expect(screen.getByText("Python 闭包")).toBeTruthy();
		expect(screen.getByText("补充诊断")).toBeTruthy();
		expect(screen.getByText(/已开始学习但证据还不充分/)).toBeTruthy();
		expect(screen.getByText("可追溯证据 1 条")).toBeTruthy();
		// The C2 score is still rendered by its own section.
		expect(screen.getByText("C2 的评分反馈")).toBeTruthy();
		// No auto-generation affordance: only a note.
		expect(screen.queryByRole("button", { name: /生成练习题|生成下一题/ })).toBeNull();
	});

	it("reads the current concept even when the global Top 3 excludes it", async () => {
		api.getLearningState.mockResolvedValue(completedState());
		// What the today page sees: three other concepts, not this one.
		learnerStore.recommendations = snapshotWith([
			recommendation({ concept_id: "concept_top_1", concept_name: "全局第一" }),
			recommendation({ concept_id: "concept_top_2", concept_name: "全局第二" }),
			recommendation({ concept_id: "concept_top_3", concept_name: "全局第三" }),
		]);
		learnerStore.conceptRecommendation = snapshotWith([recommendation()]);
		learnerStore.conceptRecommendationConceptId = "concept_closure";

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText("Python 闭包")).toBeTruthy());
		expect(screen.getByText("补充诊断")).toBeTruthy();
		expect(screen.queryByText("全局第一")).toBeNull();
	});

	it("shows a read failure instead of the previous advice", async () => {
		api.getLearningState.mockResolvedValue(completedState());
		learnerStore.conceptRecommendation = null;
		learnerStore.conceptRecommendationConceptId = "concept_closure";
		learnerStore.conceptRecommendationError = "学习档案暂时不可用，无法生成下一步建议。";

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/学习档案暂时不可用/)).toBeTruthy());
		expect(screen.queryByText("Python 闭包")).toBeNull();
		expect(screen.queryByText(/暂时没有基于真实证据/)).toBeNull();
	});

	it("does not attach another concept's advice to this question", async () => {
		api.getLearningState.mockResolvedValue(completedState());
		learnerStore.conceptRecommendation = snapshotWith([
			recommendation({ concept_id: "concept_other", concept_name: "另一个知识点" }),
		]);
		learnerStore.conceptRecommendationConceptId = "concept_closure";

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/暂时没有基于真实证据的下一步建议/)).toBeTruthy());
		expect(screen.queryByText("另一个知识点")).toBeNull();
	});

	it("routes a learn recommendation to AI learning", async () => {
		api.getLearningState.mockResolvedValue(completedState());
		learnerStore.conceptRecommendation = snapshotWith([recommendation({
			action: "learn", suggested_kind: undefined, reason_code: "active_misconception",
			reason: "学习档案中有一条仍在活跃状态的误区记录。",
			evidence_basis: {
				state_label: "misconception", evidence_count: 1,
				has_active_misconception: true, provenance_limited: false, exposure_only: false,
			},
		})]);
		learnerStore.conceptRecommendationConceptId = "concept_closure";

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /前往 AI 学习/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /前往 AI 学习/ }));
		expect(nav.navigate).toHaveBeenCalledWith("learn", { history: "push" });
	});

	it("refreshes recommendations only after the evidence was recorded", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(8, {
				step: "awaiting_answer", question: { question_id: "q_rec", question_version: "1" },
				pending_attempt_id: "a1",
			}),
			questions: [completedQuestion],
			attempts: [{
				attempt_id: "a1", question_id: "q_rec", question_version: "1",
				answer: "作答", accepted_at: "x", stage: "evaluated" as const,
				assessment: { result: "correct" as const, score: 1, feedback: "准确", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});
		api.finalizeAttempt.mockResolvedValue({
			replayed: false, profile_version: 6,
			attempt: { attempt_id: "a1", stage: "completed" },
			checkpoint: checkpoint(9, {
				step: "feedback", question: { question_id: "q_rec", question_version: "1" },
				last_completed_attempt_id: "a1",
			}),
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /记录本次学习结果/ })).toBeTruthy());
		// The mount already refreshed this concept; count only the finalize path.
		vi.mocked(learnerStore.loadConceptRecommendation).mockClear();
		fireEvent.click(screen.getByRole("button", { name: /记录本次学习结果/ }));

		await waitFor(() => expect(learnerStore.loadConceptRecommendation).toHaveBeenCalledWith("concept_closure"));
	});

	it("does not claim a refreshed long-term state when finalize fails", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(8, {
				step: "awaiting_answer", question: { question_id: "q_rec", question_version: "1" },
				pending_attempt_id: "a1",
			}),
			questions: [completedQuestion],
			attempts: [{
				attempt_id: "a1", question_id: "q_rec", question_version: "1",
				answer: "作答", accepted_at: "x", stage: "evaluated" as const,
				assessment: { result: "correct" as const, score: 1, feedback: "准确", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});
		api.finalizeAttempt.mockRejectedValue(Object.assign(new Error("conflict"), {
			status: 409, data: { message: "学习状态已更新，请重新加载后再试。" },
		}));

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /记录本次学习结果/ })).toBeTruthy());
		vi.mocked(learnerStore.loadConceptRecommendation).mockClear();
		fireEvent.click(screen.getByRole("button", { name: /记录本次学习结果/ }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("学习状态已更新"));
		expect(learnerStore.loadConceptRecommendation).not.toHaveBeenCalled();
		expect(screen.queryByText("下一步学习建议")).toBeNull();
	});
});

describe("practice page review preparation (C4-C)", () => {
	const reviewConcept = "concept_closure";
	const reviewQuestion = {
		question_id: "q_review", question_version: "1", concept_id: reviewConcept,
		prompt: "复习题：解释闭包为什么持有外层变量。", kind: "free_recall" as const,
		// The server records why the question exists; the page trusts that, not the URL.
		review: true as const,
	};
	const reviewRecommendation = (overrides: Record<string, unknown> = {}) => ({
		concept_id: reviewConcept,
		concept_name: "Python 闭包",
		name_available: true,
		action: "review" as const,
		suggested_kind: "free_recall" as const,
		reason_code: "review_due" as const,
		reason: "复习时间已到，建议先用自由回忆检索一次。",
		also_matches: [],
		evidence_basis: {
			state_label: "review_due" as const,
			review_due_at: "2026-11-01T00:00:00.000Z",
			evidence_count: 2,
			has_active_misconception: false,
			provenance_limited: false,
			exposure_only: false,
		},
		...overrides,
	});
	const reviewSnapshot = (items: unknown[]) => ({
		as_of: "2026-11-04T00:00:00.000Z",
		generated_at: "2026-11-04T00:00:00.000Z",
		profile_version: 4,
		recommendations: items as never[],
		status: items.length > 0 ? "ok" as const : "empty" as const,
		limit: 3,
		concept_id: reviewConcept,
	});
	const profileWithName = (conceptName: string) => ({
		knowledge_states: [{
			concept_id: reviewConcept, concept_name: conceptName, domain: "programming",
			mastery: 0.5, estimate_confidence: 0.4, stability_days: 1, exposure_count: 1,
			retrieval_count: 1, lapse_count: 0, successful_transfer_count: 0,
			active_misconception_ids: [], evidence_ids: ["ev_1"], state_label: "review_due",
			review_due_at: "2026-11-01T00:00:00.000Z", origin: "derived",
			diagnosis: "", next_actions: [],
		}],
		goals: [],
	});
	const setReviewUrl = (questionId?: string) => {
		const params = new URLSearchParams({
			page: "practice", intent: "review", review_concept_id: reviewConcept, session: "s1.jsonl",
		});
		if (questionId) params.set("review_question_id", questionId);
		window.history.replaceState(null, "", `/?${params.toString()}`);
	};

	it("verifies the due status from L1 and generates a free_recall question for the same concept", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });
		api.generateLearningQuestion.mockResolvedValue({
			created: true,
			question: { ...reviewQuestion, prompt: "新复习题" },
			checkpoint: checkpoint(3, {
				step: "awaiting_answer",
				question: { question_id: "q_review", question_version: "1" },
			}),
			knowledge: { kind: "model_knowledge" },
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText("复习准备")).toBeTruthy());
		expect(screen.getByText("Python 闭包")).toBeTruthy();
		expect(screen.getByText(/复习时间：/)).toBeTruthy();
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));

		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));
		await waitFor(() => expect(api.generateLearningQuestion).toHaveBeenCalled());

		const payload = api.generateLearningQuestion.mock.calls[0][1];
		expect(payload).toMatchObject({
			concept: "Python 闭包", concept_id: reviewConcept, kind: "free_recall",
			allow_model_fallback: true,
		});
		expect(payload.after_attempt_id).toBeUndefined();
		// The due check is repeated immediately before generating.
		expect(learnerApi.getLearningRecommendations).toHaveBeenCalledTimes(2);
	});

	it("requires an explicit confirmation when the concept has no trusted name", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("concept 45125622e640") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });

		render(<PracticePage />);

		const input = await waitFor(() => screen.getByLabelText(/请确认真实的知识点名称/) as HTMLInputElement);
		expect(input.value).toBe("");
		expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(true);

		fireEvent.change(input, { target: { value: "Python 闭包" } });
		expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(screen.getByLabelText(/我确认这个名称属于当前复习知识点/));
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
	});

	it("does not pretend a link is still due and offers ordinary practice instead", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([
			reviewRecommendation({
				action: "practice", suggested_kind: "application", reason_code: "fragile_evidence",
				reason: "还不稳定。", also_matches: [],
			}),
		]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/不再显示为到期复习/)).toBeTruthy());
		expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "改为普通练习" }));
		expect(nav.navigate).toHaveBeenCalledWith("practice", { history: "replace", session: "s1.jsonl" });
	});

	it("blocks a session with an unfinished question instead of overwriting it", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(3, {
				step: "awaiting_answer", question: { question_id: "q_pending", question_version: "1" },
				pending_attempt_id: "a_pending",
			}),
			questions: [savedQuestion],
			attempts: [{ attempt_id: "a_pending", question_id: "q_pending", question_version: "1", answer: "x", accepted_at: "x", stage: "answer_saved", retryable: false, evaluation_attempts: 0 }],
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/还有未完成的内容/)).toBeTruthy());
		expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("requires a session before generating and keeps the review concept when creation fails", async () => {
		setReviewUrl();
		sessionsStore.currentSessionId = null;
		learningStore.clear();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		vi.spyOn(sessionsStore, "createSessionWith").mockResolvedValue(null);

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/尚未选择学习会话/)).toBeTruthy());
		expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: /新建复习会话/ }));
		await waitFor(() => expect(screen.getByText(/创建复习会话失败/)).toBeTruthy());
		expect(screen.getByText("Python 闭包")).toBeTruthy();
	});

	it("surfaces an active misconception while still allowing the due review", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([
			reviewRecommendation({
				action: "learn", suggested_kind: undefined, reason_code: "active_misconception",
				reason: "先澄清误区。", also_matches: ["review_due"],
			}),
		]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/先澄清一个活跃误区/)).toBeTruthy());
		expect(screen.getByRole("button", { name: /前往 AI 学习/ })).toBeTruthy();
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
	});

	it("binds the generated question identity into the URL and shows the review badge", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });
		api.generateLearningQuestion.mockResolvedValue({
			created: true,
			question: reviewQuestion,
			checkpoint: checkpoint(3, {
				step: "awaiting_answer",
				question: { question_id: "q_review", question_version: "1" },
			}),
			knowledge: { kind: "model_knowledge" },
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: /生成复习题/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));

		await waitFor(() => expect(screen.getByText(reviewQuestion.prompt)).toBeTruthy());
		expect(screen.getByText("复习")).toBeTruthy();
		expect(nav.navigate).toHaveBeenCalledWith("practice", {
			history: "replace",
			session: "s1.jsonl",
			review: { conceptId: reviewConcept, questionId: "q_review" },
		});
	});

	it("drops a late response for a review concept the learner already left", async () => {
		const deferredA = (() => {
			let resolve!: (value: unknown) => void;
			const promise = new Promise<unknown>((yes) => { resolve = yes; });
			return { promise, resolve };
		})();
		const snapshotFor = (conceptId: string, name: string) => ({
			as_of: "2026-11-04T00:00:00.000Z",
			generated_at: "2026-11-04T00:00:00.000Z",
			profile_version: 4,
			recommendations: [reviewRecommendation({ concept_id: conceptId, concept_name: name })],
			status: "ok" as const,
			limit: 3,
			concept_id: conceptId,
		});
		learnerStore.profile = {
			knowledge_states: [
				{ ...profileWithName("知识点 A").knowledge_states[0], concept_id: "concept_a", concept_name: "知识点 A" },
				{ ...profileWithName("知识点 B").knowledge_states[0], concept_id: "concept_b", concept_name: "知识点 B" },
			],
			goals: [],
		} as never;
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });
		learnerApi.getLearningRecommendations.mockImplementation((_limit: number, conceptId: string) => (
			conceptId === "concept_a"
				? deferredA.promise
				: Promise.resolve(snapshotFor("concept_b", "知识点 B"))
		));

		window.history.replaceState(null, "", "/?page=practice&intent=review&review_concept_id=concept_a&session=s1.jsonl");
		render(<PracticePage />);
		await waitFor(() => expect(screen.getByText("复习准备")).toBeTruthy());

		window.history.replaceState(null, "", "/?page=practice&intent=review&review_concept_id=concept_b&session=s1.jsonl");
		act(() => { window.dispatchEvent(new Event("popstate")); });

		await waitFor(() => expect(screen.getByText("知识点 B")).toBeTruthy());
		await act(async () => {
			deferredA.resolve(snapshotFor("concept_a", "知识点 A"));
			await deferredA.promise;
		});
		expect(screen.getByText("知识点 B")).toBeTruthy();
		expect(screen.queryByText("知识点 A")).toBeNull();
		expect(api.generateLearningQuestion).not.toHaveBeenCalled();
	});

	it("shows that a session has no learning record without initialising it on open", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({ exists: false });

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/还没有学习记录/)).toBeTruthy());
		expect(api.initLearning).not.toHaveBeenCalled();
		expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("refuses a paused learning session", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(2, { status: "paused" }),
			questions: [],
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(/还有未完成的内容/)).toBeTruthy());
		expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("stops before generating when the concept stops being due after entry", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations
			.mockResolvedValueOnce(reviewSnapshot([reviewRecommendation()]))
			.mockResolvedValueOnce(reviewSnapshot([
				reviewRecommendation({ action: "practice", suggested_kind: "application", reason_code: "fragile_evidence", also_matches: [] }),
			]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });
		api.generateLearningQuestion.mockResolvedValue({});

		render(<PracticePage />);
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));

		await waitFor(() => expect(screen.getAllByText(/不再显示为到期复习/).length).toBeGreaterThan(0));
		expect(api.generateLearningQuestion).not.toHaveBeenCalled();
	});

	it("continues a feedback session with the completed attempt binding", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(6, {
				step: "feedback", question: { question_id: "q_previous", question_version: "1" },
				last_completed_attempt_id: "a_previous",
			}),
			questions: [savedQuestion],
			attempts: [{
				attempt_id: "a_previous", question_id: "q_previous", question_version: "1",
				answer: "上一题", accepted_at: "x", stage: "completed" as const,
				assessment: { result: "correct" as const, score: 1, feedback: "好", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});
		api.generateLearningQuestion.mockResolvedValue({
			created: true,
			question: { ...reviewQuestion, prompt: "续接复习题" },
			checkpoint: checkpoint(7, {
				step: "awaiting_answer", question: { question_id: "q_review", question_version: "1" },
			}),
			knowledge: { kind: "model_knowledge" },
		});

		render(<PracticePage />);
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));

		await waitFor(() => expect(api.generateLearningQuestion).toHaveBeenCalled());
		expect(api.generateLearningQuestion.mock.calls[0][1].after_attempt_id).toBe("a_previous");
	});

	it("uses the explicitly chosen question kind and never sends client state", async () => {
		setReviewUrl();
		window.history.replaceState(
			null, "", `${window.location.pathname}${window.location.search}&mastery=0.99&state_label=stable`,
		);
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });
		api.generateLearningQuestion.mockResolvedValue({
			created: true,
			question: { ...reviewQuestion, prompt: "应用题", kind: "application" },
			checkpoint: checkpoint(3, {
				step: "awaiting_answer", question: { question_id: "q_review", question_version: "1" },
			}),
			knowledge: { kind: "model_knowledge" },
		});

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByLabelText("题型")).toBeTruthy());
		fireEvent.change(screen.getByLabelText("题型"), { target: { value: "application" } });
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));

		await waitFor(() => expect(api.generateLearningQuestion).toHaveBeenCalled());
		const payload = api.generateLearningQuestion.mock.calls[0][1];
		expect(payload.kind).toBe("application");
		expect(payload.mastery).toBeUndefined();
		expect(payload.state_label).toBeUndefined();
	});

	it("leaves review mode without reusing the concept for ordinary practice", async () => {
		setReviewUrl();
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });

		render(<PracticePage />);
		await waitFor(() => expect(screen.getByRole("button", { name: "改为普通练习" })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "改为普通练习" }));

		expect(nav.navigate).toHaveBeenCalledWith("practice", { history: "replace", session: "s1.jsonl" });
		expect(api.generateLearningQuestion).not.toHaveBeenCalled();
	});

	it("claims review completion only after C3 recorded the exact review question", async () => {
		setReviewUrl("q_review");
		learnerStore.profile = profileWithName("Python 闭包") as never;
		learnerApi.getLearningRecommendations.mockResolvedValue(reviewSnapshot([reviewRecommendation()]));
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(6, {
				step: "feedback", question: { question_id: "q_review", question_version: "1" },
				last_completed_attempt_id: "a_review",
			}),
			questions: [reviewQuestion],
			attempts: [{
				attempt_id: "a_review", question_id: "q_review", question_version: "1",
				answer: "复习作答", accepted_at: "x", stage: "completed" as const,
				assessment: { result: "correct" as const, score: 1, feedback: "复习评分", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText("本次复习作答已记录。")).toBeTruthy());
		expect(screen.getByRole("button", { name: /返回今日学习/ })).toBeTruthy();
		expect(screen.getByText("复习评分")).toBeTruthy();
	});
});

describe("practice page review request identity (C4-C patch)", () => {
	const conceptId = "concept_closure";
	const reviewQuestion = {
		question_id: "q_review", question_version: "1", concept_id: conceptId,
		prompt: "复习题：闭包为什么持有外层变量？", kind: "free_recall" as const,
		review: true as const,
	};
	const plainQuestion = {
		question_id: "q_plain", question_version: "1", concept_id: conceptId,
		prompt: "普通练习题：解释闭包。", kind: "free_recall" as const,
	};
	const profileWithName = () => ({
		knowledge_states: [{
			concept_id: conceptId, concept_name: "Python 闭包", domain: "programming",
			mastery: 0.5, estimate_confidence: 0.4, stability_days: 1, exposure_count: 1,
			retrieval_count: 1, lapse_count: 0, successful_transfer_count: 0,
			active_misconception_ids: [], evidence_ids: ["ev_1"], state_label: "review_due",
			review_due_at: "2026-11-01T00:00:00.000Z", origin: "derived",
			diagnosis: "", next_actions: [],
		}],
		goals: [],
	});
	const dueSnapshot = () => ({
		as_of: "2026-11-04T00:00:00.000Z",
		generated_at: "2026-11-04T00:00:00.000Z",
		profile_version: 4,
		recommendations: [{
			concept_id: conceptId,
			concept_name: "Python 闭包",
			name_available: true,
			action: "review" as const,
			suggested_kind: "free_recall" as const,
			reason_code: "review_due" as const,
			reason: "复习时间已到。",
			also_matches: [],
			evidence_basis: {
				state_label: "review_due" as const,
				review_due_at: "2026-11-01T00:00:00.000Z",
				evidence_count: 2,
				has_active_misconception: false,
				provenance_limited: false,
				exposure_only: false,
			},
		}],
		status: "ok" as const,
		limit: 3,
		concept_id: conceptId,
	});
	const setReviewUrl = (questionId?: string) => {
		const params = new URLSearchParams({
			page: "practice", intent: "review", review_concept_id: conceptId, session: "s1.jsonl",
		});
		if (questionId) params.set("review_question_id", questionId);
		window.history.replaceState(null, "", `/?${params.toString()}`);
	};
	const deferred = <T,>() => {
		let resolve!: (value: T) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
		return { promise, resolve, reject };
	};

	beforeEach(() => {
		learnerStore.profile = profileWithName() as never;
	});

	it("never posts session A's review into session B when the L1 check is still pending", async () => {
		setReviewUrl();
		const pendingCheck = deferred<ReturnType<typeof dueSnapshot>>();
		learnerApi.getLearningRecommendations
			.mockResolvedValueOnce(dueSnapshot())
			.mockReturnValueOnce(pendingCheck.promise);
		api.getLearningState.mockImplementation((id: string) => Promise.resolve(
			id === "s2.jsonl"
				? { exists: true, checkpoint: checkpoint(1), questions: [] }
				: { exists: true, checkpoint: checkpoint(2), questions: [] },
		));

		render(<PracticePage />);
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));
		await waitFor(() => expect(learnerApi.getLearningRecommendations).toHaveBeenCalledTimes(2));

		act(() => { sessionsStore.selectSession("s2.jsonl"); });
		await waitFor(() => expect(learningStore.sessionId).toBe("s2.jsonl"));

		await act(async () => {
			pendingCheck.resolve(dueSnapshot());
			await pendingCheck.promise;
		});

		expect(api.generateLearningQuestion).not.toHaveBeenCalled();
		expect(nav.navigate).not.toHaveBeenCalledWith("practice", expect.objectContaining({ review: expect.anything() }));
	});

	it("does not re-enter review mode when the learner leaves before the check returns", async () => {
		setReviewUrl();
		const pendingCheck = deferred<ReturnType<typeof dueSnapshot>>();
		learnerApi.getLearningRecommendations
			.mockResolvedValueOnce(dueSnapshot())
			.mockReturnValueOnce(pendingCheck.promise);
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });

		render(<PracticePage />);
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));
		fireEvent.click(screen.getByRole("button", { name: "改为普通练习" }));

		await act(async () => {
			pendingCheck.resolve(dueSnapshot());
			await pendingCheck.promise;
		});

		expect(api.generateLearningQuestion).not.toHaveBeenCalled();
		expect(screen.queryByText("复习准备")).toBeNull();
		expect(nav.navigate).toHaveBeenCalledTimes(1);
		expect(nav.navigate).toHaveBeenCalledWith("practice", { history: "replace", session: "s1.jsonl" });
	});

	it("does not paint or navigate a generation that finishes after a session switch", async () => {
		setReviewUrl();
		learnerApi.getLearningRecommendations.mockResolvedValue(dueSnapshot());
		api.getLearningState.mockImplementation((id: string) => Promise.resolve(
			id === "s2.jsonl"
				? { exists: true, checkpoint: checkpoint(1), questions: [] }
				: { exists: true, checkpoint: checkpoint(2), questions: [] },
		));
		const pendingGeneration = deferred<unknown>();
		api.generateLearningQuestion.mockReturnValueOnce(pendingGeneration.promise);

		render(<PracticePage />);
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));
		await waitFor(() => expect(api.generateLearningQuestion).toHaveBeenCalled());

		act(() => { sessionsStore.selectSession("s2.jsonl"); });
		await waitFor(() => expect(learningStore.sessionId).toBe("s2.jsonl"));

		await act(async () => {
			pendingGeneration.resolve({
				created: true,
				question: reviewQuestion,
				checkpoint: checkpoint(3, {
					step: "awaiting_answer", question: { question_id: "q_review", question_version: "1" },
				}),
				knowledge: { kind: "model_knowledge" },
			});
			await pendingGeneration.promise;
		});

		expect(nav.navigate).not.toHaveBeenCalledWith("practice", expect.objectContaining({ review: expect.anything() }));
		expect(screen.queryByText(reviewQuestion.prompt)).toBeNull();
		expect(learningStore.state?.checkpoint?.question?.question_id).not.toBe("q_review");
	});

	it("restores the review identity of a saved question after a lost response", async () => {
		// The URL still has the entry time intent but no question id: the response
		// that carried it never arrived. B2 has both the question and the reason.
		setReviewUrl();
		learnerApi.getLearningRecommendations.mockResolvedValue(dueSnapshot());
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(3, {
				step: "awaiting_answer", question: { question_id: "q_review", question_version: "1" },
			}),
			questions: [plainQuestion, reviewQuestion],
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(reviewQuestion.prompt)).toBeTruthy());
		expect(screen.getByText("复习")).toBeTruthy();
		expect(screen.queryByText("复习准备")).toBeNull();
		expect((screen.getByLabelText("你的回答") as HTMLTextAreaElement).disabled).toBe(false);
		// Recovering a question is a read: nothing was generated for it.
		expect(api.generateLearningQuestion).not.toHaveBeenCalled();
	});

	it("retries a failed review generation with the same request identity", async () => {
		setReviewUrl();
		learnerApi.getLearningRecommendations.mockResolvedValue(dueSnapshot());
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(2), questions: [] });
		api.generateLearningQuestion
			.mockRejectedValueOnce(new Error("网络中断"))
			.mockResolvedValueOnce({
				created: true,
				question: reviewQuestion,
				checkpoint: checkpoint(3, {
					step: "awaiting_answer", question: { question_id: "q_review", question_version: "1" },
				}),
				knowledge: { kind: "model_knowledge" },
			});

		render(<PracticePage />);
		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("网络中断"));

		await waitFor(() => expect((screen.getByRole("button", { name: /生成复习题/ }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: /生成复习题/ }));
		await waitFor(() => expect(api.generateLearningQuestion).toHaveBeenCalledTimes(2));

		const [first, second] = api.generateLearningQuestion.mock.calls;
		expect(first[1].request_id).toBe(second[1].request_id);
		expect(first[1].intent).toBe("review");
		expect(second[1].intent).toBe("review");
	});

	it("does not treat an ordinary question as a review when only the URL says so", async () => {
		setReviewUrl("q_plain");
		learnerApi.getLearningRecommendations.mockResolvedValue(dueSnapshot());
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: checkpoint(5, {
				step: "feedback", question: { question_id: "q_plain", question_version: "1" },
				last_completed_attempt_id: "a_plain",
			}),
			questions: [plainQuestion],
			attempts: [{
				attempt_id: "a_plain", question_id: "q_plain", question_version: "1",
				answer: "普通作答", accepted_at: "x", stage: "completed" as const,
				assessment: { result: "correct" as const, score: 1, feedback: "普通评分", criteria: [] },
				retryable: false, evaluation_attempts: 1,
			}],
		});

		render(<PracticePage />);

		await waitFor(() => expect(screen.getByText(plainQuestion.prompt)).toBeTruthy());
		expect(screen.queryByText("复习")).toBeNull();
		expect(screen.queryByText("本次复习作答已记录。")).toBeNull();
		expect(screen.getByText("本题已记录")).toBeTruthy();
		expect(api.generateLearningQuestion).not.toHaveBeenCalled();
	});
});
