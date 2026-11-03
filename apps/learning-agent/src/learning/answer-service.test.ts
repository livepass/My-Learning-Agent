import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetaStore } from "../shared/session-meta-store.js";
import { LearningRecordStore } from "./record-store.js";
import { evaluateAttempt, saveAnswer, type AnswerServiceDeps } from "./answer-service.js";
import type { ModelCompletion } from "../shared/model-completion.js";
import type { LearningModelIdentity, LearningQuestion } from "../memory/learner/types.js";

const MODEL: LearningModelIdentity = {
	provider_id: "fixture",
	model_id: "dummy",
	model_version: null,
	version_source: "unavailable",
};

const PROCESS_RUN_ID = "process-1";
const MAX_EVALUATION_ATTEMPTS = 3;

const QUESTION: LearningQuestion = {
	question_id: "q1",
	question_version: "1",
	concept_id: "concept_closure",
	prompt: "解释闭包为什么持有外层变量。",
	kind: "free_recall",
	rubric_version: "c1-v1",
	rubric: [
		{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 },
		{ criterion_id: "c2", description: "说明生命周期被延长", weight: 1 },
	],
	hints: ["先想想变量存在哪里"],
	reference_answer: "闭包捕获变量绑定，不是值的副本。",
};

const validAssessmentReply = {
	result: "correct",
	feedback: "完整且准确。",
	criteria: [
		{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" },
		{ criterion_id: "c2", judgment: "met", explanation: "提到生命周期" },
	],
};

let dir: string;
let meta: SessionMetaStore;
let store: LearningRecordStore;
let sessionAlive: boolean;

function deps(overrides: Partial<AnswerServiceDeps> = {}): AnswerServiceDeps {
	return {
		learningRecordStore: store,
		complete: async () => ({ status: "ok", text: JSON.stringify(validAssessmentReply), model: MODEL }),
		processRunId: PROCESS_RUN_ID,
		maxEvaluationAttempts: MAX_EVALUATION_ATTEMPTS,
		sessionExists: () => sessionAlive,
		now: () => new Date("2026-11-03T00:00:00.000Z"),
		...overrides,
	};
}

async function seedQuestion(): Promise<void> {
	// Seed a record with a committed question at awaiting_answer.
	await store.create("s1.jsonl");
	await store.commitQuestion("s1.jsonl", {
		requestId: "req_1",
		fingerprint: "fp",
		expectedRevision: 1,
		question: QUESTION,
		sessionExists: () => sessionAlive,
	});
}

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		attempt_id: "attempt_1",
		question_id: "q1",
		question_version: "1",
		expected_revision: 2,
		answer: "闭包捕获变量绑定，所以外层变量仍可达。",
		...overrides,
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-c2-"));
	sessionAlive = true;
	meta = new SessionMetaStore({ dataDir: dir });
	store = new LearningRecordStore({ dataDir: dir, metaStore: meta, now: () => new Date("2026-11-03T00:00:00.000Z") });
});

afterEach(async () => {
	await store.close();
	await meta.close();
	await rm(dir, { recursive: true, force: true });
});

async function rawRecord(sessionId = "s1.jsonl"): Promise<string> {
	return readFile(join(dir, "learning", `${sessionId}.json`), "utf-8");
}

describe("save answer", () => {
	it("saves the answer and marks the attempt pending", async () => {
		await seedQuestion();
		const result = await saveAnswer(deps(), "s1.jsonl", submission());
		if (!result.ok) throw new Error(`saveAnswer failed: ${JSON.stringify(result)}`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.created).toBe(true);
		expect(result.attempt.progress.stage).toBe("answer_saved");
		expect(result.record.checkpoint.pending_attempt_id).toBe("attempt_1");
		expect(result.record.checkpoint.revision).toBe(3);
		// The answer is stored verbatim, immutable.
		expect(result.attempt.answer).toBe("闭包捕获变量绑定，所以外层变量仍可达。");
	});

	it("replays an identical submission without a second write", async () => {
		await seedQuestion();
		const first = await saveAnswer(deps(), "s1.jsonl", submission());
		if (!first.ok) throw new Error("expected success");
		const before = await rawRecord();

		const retry = await saveAnswer(deps(), "s1.jsonl", submission());
		expect(retry.ok).toBe(true);
		if (!retry.ok) return;
		expect(retry.created).toBe(false);
		expect(retry.attempt.attempt_id).toBe(first.attempt.attempt_id);
		expect(await rawRecord()).toBe(before);
	});

	it("rejects the same attempt id with a different answer", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const conflict = await saveAnswer(deps(), "s1.jsonl", submission({ answer: "完全不同的回答" }));
		expect(conflict.ok).toBe(false);
		if (conflict.ok) return;
		expect(conflict.status).toBe(409);
	});

	it("rejects a submission when no question is pending", async () => {
		await store.create("s1.jsonl");
		const result = await saveAnswer(deps(), "s1.jsonl", submission());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(409);
	});

	it("rejects a malformed submission as a bad request", async () => {
		await seedQuestion();
		const result = await saveAnswer(deps(), "s1.jsonl", { ...submission(), answer: "  " });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(400);
	});
});

