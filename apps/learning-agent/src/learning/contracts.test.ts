import { describe, expect, it } from "vitest";
import { advanceCheckpointForAttempt, assertSameAttempt, captureHintSnapshot, learningRecoveryAction,
	parseAttemptSubmission, prepareLearningAttempt, publicQuestion, validateAssessmentCandidate } from "./contracts.js";
import type { LearningAttempt, LearningAttemptProgress, LearningCheckpoint, LearningExposure, LearningModelIdentity,
	LearningQuestion, ValidatedLearningAssessment } from "../memory/learner/types.js";

const now = new Date("2026-11-01T02:00:00Z");
const model: LearningModelIdentity = { provider_id: "fixture", model_id: "fixture-model", model_version: null, version_source: "unavailable" };
const question: LearningQuestion = {
	question_id: "function-calling", question_version: "1", concept_id: "agents.function-calling", goal_id: "goal-1",
	prompt: "函数调用中，谁执行工具，谁决定是否执行？", kind: "free_recall", rubric_version: "rubric-1",
	rubric: [{ criterion_id: "execution", description: "宿主执行工具", weight: 2 }, { criterion_id: "decision", description: "模型提出调用、宿主验证后决定执行", weight: 1 }],
	hints: ["区分模型输出和宿主动作。"], reference_answer: "模型提出调用；宿主验证参数与权限并执行工具。",
};
const checkpoint = (): LearningCheckpoint => ({ schema_version: 1, session_id: "session-1", revision: 4,
	goal_id: "goal-1", status: "active", step: "awaiting_answer", question: { question_id: question.question_id, question_version: "1" }, exposure_sequence: 0, updated_at: now.toISOString() });
const submission = () => ({ attempt_id: "attempt-1", expected_revision: 4, question_id: question.question_id, question_version: "1", answer: "  模型输出请求，宿主检查后执行。\n" });
const attempt = () => prepareLearningAttempt(checkpoint(), question, parseAttemptSubmission(submission()), [], now);
const candidate = () => ({ question_id: question.question_id, question_version: "1", result: "correct",
	feedback: "区分了模型请求和宿主执行。", criteria: [{ criterion_id: "decision", judgment: "met", explanation: "提到宿主检查。" }, { criterion_id: "execution", judgment: "met", explanation: "提到宿主执行。" }] });
const assessment = (): ValidatedLearningAssessment => validateAssessmentCandidate(candidate(), attempt(), model, now);
function projectedAttempt(): LearningAttempt {
	const item = attempt();
	item.progress = { stage: "profile_projected", assessment: assessment(), event: { event_id: "event-1", learner_id: "default", timestamp: now.toISOString(), event_type: "learning_evidence", context: {}, payload: {} }, profile_version: 5 };
	return item;
}

describe("trusted submission boundary", () => {
	it("preserves the exact answer and accepts a stale revision for an identical retry", () => {
		const input = parseAttemptSubmission(submission());
		expect(input.answer).toBe(submission().answer);
		expect(() => assertSameAttempt(attempt(), "session-1", { ...input, expected_revision: 999 })).not.toThrow();
	});
	it.each(["score", "result", "mastery", "hint_level", "answer_revealed", "model_version", "rubric_version", "assessment", "__proto__"])("rejects caller-controlled %s", field => {
		expect(() => parseAttemptSubmission({ ...submission(), [field]: 1 })).toThrow("Unexpected input fields");
	});
	it.each([null, [], {}, { ...submission(), answer: " \n" }, { ...submission(), answer: "x".repeat(20_001) },
		{ ...submission(), expected_revision: -1 }, { ...submission(), expected_revision: 1.5 }, { ...submission(), attempt_id: "../escape" }])("rejects malformed submissions %#", input => {
		expect(() => parseAttemptSubmission(input)).toThrow();
	});
	it.each([{ answer: "另一个回答" }, { question_id: "other" }, { question_version: "2" }, { attempt_id: "attempt-2" }])("does not overwrite the original attempt %#", change => {
		const saved = attempt(); const before = structuredClone(saved);
		expect(() => assertSameAttempt(saved, "session-1", { ...submission(), ...change })).toThrow("different submission");
		expect(saved).toEqual(before);
	});
	it("separates the attempt ID scope by session", () => {
		expect(() => assertSameAttempt(attempt(), "session-2", submission())).toThrow("different submission");
	});
	it.each([{ status: "paused" as const }, { pending_attempt_id: "another" }, { revision: 5 }, { step: "feedback" as const }, { question: { question_id: question.question_id, question_version: "2" } }])("requires a current active checkpoint for a new submission %#", change => {
		expect(() => prepareLearningAttempt({ ...checkpoint(), ...change }, question, submission(), [], now)).toThrow("reload before submitting");
	});
	it("does not expose private scoring or answer material with the question", () => {
		const visible = publicQuestion(question);
		expect(visible.prompt).toBe(question.prompt);
		for (const key of ["rubric", "rubric_version", "hints", "reference_answer"]) expect(visible).not.toHaveProperty(key);
	});
});

