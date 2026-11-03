import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { LearningCheckpointView, LearningState } from "../api/learning.js";
import { learningStore } from "./learning-store.js";

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

vi.mock("../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../api/learning.js")>("../api/learning.js");
	return { ...actual, ...api };
});

const checkpoint = (revision: number, status: "active" | "paused" = "active") => ({
	revision, status, step: "awaiting_answer" as const, updated_at: "2026-11-02T00:00:00.000Z",
});

beforeEach(() => {
	vi.clearAllMocks();
	learningStore.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("learning store", () => {
	it("loads the public state without initialising a missing record", async () => {
		api.getLearningState.mockResolvedValue({ exists: false });
		await learningStore.load("s1.jsonl");
		expect(api.getLearningState).toHaveBeenCalledWith("s1.jsonl");
		// Entering a page must never create the record implicitly.
		expect(api.initLearning).not.toHaveBeenCalled();
		expect(learningStore.state).toEqual({ exists: false });
	});

	it("initialises only when explicitly asked", async () => {
		learningStore.sessionId = "s1.jsonl";
		api.initLearning.mockResolvedValue(checkpoint(1));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(1) });
		await learningStore.init("goal-1");
		expect(api.initLearning).toHaveBeenCalledWith("s1.jsonl", "goal-1");
		expect(learningStore.state?.checkpoint?.revision).toBe(1);
	});

	it("pauses and resumes with the current checkpoint revision", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(3) };
		api.pauseLearning.mockResolvedValue(checkpoint(4, "paused"));
		await learningStore.pause();
		expect(api.pauseLearning).toHaveBeenCalledWith("s1.jsonl", 3);
		expect(learningStore.state?.checkpoint?.status).toBe("paused");

		api.resumeLearning.mockResolvedValue(checkpoint(5));
		await learningStore.resume();
		expect(api.resumeLearning).toHaveBeenCalledWith("s1.jsonl", 4);
		expect(learningStore.state?.checkpoint?.status).toBe("active");
	});

	it("reports a conflict and reloads the newest revision instead of clobbering it", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(2) };
		api.pauseLearning.mockRejectedValue(new ApiError(409, "learning_conflict", { revision: 5 }));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(5) });

		await learningStore.pause();
		expect(learningStore.error).toContain("已被更新");
		expect(api.getLearningState).toHaveBeenCalledWith("s1.jsonl");
		expect(learningStore.state?.checkpoint?.revision).toBe(5);
	});

	it("maps storage failures to non-leaking messages", async () => {
		api.getLearningState.mockRejectedValue(new ApiError(503, "learning_read_only"));
		await learningStore.load("s1.jsonl");
		expect(learningStore.error).toContain("不可写");
		expect(learningStore.state).toBeNull();

		api.getLearningState.mockRejectedValue(new ApiError(404, "Session not found"));
		await learningStore.load("s2.jsonl");
		expect(learningStore.error).toContain("不存在");
	});

	it("clears state when no session is open", () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1) };
		learningStore.clear();
		expect(learningStore.state).toBeNull();
		expect(learningStore.sessionId).toBeNull();
	});
});

/**
 * Deterministic concurrency: every response is released by the test, so these
 * assertions never depend on timing or random delays.
 */