describe("evaluate answer", () => {
	it("scores a saved answer and persists the assessment", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const result = await evaluateAttempt(deps(), "s1.jsonl", "attempt_1", 3);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.replayed).toBe(false);
		expect(result.assessment?.result).toBe("correct");
		expect(result.assessment?.score).toBe(1);
		expect(result.assessment?.feedback).toBe("完整且准确。");

		const record = (await store.get("s1.jsonl"))!;
		const attempt = record.attempts[0];
		expect(attempt.progress.stage).toBe("evaluated");
		expect(attempt.evaluation_attempts).toBe(1);
		// The checkpoint is not advanced past awaiting_answer (that is C3).
		expect(record.checkpoint.step).toBe("awaiting_answer");
	});

	it("records a timeout as a retryable failure without scoring", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const complete: ModelCompletion = async () => ({ status: "timeout" });
		const result = await evaluateAttempt(deps({ complete }), "s1.jsonl", "attempt_1", 3);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("model_timeout");

		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].progress.stage).toBe("evaluation_failed");
	});

	it("records an invalid model reply as an invalid assessment", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const complete: ModelCompletion = async () => ({ status: "ok", text: "{\"result\":\"genius\"}", model: MODEL });
		const result = await evaluateAttempt(deps({ complete }), "s1.jsonl", "attempt_1", 3);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("invalid_assessment");

		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].progress.stage).toBe("evaluation_failed");
	});

	it("replays without a model call when the evaluation is already running in this process", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		// Manually move the attempt to "evaluating" under the same process.
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating",
				process_run_id: PROCESS_RUN_ID,
				evaluation_run_id: "run-1",
				model: MODEL,
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		const complete = vi.fn<ModelCompletion>();
		const result = await evaluateAttempt(deps({ complete }), "s1.jsonl", "attempt_1", 4);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.replayed).toBe(true);
		expect(result.pendingAction).toBe("wait_for_running_evaluation");
		expect(complete).not.toHaveBeenCalled();
	});

	it("re-evaluates a dead process's running evaluation", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating",
				process_run_id: "other-process",
				evaluation_run_id: "run-1",
				model: MODEL,
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		const result = await evaluateAttempt(deps(), "s1.jsonl", "attempt_1", 4);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.replayed).toBe(false);
		expect(result.assessment?.result).toBe("correct");
		// The retry consumed the budget: 1 (begin) + 1 (this call).
		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(2);
	});

	it("does not auto-retry a saved failure when merely asked to evaluate", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating",
				process_run_id: PROCESS_RUN_ID,
				evaluation_run_id: "run-1",
				model: MODEL,
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		await store.failEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4,
			evaluationRunId: "run-1",
			progress: {
				stage: "evaluation_failed",
				failure: { code: "timeout", message: "评估超时", failed_at: "2026-11-03T00:00:00.000Z" },
			},
		});
		const result = await evaluateAttempt(deps(), "s1.jsonl", "attempt_1", 5);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.replayed).toBe(true);
		expect(result.pendingAction).toBe("await_manual_retry");
	});

	it("enforces the retry budget", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		// Exhaust the budget by moving the attempt through 3 evaluations.
		for (let i = 0; i < MAX_EVALUATION_ATTEMPTS; i++) {
			await store.beginEvaluation("s1.jsonl", "attempt_1", {
				expectedRevision: 3 + i,
				progress: {
					stage: "evaluating",
					process_run_id: "other",
					evaluation_run_id: `run-${i}`,
					model: MODEL,
					started_at: "2026-11-03T00:00:00.000Z",
				},
			});
		}
		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(MAX_EVALUATION_ATTEMPTS);

		const result = await evaluateAttempt(deps(), "s1.jsonl", "attempt_1", 6);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("retry_limit");
	});
});

describe("failure and races", () => {
	it("leaves the record untouched when submission validation fails", async () => {
		await seedQuestion();
		const before = await rawRecord();
		const result = await saveAnswer(deps(), "s1.jsonl", { ...submission(), expected_revision: 999 });
		expect(result.ok).toBe(false);
		expect(await rawRecord()).toBe(before);
	});

	it("refuses to commit when the session is deleted mid-submission", async () => {
		await seedQuestion();
		sessionAlive = false;
		const result = await saveAnswer(deps(), "s1.jsonl", submission());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});
});

