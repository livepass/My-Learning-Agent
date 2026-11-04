import type {
	LearningAttempt, LearningAttemptSubmission, LearningCheckpoint, LearningCriterionJudgment,
	LearningExposure, LearningHintSnapshot, LearningModelIdentity, LearningQuestion,
	LearningQuestionRef, LearningSessionRecord, PublicLearningQuestion, ValidatedLearningAssessment,
} from "../memory/learner/types.js";

/** Pure boundary rules only. Persistence and model calls belong to later S2 work. */
export class LearningContractError extends Error {
	constructor(public readonly code: "invalid_input" | "attempt_conflict" | "checkpoint_conflict" | "invalid_assessment", message: string) {
		super(message);
		this.name = "LearningContractError";
	}
}

function object(value: unknown, keys: readonly string[], code: "invalid_input" | "invalid_assessment"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Object.keys(value).some(key => !keys.includes(key))) throw new LearningContractError(code, "Unexpected input fields");
	return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number, code: "invalid_input" | "invalid_assessment"): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new LearningContractError(code, "Missing or oversized text");
	return value;
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new LearningContractError("invalid_input", "Invalid identifier");
	return value;
}

export function parseAttemptSubmission(value: unknown): LearningAttemptSubmission {
	const input = object(value, ["attempt_id", "question_id", "question_version", "expected_revision", "answer"], "invalid_input");
	if (!Number.isSafeInteger(input.expected_revision) || (input.expected_revision as number) < 0) throw new LearningContractError("invalid_input", "Invalid checkpoint revision");
	return {
		attempt_id: identifier(input.attempt_id), question_id: identifier(input.question_id),
		question_version: identifier(input.question_version), expected_revision: input.expected_revision as number,
		answer: text(input.answer, 20_000, "invalid_input"),
	};
}

export function sameQuestion(a: LearningQuestionRef | undefined, b: LearningQuestionRef): boolean {
	return a?.question_id === b.question_id && a.question_version === b.question_version;
}

/** Check duplicates before comparing current checkpoint revisions: old retries are legitimate. */
export function assertSameAttempt(existing: LearningAttempt, sessionId: string, input: LearningAttemptSubmission): void {
	if (existing.session_id !== sessionId || existing.attempt_id !== input.attempt_id
		|| !sameQuestion(existing, input) || existing.answer !== input.answer) {
		throw new LearningContractError("attempt_conflict", "Attempt ID already belongs to a different submission");
	}
}

export function publicQuestion(question: LearningQuestion): PublicLearningQuestion {
	return {
		question_id: question.question_id, question_version: question.question_version,
		concept_id: question.concept_id, goal_id: question.goal_id, prompt: question.prompt, kind: question.kind,
		// Provenance only; omitted for ordinary questions so the payload does not grow.
		...(question.generation?.review ? { review: true as const } : {}),
	};
}

/** Recompute for every new attempt from the session history, never from caller hint claims. */
export function captureHintSnapshot(question: LearningQuestionRef, history: readonly LearningExposure[], throughSequence: number): LearningHintSnapshot {
	if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) throw new LearningContractError("invalid_input", "Invalid exposure sequence");
	const exposures = history.filter(event => sameQuestion(event, question) && event.sequence <= throughSequence)
		.sort((a, b) => a.sequence - b.sequence);
	const ids = new Set<string>();
	const sequences = new Set<number>();
	let level: LearningHintSnapshot["hint_level"] = 0;
	for (const event of exposures) {
		if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || ids.has(event.exposure_id) || sequences.has(event.sequence)
			|| (event.kind === "answer" ? event.level !== 3 : event.level !== 1 && event.level !== 2)) {
			throw new LearningContractError("invalid_input", "Invalid persisted exposure history");
		}
		ids.add(event.exposure_id); sequences.add(event.sequence);
		level = Math.max(level, event.level) as LearningHintSnapshot["hint_level"];
	}
	return { through_sequence: throughSequence, exposure_ids: [...ids], hint_level: level, answer_revealed: level === 3 };
}

/** This draft is not accepted until the owner successfully persists it. */
export function prepareLearningAttempt(checkpoint: LearningCheckpoint, question: LearningQuestion, input: LearningAttemptSubmission,
	history: readonly LearningExposure[], now: Date): LearningAttempt {
	if (checkpoint.revision !== input.expected_revision || checkpoint.status !== "active" || checkpoint.step !== "awaiting_answer"
		|| checkpoint.pending_attempt_id || !sameQuestion(checkpoint.question, question) || !sameQuestion(question, input)) {
		throw new LearningContractError("checkpoint_conflict", "Learning session changed; reload before submitting");
	}
	return {
		session_id: checkpoint.session_id, attempt_id: input.attempt_id, question_id: question.question_id, question_version: question.question_version,
		answer: input.answer, accepted_at: now.toISOString(), accepted_revision: checkpoint.revision,
		question: structuredClone(question), hints: captureHintSnapshot(question, history, checkpoint.exposure_sequence),
		evaluation_attempts: 0, progress: { stage: "answer_saved" },
	};
}