describe("learning store async isolation", () => {
	it("keeps the newer session when A and B resolve out of order", async () => {
		const a = deferred<LearningState>();
		const b = deferred<LearningState>();
		api.getLearningState.mockImplementation((id: string) => (id === "a.jsonl" ? a.promise : b.promise));

		const loadingA = learningStore.load("a.jsonl");
		const loadingB = learningStore.load("b.jsonl");
		b.resolve({ exists: true, checkpoint: checkpoint(2) });
		await loadingB;
		a.resolve({ exists: true, checkpoint: checkpoint(9) });
		await loadingA;

		expect(learningStore.sessionId).toBe("b.jsonl");
		expect(learningStore.state?.checkpoint?.revision).toBe(2);
		expect(learningStore.isLoading).toBe(false);
	});

	it("does not let a stale finally clear the live loading flag", async () => {
		const a = deferred<LearningState>();
		const b = deferred<LearningState>();
		api.getLearningState.mockImplementation((id: string) => (id === "a.jsonl" ? a.promise : b.promise));

		const loadingA = learningStore.load("a.jsonl");
		const loadingB = learningStore.load("b.jsonl");
		a.resolve({ exists: true, checkpoint: checkpoint(1) });
		await loadingA;

		// B is still in flight: the old response must not end its spinner.
		expect(learningStore.isLoading).toBe(true);
		expect(learningStore.state).toBeNull();

		b.resolve({ exists: false });
		await loadingB;
		expect(learningStore.isLoading).toBe(false);
		expect(learningStore.state).toEqual({ exists: false });
	});

	it("drops a response that lands after the selection was cleared", async () => {
		const a = deferred<LearningState>();
		api.getLearningState.mockReturnValue(a.promise);

		const loading = learningStore.load("a.jsonl");
		learningStore.clear();
		a.resolve({ exists: true, checkpoint: checkpoint(3) });
		await loading;

		expect(learningStore.sessionId).toBeNull();
		expect(learningStore.state).toBeNull();
		expect(learningStore.error).toBeNull();
		expect(learningStore.isLoading).toBe(false);
	});

	it("keeps A's pause result out of session B", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1) };
		const paused = deferred<LearningCheckpointView>();
		api.pauseLearning.mockReturnValue(paused.promise);

		const pausing = learningStore.pause();

		const fresh = deferred<LearningState>();
		api.getLearningState.mockReturnValue(fresh.promise);
		const loadingB = learningStore.load("b.jsonl");
		fresh.resolve({ exists: true, checkpoint: checkpoint(7) });
		await loadingB;

		paused.resolve(checkpoint(2, "paused"));
		await pausing;

		// The server applied the pause to A; the UI still shows B.
		expect(learningStore.sessionId).toBe("b.jsonl");
		expect(learningStore.state?.checkpoint?.revision).toBe(7);
		expect(learningStore.state?.checkpoint?.status).toBe("active");
		expect(learningStore.error).toBeNull();
		expect(learningStore.isSaving).toBe(false);
	});

	it("keeps A's initialisation out of session B", async () => {
		learningStore.sessionId = "a.jsonl";
		const created = deferred<void>();
		api.initLearning.mockReturnValue(created.promise);

		const initialising = learningStore.init("goal-1");

		const fresh = deferred<LearningState>();
		api.getLearningState.mockReturnValue(fresh.promise);
		const loadingB = learningStore.load("b.jsonl");
		fresh.resolve({ exists: true, checkpoint: checkpoint(4) });
		await loadingB;

		created.resolve();
		await initialising;

		expect(learningStore.sessionId).toBe("b.jsonl");
		expect(learningStore.state?.checkpoint?.revision).toBe(4);
		expect(learningStore.isSaving).toBe(false);
	});

	it("does not let an old failure overwrite the new session's error slot", async () => {
		const a = deferred<LearningState>();
		const b = deferred<LearningState>();
		api.getLearningState.mockImplementation((id: string) => (id === "a.jsonl" ? a.promise : b.promise));

		const loadingA = learningStore.load("a.jsonl");
		const loadingB = learningStore.load("b.jsonl");
		b.resolve({ exists: false });
		await loadingB;
		a.reject(new ApiError(503, "learning_read_only"));
		await loadingA;

		expect(learningStore.error).toBeNull();
		expect(learningStore.state).toEqual({ exists: false });
	});

	it("keeps a conflict refresh inside its own session", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(2) };
		const paused = deferred<LearningCheckpointView>();
		api.pauseLearning.mockReturnValue(paused.promise);

		const pausing = learningStore.pause();

		const fresh = deferred<LearningState>();
		api.getLearningState.mockReturnValue(fresh.promise);
		const loadingB = learningStore.load("b.jsonl");
		fresh.resolve({ exists: true, checkpoint: checkpoint(11) });
		await loadingB;

		paused.reject(new ApiError(409, "learning_conflict", { revision: 5 }));
		await pausing;

		// A's conflict must not reload A, replace B's state, or raise an error on B.
		expect(api.getLearningState).toHaveBeenCalledTimes(1);
		expect(learningStore.state?.checkpoint?.revision).toBe(11);
		expect(learningStore.error).toBeNull();
	});
});