describe("P1-2 explicit re-scoring", () => {
	it("does not auto-retry a saved failure on a plain evaluate", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating", process_run_id: PROCESS_RUN_ID, evaluation_run_id: "run-1",
				model: MODEL, started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		await store.failEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4, evaluationRunId: "run-1",
			progress: { stage: "evaluation_failed", failure: { code: "timeout", message: "评估超时", failed_at: "2026-11-03T00:00:00.000Z" } },
		});
		const complete = vi.fn<ModelCompletion>();
		const result = await evaluateAttempt(deps({ complete }), "s1.jsonl", "attempt_1", 5);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.replayed).toBe(true);
		expect(result.pendingAction).toBe("await_manual_retry");
		expect(complete).not.toHaveBeenCalled();
	});

	it("re-scores on an explicit retry without changing the answer or creating a new attempt", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const originalAnswer = "闭包捕获变量绑定，所以外层变量仍可达。";
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating", process_run_id: PROCESS_RUN_ID, evaluation_run_id: "run-1",
				model: MODEL, started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		await store.failEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4, evaluationRunId: "run-1",
			progress: { stage: "evaluation_failed", failure: { code: "timeout", message: "评估超时", failed_at: "2026-11-03T00:00:00.000Z" } },
		});

		const result = await evaluateAttempt(deps(), "s1.jsonl", "attempt_1", 5, { retry: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.replayed).toBe(false);
		expect(result.assessment?.result).toBe("correct");

		const record = (await store.get("s1.jsonl"))!;
		// Still exactly one attempt, same answer, now evaluated.
		expect(record.attempts).toHaveLength(1);
		expect(record.attempts[0].answer).toBe(originalAnswer);
		expect(record.attempts[0].progress.stage).toBe("evaluated");
		// The retry consumed one more budget entry (1 begin + 1 retry = 2).
		expect(record.attempts[0].evaluation_attempts).toBe(2);
	});

	it("a retry past the budget is refused", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		// Exhaust the budget.
		for (let i = 0; i < MAX_EVALUATION_ATTEMPTS; i++) {
			await store.beginEvaluation("s1.jsonl", "attempt_1", {
				expectedRevision: 3 + i,
				progress: { stage: "evaluating", process_run_id: "other", evaluation_run_id: `run-${i}`, model: MODEL, started_at: "2026-11-03T00:00:00.000Z" },
			});
		}
		await store.failEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 6, evaluationRunId: `run-${MAX_EVALUATION_ATTEMPTS - 1}`,
			progress: { stage: "evaluation_failed", failure: { code: "timeout", message: "超时", failed_at: "2026-11-03T00:00:00.000Z" } },
		});
		const result = await evaluateAttempt(deps(), "s1.jsonl", "attempt_1", 7, { retry: true });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("retry_limit");
	});
});

describe("P1-3 not-ready does not consume the retry budget", () => {
	it("returns model_not_ready without starting an evaluation", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const complete = vi.fn<ModelCompletion>();
		const result = await evaluateAttempt(
			deps({ checkModelReady: async () => false, complete }),
			"s1.jsonl", "attempt_1", 3,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("model_not_ready");
		expect(complete).not.toHaveBeenCalled();

		// The budget is intact and the attempt is still answer_saved.
		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(0);
		expect(record.attempts[0].progress.stage).toBe("answer_saved");
	});

	it("a real failure still consumes a retry (contrast case)", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const result = await evaluateAttempt(
			deps({ checkModelReady: async () => true, complete: async () => ({ status: "timeout" }) }),
			"s1.jsonl", "attempt_1", 3,
		);
		expect(result.ok).toBe(false);
		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(1);
		expect(record.attempts[0].progress.stage).toBe("evaluation_failed");
	});

	it("keeps retry attempts unchanged when pre-check is ready but actual model returns not_ready", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());

		const complete: ModelCompletion = vi.fn(async () => ({
			status: "not_ready" as const,
			reason: "no_credentials" as const,
		}));

		const result = await evaluateAttempt(
			deps({ checkModelReady: async () => true, complete }),
			"s1.jsonl", "attempt_1", 3,
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("model_not_ready");
		expect(complete).toHaveBeenCalledTimes(1);

		// Compensating write must keep retry budget unchanged and not leave it stuck in evaluating
		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(0);
		expect(record.attempts[0].progress.stage).toBe("answer_saved");

		// A subsequent evaluation when model becomes available proceeds cleanly
		const retryResult = await evaluateAttempt(
			deps({ checkModelReady: async () => true }),
			"s1.jsonl", "attempt_1", record.checkpoint.revision,
		);
		expect(retryResult.ok).toBe(true);
		const afterRetry = (await store.get("s1.jsonl"))!;
		expect(afterRetry.attempts[0].evaluation_attempts).toBe(1);
		expect(afterRetry.attempts[0].progress.stage).toBe("evaluated");
	});

	it("keeps retry attempts unchanged when an explicit re-score encounters not_ready race", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());

		// 1. Initial attempt fails with timeout (consumes 1 retry attempt)
		await evaluateAttempt(
			deps({ checkModelReady: async () => true, complete: async () => ({ status: "timeout" }) }),
			"s1.jsonl", "attempt_1", 3,
		);
		let record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(1);
		expect(record.attempts[0].progress.stage).toBe("evaluation_failed");

		// 2. User explicitly retries, pre-check says ready, but complete returns not_ready
		const result = await evaluateAttempt(
			deps({
				checkModelReady: async () => true,
				complete: async () => ({ status: "not_ready", reason: "no_credentials" }),
			}),
			"s1.jsonl", "attempt_1", record.checkpoint.revision, { retry: true },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("model_not_ready");

		// Retry count must stay at 1 (not consumed to 2!), stage restored to evaluation_failed
		record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(1);
		expect(record.attempts[0].progress.stage).toBe("evaluation_failed");
	});
});