describe("server-ordered hint snapshots", () => {
	const history = (): LearningExposure[] => [
		{ question_id: question.question_id, question_version: "1", exposure_id: "hint-1", sequence: 1, kind: "hint", level: 1, occurred_at: now.toISOString() },
		{ question_id: question.question_id, question_version: "1", exposure_id: "answer-1", sequence: 2, kind: "answer", level: 3, occurred_at: now.toISOString() },
	];
	it("freezes the order at acceptance, excluding hints revealed after submission", () => {
		const events = history();
		const first = prepareLearningAttempt({ ...checkpoint(), exposure_sequence: 1 }, question, submission(), events, now);
		expect(first.hints).toEqual({ through_sequence: 1, exposure_ids: ["hint-1"], hint_level: 1, answer_revealed: false });
		events.push({ ...events[1], sequence: 3, exposure_id: "answer-2" });
		expect(first.hints.answer_revealed).toBe(false);
	});
	it("retains answer revelation even when the caller uses a new attempt ID", () => {
		const saved = prepareLearningAttempt({ ...checkpoint(), exposure_sequence: 2 }, question, { ...submission(), attempt_id: "attempt-new" }, history(), now);
		expect(saved.hints).toMatchObject({ hint_level: 3, answer_revealed: true, exposure_ids: ["hint-1", "answer-1"] });
	});
	it("does not import an unrelated question or a different version's exposure", () => {
		const unrelated = history().map(event => ({ ...event, question_version: "0" }));
		expect(captureHintSnapshot(question, unrelated, 2).hint_level).toBe(0);
	});
	it("rejects duplicate exposure sequence numbers instead of guessing the order", () => {
		const events = history(); events[1].sequence = 1;
		expect(() => captureHintSnapshot(question, events, 2)).toThrow("persisted exposure history");
	});
	it("copies the private question, so later edits cannot change the saved rubric", () => {
		const editable = structuredClone(question);
		const saved = prepareLearningAttempt(checkpoint(), editable, submission(), [], now);
		editable.rubric[0].description = "改题";
		expect(saved.question.rubric[0].description).toBe(question.rubric[0].description);
	});
});