/**
 * A read and a write have different lifetimes: a reload must never decide that
 * a save which is still running has finished. These cases fail if the two share
 * one request ticket.
 */
describe("learning store read/write lifetimes", () => {
	it("keeps an in-flight pause alive across a same-session reload", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1) };
		const paused = deferred<LearningCheckpointView>();
		api.pauseLearning.mockReturnValue(paused.promise);

		const pausing = learningStore.pause();
		expect(learningStore.isSaving).toBe(true);

		// Opening the practice page while the pause is still on the wire.
		const reload = deferred<LearningState>();
		api.getLearningState.mockReturnValue(reload.promise);
		const reloading = learningStore.load("a.jsonl");

		// Starting a read must not announce the running save as finished.
		expect(learningStore.isSaving).toBe(true);
		expect(learningStore.isLoading).toBe(true);

		reload.resolve({ exists: true, checkpoint: checkpoint(1) });
		await reloading;
		// The read finished first; the save is still pending.
		expect(learningStore.isSaving).toBe(true);

		paused.resolve(checkpoint(2, "paused"));
		await pausing;

		expect(learningStore.isSaving).toBe(false);
		expect(learningStore.isLoading).toBe(false);
		// The successful server operation is reflected in the checkpoint.
		expect(learningStore.state?.checkpoint?.revision).toBe(2);
		expect(learningStore.state?.checkpoint?.status).toBe("paused");
	});

	it("keeps an in-flight initialisation alive across a same-session reload", async () => {
		learningStore.sessionId = "a.jsonl";
		const created = deferred<void>();
		api.initLearning.mockReturnValue(created.promise);
		const reload = deferred<LearningState>();
		api.getLearningState
			.mockImplementationOnce(() => reload.promise)
			.mockResolvedValue({ exists: true, checkpoint: checkpoint(1) });

		const initialising = learningStore.init("goal-1");
		expect(learningStore.isSaving).toBe(true);

		const reloading = learningStore.load("a.jsonl");
		reload.resolve({ exists: false });
		await reloading;
		expect(learningStore.isSaving).toBe(true);

		created.resolve();
		await initialising;

		expect(learningStore.isSaving).toBe(false);
		expect(learningStore.state?.exists).toBe(true);
		expect(learningStore.state?.checkpoint?.revision).toBe(1);
	});

	it("does not let a reload that returns after the save overwrite it", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1) };
		const paused = deferred<LearningCheckpointView>();
		api.pauseLearning.mockReturnValue(paused.promise);
		const reload = deferred<LearningState>();
		api.getLearningState.mockReturnValue(reload.promise);

		const pausing = learningStore.pause();
		const reloading = learningStore.load("a.jsonl");

		paused.resolve(checkpoint(2, "paused"));
		await pausing;
		expect(learningStore.state?.checkpoint?.revision).toBe(2);

		// This read was issued before the pause committed, so its payload is older.
		reload.resolve({ exists: true, checkpoint: checkpoint(1) });
		await reloading;

		expect(learningStore.state?.checkpoint?.revision).toBe(2);
		expect(learningStore.isSaving).toBe(false);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("question generation in the store", () => {
	const generated = (revision: number) => ({
		created: true,
		question: {
			question_id: `q${revision}`, question_version: "1", concept_id: "concept_closure",
			prompt: `题目 ${revision}`, kind: "free_recall" as const,
		},
		checkpoint: {
			revision, status: "active" as const, step: "awaiting_answer" as const,
			updated_at: "2026-11-02T00:00:00.000Z",
			question: { question_id: `q${revision}`, question_version: "1" },
			knowledge: { kind: "model_knowledge" as const },
		},
		knowledge: { kind: "model_knowledge" as const },
	});

	it("applies the new checkpoint and question", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1), questions: [] };
		api.generateLearningQuestion.mockResolvedValue(generated(2));

		const ok = await learningStore.generate({ concept: "闭包", allow_model_fallback: true });

		expect(ok).toBe(true);
		expect(learningStore.state?.checkpoint?.revision).toBe(2);
		expect(learningStore.state?.checkpoint?.step).toBe("awaiting_answer");
		expect(learningStore.state?.questions?.map((item) => item.question_id)).toEqual(["q2"]);
		expect(learningStore.isGenerating).toBe(false);
		expect(learningStore.generateError).toBeNull();
	});

	it("reuses the request id for an unchanged retry and only then", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1), questions: [] };
		api.generateLearningQuestion.mockRejectedValue(Object.assign(new Error("boom"), { status: 502 }));

		await learningStore.generate({ concept: "闭包", allow_model_fallback: true });
		const firstId = (api.generateLearningQuestion.mock.calls[0] as [string, { request_id: string }])[1].request_id;

		await learningStore.generate({ concept: "闭包", allow_model_fallback: true });
		const secondId = (api.generateLearningQuestion.mock.calls[1] as [string, { request_id: string }])[1].request_id;
		expect(secondId).toBe(firstId);

		await learningStore.generate({ concept: "装饰器", allow_model_fallback: true });
		const thirdId = (api.generateLearningQuestion.mock.calls[2] as [string, { request_id: string }])[1].request_id;
		expect(thirdId).not.toBe(firstId);
	});

	it("does not let a late generation paint another session", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1), questions: [] };
		const pending = deferred<ReturnType<typeof generated>>();
		api.generateLearningQuestion.mockReturnValue(pending.promise);

		const running = learningStore.generate({ concept: "闭包", allow_model_fallback: true });
		expect(learningStore.isGenerating).toBe(true);

		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(7), questions: [] });
		await learningStore.load("b.jsonl");
		expect(learningStore.isGenerating).toBe(false);

		pending.resolve(generated(2));
		await running;

		expect(learningStore.sessionId).toBe("b.jsonl");
		expect(learningStore.state?.checkpoint?.revision).toBe(7);
		expect(learningStore.state?.questions).toEqual([]);
		expect(learningStore.generateError).toBeNull();
	});

	it("refreshes after a conflict and keeps the message visible", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1), questions: [] };
		api.generateLearningQuestion.mockRejectedValue(Object.assign(new Error("learning_conflict"), {
			status: 409,
			data: { error: "learning_conflict", message: "学习状态已更新，请重新加载后再试。" },
		}));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(5), questions: [] });

		const ok = await learningStore.generate({ concept: "闭包", allow_model_fallback: true });

		expect(ok).toBe(false);
		expect(learningStore.generateError).toContain("学习状态已更新");
		expect(learningStore.state?.checkpoint?.revision).toBe(5);
		expect(learningStore.isGenerating).toBe(false);
	});

	it("does not leak a generation error into a different session", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1), questions: [] };
		api.generateLearningQuestion.mockRejectedValue(Object.assign(new Error("boom"), { status: 502 }));
		await learningStore.generate({ concept: "闭包", allow_model_fallback: true });
		expect(learningStore.generateError).not.toBeNull();

		// Switching sessions clears the stale error, so B never shows A's failure.
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(3), questions: [] });
		await learningStore.load("b.jsonl");
		expect(learningStore.generateError).toBeNull();
	});

	it("gives a different kind its own retry id", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1), questions: [] };
		api.generateLearningQuestion.mockRejectedValue(Object.assign(new Error("boom"), { status: 502 }));

		await learningStore.generate({ concept: "闭包", kind: "free_recall", allow_model_fallback: true });
		const freeRecallId = (api.generateLearningQuestion.mock.calls[0] as [string, { request_id: string }])[1].request_id;

		await learningStore.generate({ concept: "闭包", kind: "application", allow_model_fallback: true });
		const applicationId = (api.generateLearningQuestion.mock.calls[1] as [string, { request_id: string }])[1].request_id;

		// Same concept but a different question type is a different intent, so it
		// must not reuse the previous retry id (which would collide server-side).
		expect(applicationId).not.toBe(freeRecallId);
	});
});