/** Candidate echoes bind it to the saved question; model/provider versions come from trusted runtime data. */
export function validateAssessmentCandidate(value: unknown, attempt: LearningAttempt, model: LearningModelIdentity, now: Date): ValidatedLearningAssessment {
	const code = "invalid_assessment";
	const candidate = object(value, ["question_id", "question_version", "result", "feedback", "unknown_reason", "criteria"], code);
	if (!sameQuestion(candidate as unknown as LearningQuestionRef, attempt) || !Array.isArray(candidate.criteria)) throw new LearningContractError(code, "Assessment does not match the saved question");
	const rubric = attempt.question.rubric;
	if (!rubric.length || rubric.some(item => !item.criterion_id || !item.description.trim() || !Number.isFinite(item.weight) || item.weight <= 0)
		|| new Set(rubric.map(item => item.criterion_id)).size !== rubric.length) throw new LearningContractError(code, "Invalid saved rubric");
	const judgments: LearningCriterionJudgment[] = ["met", "partially_met", "not_met", "unknown"];
	const criteria = candidate.criteria.map(value => {
		const item = object(value, ["criterion_id", "judgment", "explanation"], code);
		if (!judgments.includes(item.judgment as LearningCriterionJudgment)) throw new LearningContractError(code, "Invalid criterion judgment");
		return { criterion_id: text(item.criterion_id, 128, code), judgment: item.judgment as LearningCriterionJudgment, explanation: text(item.explanation, 4_000, code) };
	});
	const byId = new Map(criteria.map(item => [item.criterion_id, item]));
	if (byId.size !== rubric.length || criteria.length !== rubric.length || rubric.some(item => !byId.has(item.criterion_id))) throw new LearningContractError(code, "Incomplete or duplicate rubric judgments");
	const ordered = rubric.map(item => byId.get(item.criterion_id)!);
	const result = ordered.some(item => item.judgment === "unknown") ? "unknown"
		: ordered.every(item => item.judgment === "met") ? "correct"
			: ordered.every(item => item.judgment === "not_met") ? "incorrect" : "partial";
	if (candidate.result !== result) throw new LearningContractError(code, "Result contradicts rubric judgments");
	const unknownReason = result === "unknown" ? text(candidate.unknown_reason, 4_000, code) : undefined;
	if (result !== "unknown" && candidate.unknown_reason !== undefined) throw new LearningContractError(code, "Unexpected unknown reason");
	const totalWeight = rubric.reduce((sum, item) => sum + item.weight, 0);
	if (!Number.isFinite(totalWeight)) throw new LearningContractError(code, "Invalid rubric weights");
	const score = result === "unknown" ? undefined : rubric.reduce((sum, item, index) => {
		const judgment = ordered[index].judgment;
		return sum + (item.weight / totalWeight) * (judgment === "met" ? 1 : judgment === "partially_met" ? 0.5 : 0);
	}, 0);
	return {
		session_id: attempt.session_id, attempt_id: attempt.attempt_id,
		question_id: attempt.question_id, question_version: attempt.question_version, rubric_version: attempt.question.rubric_version,
		model: structuredClone(model), hints: structuredClone(attempt.hints), result, score, feedback: text(candidate.feedback, 8_000, code),
		...(unknownReason ? { unknown_reason: unknownReason } : {}), criteria: ordered, assessed_at: now.toISOString(),
	};
}

export type LearningRecoveryAction = "evaluate" | "wait_for_running_evaluation" | "await_manual_retry" | "mark_retry_limit"
	| "publish_saved_evidence" | "project_saved_evidence" | "advance_checkpoint" | "return_saved_result";

export function learningRecoveryAction(attempt: LearningAttempt, processRunId: string, maxEvaluationAttempts: number): LearningRecoveryAction {
	if (!Number.isSafeInteger(maxEvaluationAttempts) || maxEvaluationAttempts < 1 || !Number.isSafeInteger(attempt.evaluation_attempts) || attempt.evaluation_attempts < 0) {
		throw new LearningContractError("invalid_input", "Invalid evaluation retry policy");
	}
	switch (attempt.progress.stage) {
		case "evaluating":
			if (attempt.progress.process_run_id === processRunId) return "wait_for_running_evaluation";
			// Process-local in-flight work cannot survive a restart. Preserve its consumed retry budget.
			return attempt.evaluation_attempts >= maxEvaluationAttempts ? "mark_retry_limit" : "evaluate";
		case "answer_saved": return attempt.evaluation_attempts >= maxEvaluationAttempts ? "mark_retry_limit" : "evaluate";
		case "evaluation_failed": return "await_manual_retry";
		case "evaluated": return "publish_saved_evidence";
		case "evidence_recorded": return "project_saved_evidence";
		case "profile_projected": return "advance_checkpoint";
		case "completed": return "return_saved_result";
	}
}