describe("model assessment validation", () => {
	it("binds actual model identity and rubric version from trusted runtime data", () => {
		const result = assessment();
		expect(result).toMatchObject({ session_id: "session-1", attempt_id: "attempt-1", result: "correct", score: 1, rubric_version: "rubric-1", model });
		expect(result.criteria.map(item => item.criterion_id)).toEqual(["execution", "decision"]);
	});
	it("derives a partial score from weighted criterion judgments", () => {
		const input = candidate(); input.result = "partial"; input.criteria[0].judgment = "not_met";
		expect(validateAssessmentCandidate(input, attempt(), model, now).score).toBeCloseTo(2 / 3);
	});
	it("keeps unknown with a reason and without a numeric score", () => {
		const input = candidate(); input.result = "unknown"; input.criteria[0].judgment = "unknown";
		const result = validateAssessmentCandidate({ ...input, unknown_reason: "回答中的主体指代不清，无法判定。" }, attempt(), model, now);
		expect(result.result).toBe("unknown"); expect(result.score).toBeUndefined(); expect(result.unknown_reason).toBeTruthy();
	});
	it.each([
		() => ({ ...candidate(), score: 1 }), () => ({ ...candidate(), model_version: "invented" }),
		() => ({ ...candidate(), question_version: "2" }), () => ({ ...candidate(), criteria: candidate().criteria.slice(1) }),
		() => ({ ...candidate(), criteria: [candidate().criteria[0], candidate().criteria[0]] }),
		() => ({ ...candidate(), result: "incorrect" }), () => ({ ...candidate(), feedback: "" }),
		() => ({ ...candidate(), criteria: [{ criterion_id: "other", judgment: "met", explanation: "fiction" }, candidate().criteria[1]] }),
		() => ({ ...candidate(), criteria: candidate().criteria.map(item => ({ ...item, judgment: "unknown" })), result: "unknown" }),
	])("rejects invalid candidates as failures, never converts them into incorrect/unknown %#", make => {
		expect(() => validateAssessmentCandidate(make(), attempt(), model, now)).toThrow();
	});
	it("rejects corrupt rubric weights", () => {
		const saved = attempt(); saved.question.rubric[0].weight = Number.NaN;
		expect(() => validateAssessmentCandidate(candidate(), saved, model, now)).toThrow("Invalid saved rubric");
	});
});

describe("recovery and checkpoint guards", () => {
	it("reuses a running evaluation in the same process and recovers it after restart", () => {
		const saved = attempt(); saved.evaluation_attempts = 1;
		saved.progress = { stage: "evaluating", process_run_id: "old", evaluation_run_id: "run-1", model, started_at: now.toISOString() };
		expect(learningRecoveryAction(saved, "old", 3)).toBe("wait_for_running_evaluation");
		expect(learningRecoveryAction(saved, "new", 3)).toBe("evaluate");
		saved.evaluation_attempts = 3;
		expect(learningRecoveryAction(saved, "new", 3)).toBe("mark_retry_limit");
	});
	it("does not automatically retry a saved evaluation failure when merely refreshing", () => {
		const saved = attempt(); saved.progress = { stage: "evaluation_failed", failure: { code: "timeout", message: "评估超时，可重试。", failed_at: now.toISOString() } };
		expect(learningRecoveryAction(saved, "new", 3)).toBe("await_manual_retry");
	});
	it("resumes each durable stage without requesting another assessment", () => {
		const saved = projectedAttempt();
		const stages: [LearningAttemptProgress, string][] = [
			[{ stage: "evaluated", assessment: assessment() }, "publish_saved_evidence"],
			[{ ...saved.progress, stage: "evidence_recorded" } as LearningAttemptProgress, "project_saved_evidence"],
			[saved.progress, "advance_checkpoint"],
			[{ ...saved.progress, stage: "completed", checkpoint_advanced: true } as LearningAttemptProgress, "return_saved_result"],
		];
		for (const [progress, expected] of stages) expect(learningRecoveryAction({ ...saved, progress }, "new", 3)).toBe(expected);
	});
	it("does not let a late old attempt overwrite a newer question", () => {
		const current = { ...checkpoint(), pending_attempt_id: "new-attempt", question: { question_id: "new-question", question_version: "1" } };
		expect(advanceCheckpointForAttempt(current, projectedAttempt(), now)).toEqual({ checkpoint: current, advanced: false });
	});
	it("advances once, preserves pause status and does not count the same completion twice", () => {
		const paused = { ...checkpoint(), status: "paused" as const, pending_attempt_id: "attempt-1" };
		const first = advanceCheckpointForAttempt(paused, projectedAttempt(), now);
		expect(first).toMatchObject({ advanced: true, checkpoint: { status: "paused", step: "feedback", revision: 5, last_completed_attempt_id: "attempt-1" } });
		expect(advanceCheckpointForAttempt(first.checkpoint, projectedAttempt(), now)).toEqual({ checkpoint: first.checkpoint, advanced: false });
	});
	it("does not advance before the profile update is durable", () => {
		expect(() => advanceCheckpointForAttempt({ ...checkpoint(), pending_attempt_id: "attempt-1" }, attempt(), now)).toThrow("not been projected");
	});
});