describe("answer submission and evaluation in the store", () => {
	const answeredCheckpoint = (revision: number, pending = "attempt_1") => ({
		revision, status: "active" as const, step: "awaiting_answer" as const,
		updated_at: "2026-11-03T00:00:00.000Z",
		question: { question_id: "q1", question_version: "1" },
		pending_attempt_id: pending,
	});

	it("submits the answer with a stable attempt id and applies the checkpoint", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = {
			exists: true,
			checkpoint: { ...answeredCheckpoint(2), pending_attempt_id: undefined },
			questions: [],
		};
		api.submitAnswer.mockResolvedValue({
			created: true,
			attempt: { attempt_id: "a1", question_id: "q1", question_version: "1", accepted_at: "x" },
			checkpoint: answeredCheckpoint(3),
		});

		const ok = await learningStore.submitAnswer("闭包捕获变量绑定。");
		expect(ok).toBe(true);

		const [sessionId, payload] = api.submitAnswer.mock.calls[0] as [string, Record<string, unknown>];
		expect(sessionId).toBe("s1.jsonl");
		expect(payload.question_id).toBe("q1");
		expect(payload.answer).toBe("闭包捕获变量绑定。");
		expect(typeof payload.attempt_id).toBe("string");
		expect(learningStore.state?.checkpoint?.pending_attempt_id).toBe("attempt_1");
		expect(learningStore.isSubmitting).toBe(false);
	});

	it("reuses the attempt id for an identical retry", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = {
			exists: true,
			checkpoint: { ...answeredCheckpoint(2), pending_attempt_id: undefined },
			questions: [],
		};
		api.submitAnswer.mockRejectedValue(Object.assign(new Error("boom"), { status: 502 }));

		await learningStore.submitAnswer("答案");
		const firstId = (api.submitAnswer.mock.calls[0] as [string, { attempt_id: string }])[1].attempt_id;
		await learningStore.submitAnswer("答案");
		const secondId = (api.submitAnswer.mock.calls[1] as [string, { attempt_id: string }])[1].attempt_id;
		expect(secondId).toBe(firstId);

		await learningStore.submitAnswer("另一个答案");
		const thirdId = (api.submitAnswer.mock.calls[2] as [string, { attempt_id: string }])[1].attempt_id;
		expect(thirdId).not.toBe(firstId);
	});

	it("evaluates the pending attempt and stores the public assessment", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: answeredCheckpoint(3), questions: [] };
		api.evaluateAnswer.mockResolvedValue({
			replayed: false,
			pending_action: "publish_saved_evidence",
			assessment: {
				result: "partial",
				score: 0.5,
				feedback: "部分正确。",
				criteria: [{ criterion_id: "c1", judgment: "met", explanation: "对" }],
			},
			checkpoint: answeredCheckpoint(4),
		});

		const ok = await learningStore.evaluateAnswer();
		expect(ok).toBe(true);
		const [sessionId, attemptId, revision] = api.evaluateAnswer.mock.calls[0] as [string, string, number];
		expect(sessionId).toBe("s1.jsonl");
		expect(attemptId).toBe("attempt_1");
		expect(revision).toBe(3);
		expect(learningStore.assessment?.result).toBe("partial");
		expect(learningStore.isEvaluating).toBe(false);
	});

	it("does not let a late evaluation paint another session", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: answeredCheckpoint(3, "attempt_a"), questions: [] };
		const pending = deferred<Awaited<ReturnType<typeof api.evaluateAnswer>>>();
		api.evaluateAnswer.mockReturnValue(pending.promise);

		const running = learningStore.evaluateAnswer();
		expect(learningStore.isEvaluating).toBe(true);

		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: answeredCheckpoint(7), questions: [] });
		await learningStore.load("b.jsonl");
		expect(learningStore.isEvaluating).toBe(false);

		pending.resolve({
			replayed: false,
			pending_action: "publish_saved_evidence",
			assessment: { result: "correct", score: 1, feedback: "好", criteria: [] },
			checkpoint: answeredCheckpoint(4),
		});
		await running;

		expect(learningStore.sessionId).toBe("b.jsonl");
		expect(learningStore.assessment).toBeNull();
	});

	it("finalizes an evaluated attempt: invokes finalizeAttempt and updates checkpoint (C3)", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = {
			exists: true,
			checkpoint: answeredCheckpoint(4, "attempt_1"),
			questions: [],
		};
		api.finalizeAttempt.mockResolvedValue({
			replayed: false,
			profile_version: 15,
			attempt: { attempt_id: "attempt_1", stage: "completed" },
			checkpoint: {
				revision: 5,
				status: "active",
				step: "feedback",
				updated_at: "2026-11-03T00:00:00.000Z",
				last_completed_attempt_id: "attempt_1",
			},
		});
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: {
				revision: 5,
				status: "active",
				step: "feedback",
				updated_at: "2026-11-03T00:00:00.000Z",
				last_completed_attempt_id: "attempt_1",
			},
			questions: [],
			attempts: [{
				attempt_id: "attempt_1",
				question_id: "q1",
				question_version: "1",
				answer: "ans",
				accepted_at: "t",
				stage: "completed",
				retryable: false,
				evaluation_attempts: 1,
			}],
		});

		const ok = await learningStore.finalizeAttempt();
		expect(ok).toBe(true);
		expect(api.finalizeAttempt).toHaveBeenCalledWith("s1.jsonl", "attempt_1", 4);
		expect(learningStore.state?.checkpoint?.revision).toBe(5);
		expect(learningStore.state?.checkpoint?.step).toBe("feedback");
		expect(learningStore.isFinalizing).toBe(false);
	});

	it("handles finalization failure and sets finalizeError (C3)", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = {
			exists: true,
			checkpoint: answeredCheckpoint(4, "attempt_1"),
			questions: [],
		};
		api.finalizeAttempt.mockRejectedValue(new ApiError(409, "finalization error", { error: "learning_conflict", message: "冲突" }));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: answeredCheckpoint(4, "attempt_1"), questions: [] });

		const ok = await learningStore.finalizeAttempt();
		expect(ok).toBe(false);
		expect(learningStore.finalizeError).toBe("冲突");
		expect(learningStore.isFinalizing).toBe(false);
	});

	it("does not let a late finalization paint another session (C3)", async () => {
		learningStore.sessionId = "a.jsonl";
		learningStore.state = { exists: true, checkpoint: answeredCheckpoint(3, "attempt_a"), questions: [] };
		const pending = deferred<Awaited<ReturnType<typeof api.finalizeAttempt>>>();
		api.finalizeAttempt.mockReturnValue(pending.promise);

		const running = learningStore.finalizeAttempt();
		expect(learningStore.isFinalizing).toBe(true);

		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: answeredCheckpoint(7), questions: [] });
		await learningStore.load("b.jsonl");
		expect(learningStore.isFinalizing).toBe(false);

		pending.resolve({
			replayed: false,
			profile_version: 2,
			attempt: { attempt_id: "attempt_a", stage: "completed" },
			checkpoint: { revision: 4, status: "active", step: "feedback", updated_at: "t" },
		});
		await running;

		expect(learningStore.sessionId).toBe("b.jsonl");
		expect(learningStore.finalizeError).toBeNull();
	});
});