describe("P1-4 pause during evaluation does not strand the attempt", () => {
	it("completes a score that finished while the checkpoint was paused", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());

		// Begin the evaluation, then pause the checkpoint mid-flight (the model
		// call is gated so it resolves only after the pause lands).
		const gate = deferred<void>();
		const complete: ModelCompletion = async () => {
			await gate.promise;
			return { status: "ok", text: JSON.stringify(validAssessmentReply), model: MODEL };
		};
		const running = evaluateAttempt(deps({ complete }), "s1.jsonl", "attempt_1", 3);

		// Wait until the attempt is durably "evaluating", then pause.
		await vi.waitFor(async () => {
			expect((await store.get("s1.jsonl"))!.attempts[0].progress.stage).toBe("evaluating");
		});
		await store.pause("s1.jsonl", 4);
		gate.resolve();

		const result = await running;
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.assessment?.result).toBe("correct");

		// The attempt is evaluated, the checkpoint stays paused, and it can never
		// be mistaken for a still-running same-process evaluation.
		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].progress.stage).toBe("evaluated");
		expect(record.checkpoint.status).toBe("paused");

		// A follow-up evaluate resolves to "publish_saved_evidence" (already
		// evaluated), never "wait_for_running_evaluation".
		const followUp = await evaluateAttempt(deps(), "s1.jsonl", "attempt_1", record.checkpoint.revision);
		expect(followUp.ok).toBe(true);
		if (!followUp.ok) return;
		expect(followUp.pendingAction).toBe("publish_saved_evidence");
	});
});

describe("P1-1 public attempt view", () => {
	it("exposes the answer, stage and failure with retryability, never private material", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: { stage: "evaluating", process_run_id: PROCESS_RUN_ID, evaluation_run_id: "run-1", model: MODEL, started_at: "2026-11-03T00:00:00.000Z" },
		});
		await store.failEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4, evaluationRunId: "run-1",
			progress: { stage: "evaluation_failed", failure: { code: "timeout", message: "评估超时", failed_at: "2026-11-03T00:00:00.000Z" } },
		});

		const state = await store.recoverState("s1.jsonl", { processRunId: PROCESS_RUN_ID, maxEvaluationAttempts: MAX_EVALUATION_ATTEMPTS });
		expect(state?.attempts).toHaveLength(1);
		const view = state!.attempts![0];
		expect(view.answer).toBe("闭包捕获变量绑定，所以外层变量仍可达。");
		expect(view.stage).toBe("evaluation_failed");
		expect(view.failure?.code).toBe("timeout");
		expect(view.retryable).toBe(true);

		const serialized = JSON.stringify(state);
		// No reference answer, rubric weights or model reply.
		expect(serialized).not.toContain("闭包捕获变量绑定，不是值的副本");
		expect(serialized).not.toContain("weight");
	});

	it("exposes unknown_reason on an evaluated assessment", async () => {
		await seedQuestion();
		await saveAnswer(deps(), "s1.jsonl", submission());
		const unknownReply = {
			result: "unknown",
			feedback: "无法判定。",
			unknown_reason: "回答主体指代不清。",
			criteria: [
				{ criterion_id: "c1", judgment: "unknown", explanation: "无法判断" },
				{ criterion_id: "c2", judgment: "unknown", explanation: "无法判断" },
			],
		};
		const result = await evaluateAttempt(
			deps({ complete: async () => ({ status: "ok", text: JSON.stringify(unknownReply), model: MODEL }) }),
			"s1.jsonl", "attempt_1", 3,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.assessment?.unknown_reason).toBe("回答主体指代不清。");
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}