/** The projection must be durable before attempting this checkpoint transition. */
export function advanceCheckpointForAttempt(checkpoint: LearningCheckpoint, attempt: LearningAttempt, now: Date): { checkpoint: LearningCheckpoint; advanced: boolean } {
	if (attempt.progress.stage !== "profile_projected" && attempt.progress.stage !== "completed") throw new LearningContractError("checkpoint_conflict", "Evidence has not been projected");
	if (checkpoint.session_id !== attempt.session_id || !sameQuestion(checkpoint.question, attempt) || checkpoint.pending_attempt_id !== attempt.attempt_id
		|| checkpoint.status === "completed" || checkpoint.step !== "awaiting_answer") return { checkpoint, advanced: false };
	return {
		checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, pending_attempt_id: undefined,
			last_completed_attempt_id: attempt.attempt_id, step: "feedback", updated_at: now.toISOString() }, advanced: true,
	};
}

/** Why a generation request may not write the next question. */
export type NextQuestionRejection =
	| "not_active"
	| "pending_attempt"
	| "question_pending"
	| "no_previous_attempt"
	| "after_attempt_required"
	| "after_attempt_unexpected"
	| "after_attempt_mismatch"
	| "previous_attempt_missing"
	| "previous_attempt_incomplete"
	| "previous_question_mismatch";

export type NextQuestionDecision =
	| { ok: true; mode: "initial" | "continuation" }
	| { ok: false; reason: NextQuestionRejection };

/**
 * C4: decide whether a new question may be committed, and on what basis.
 *
 * Two legal shapes only:
 *
 * - `initial`: nothing has been asked yet (conversation, no question).
 * - `continuation`: the previous question reached `feedback` through the full
 *   C3 path, and the caller names that completed attempt.
 *
 * Everything else is refused, including "feedback but the attempt never
 * finished" — a question may never be generated on top of an unrecorded result.
 * The client-supplied `afterAttemptId` is *not* evidence: it is checked against
 * the checkpoint's `last_completed_attempt_id`, the attempt's stage and its
 * `checkpoint_advanced` flag. Pure: no clock, no IO.
 */
export function canCommitNextQuestion(
	record: Pick<LearningSessionRecord, "checkpoint" | "attempts">,
	options: { afterAttemptId?: string } = {},
): NextQuestionDecision {
	const checkpoint = record.checkpoint;
	if (checkpoint.status !== "active") return { ok: false, reason: "not_active" };
	if (checkpoint.pending_attempt_id) return { ok: false, reason: "pending_attempt" };

	if (checkpoint.step === "conversation") {
		// A question ref without `awaiting_answer` is an inconsistent record.
		if (checkpoint.question) return { ok: false, reason: "question_pending" };
		if (options.afterAttemptId) return { ok: false, reason: "after_attempt_unexpected" };
		return { ok: true, mode: "initial" };
	}
	if (checkpoint.step === "awaiting_answer") return { ok: false, reason: "question_pending" };

	// step === "feedback": the previous question is finished, but only the
	// attempt that actually completed it can open the next one.
	const previousQuestion = checkpoint.question;
	if (!previousQuestion) return { ok: false, reason: "previous_question_mismatch" };
	if (!options.afterAttemptId) return { ok: false, reason: "after_attempt_required" };
	if (!checkpoint.last_completed_attempt_id) return { ok: false, reason: "no_previous_attempt" };
	if (checkpoint.last_completed_attempt_id !== options.afterAttemptId) return { ok: false, reason: "after_attempt_mismatch" };

	const attempt = record.attempts.find((candidate) => candidate.attempt_id === options.afterAttemptId);
	if (!attempt) return { ok: false, reason: "previous_attempt_missing" };
	if (!sameQuestion(attempt, previousQuestion)) return { ok: false, reason: "previous_question_mismatch" };
	if (attempt.progress.stage !== "completed") return { ok: false, reason: "previous_attempt_incomplete" };
	if (attempt.progress.checkpoint_advanced !== true) return { ok: false, reason: "previous_attempt_incomplete" };
	return { ok: true, mode: "continuation" };
}

/** Stable operator-facing explanation for a refused generation. */
export function nextQuestionRejectionMessage(reason: NextQuestionRejection): string {
	switch (reason) {
		case "not_active": return "学习检查点不在进行中状态，不能出题。";
		case "pending_attempt": return "存在尚未完成的作答，不能出题。";
		case "question_pending": return "当前题目尚未完成，不能生成下一题。";
		case "no_previous_attempt": return "当前没有已完成的作答，不能继续出题。";
		case "after_attempt_required": return "继续出题需要指明上一题已完成的作答。";
		case "after_attempt_unexpected": return "当前没有已完成的题目，不能按继续出题提交。";
		case "after_attempt_mismatch": return "指定的上一题作答与当前检查点不一致，请重新加载。";
		case "previous_attempt_missing": return "上一题作答不存在，无法继续出题。";
		case "previous_attempt_incomplete": return "上一题尚未完成学习记录，不能继续出题。";
		case "previous_question_mismatch": return "上一题作答与当前题目不一致，请重新加载。";
	}
}
