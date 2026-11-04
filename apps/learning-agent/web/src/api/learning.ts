import { apiFetch } from "./client.js";

/**
 * Typed wrapper for the B2 learning-checkpoint API.
 *
 * The server owns the checkpoint; this module only reads it and asks for the
 * explicit pause/resume/initialise transitions. Entering a page must never
 * re-initialise an existing record — only `initLearning` does that, and callers
 * invoke it from an explicit user action.
 */

export type LearningCheckpointStatus = "active" | "paused" | "completed";
export type LearningCheckpointStep = "conversation" | "awaiting_answer" | "feedback";

export interface LearningQuestionRef {
	question_id: string;
	question_version: string;
}

export interface LearningCheckpointView {
	revision: number;
	status: LearningCheckpointStatus;
	step: LearningCheckpointStep;
	updated_at: string;
	/** Identity of the question currently being answered; never its answer/rubric. */
	question?: LearningQuestionRef;
	/** How the current question was grounded. Type only, never the source text. */
	knowledge?: { kind: KnowledgeSourceKind };
	/** A saved answer awaiting evaluation, if any. */
	pending_attempt_id?: string;
	/** The last attempt successfully finalized into evidence. */
	last_completed_attempt_id?: string;
}

export interface PublicLearningQuestion {
	question_id: string;
	question_version: string;
	concept_id: string;
	goal_id?: string;
	prompt: string;
	kind: "free_recall" | "application" | "transfer";
	/**
	 * C4-C: the server saved this question from an explicit due-review request.
	 * Provenance only — it is not evidence and makes no claim about mastery.
	 */
	review?: true;
}

/** Mirrors the server's `LearningRecoveryAction`; naming only, never an execution. */
export type LearningRecoveryAction =
	| "evaluate"
	| "wait_for_running_evaluation"
	| "await_manual_retry"
	| "mark_retry_limit"
	| "publish_saved_evidence"
	| "project_saved_evidence"
	| "advance_checkpoint"
	| "return_saved_result";

export interface LearningState {
	exists: boolean;
	checkpoint?: LearningCheckpointView;
	questions?: PublicLearningQuestion[];
	pending_action?: LearningRecoveryAction;
	/** Minimal public attempt views (C2): the learner's answers and evaluation state. */
	attempts?: PublicAttemptView[];
}

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/learning`;

/** Read the public learning state. A missing record is `{ exists: false }`, not an error. */
export async function getLearningState(sessionId: string): Promise<LearningState> {
	return apiFetch<LearningState>(base(sessionId));
}

/** Idempotently create the record. Only call this from an explicit user action. */
export async function initLearning(sessionId: string, goalId?: string): Promise<LearningCheckpointView> {
	const body = await apiFetch<{ checkpoint: LearningCheckpointView }>(base(sessionId), {
		method: "POST",
		body: JSON.stringify(goalId ? { goalId } : {}),
	});
	return body.checkpoint;
}

async function transition(
	sessionId: string,
	action: "pause" | "resume",
	revision: number,
): Promise<LearningCheckpointView> {
	const body = await apiFetch<{ checkpoint: LearningCheckpointView }>(`${base(sessionId)}/${action}`, {
		method: "POST",
		body: JSON.stringify({ revision }),
	});
	return body.checkpoint;
}

export function pauseLearning(sessionId: string, revision: number): Promise<LearningCheckpointView> {
	return transition(sessionId, "pause", revision);
}

export function resumeLearning(sessionId: string, revision: number): Promise<LearningCheckpointView> {
	return transition(sessionId, "resume", revision);
}

/** Human-readable, non-leaking message for a learning API failure. */
export function describeLearningError(error: unknown): string {
	const status = (error as { status?: number } | undefined)?.status;
	switch (status) {
		case 404: return "该学习会话不存在或已被删除。";
		case 409: return "学习状态已被更新，请重新加载后再操作。";
		case 503: return "学习记录暂时不可写（可能由另一个进程持有写入权）。";
		case 422: return "学习记录已损坏，已停止写入；请联系维护者检查数据目录。";
		default: return error instanceof Error ? error.message : "学习状态读取失败。";
	}
}

/** How a generated question was grounded. Type only — never the source text. */
export type KnowledgeSourceKind = "l2_document" | "model_knowledge";

export interface GeneratedQuestion {
	created: boolean;
	question: PublicLearningQuestion;
	checkpoint: LearningCheckpointView;
	knowledge: { kind: KnowledgeSourceKind };
}

export interface GenerateQuestionInput {
	concept: string;
	/** Reuse an existing concept id when the learner picked a known knowledge state. */
	concept_id?: string;
	goal_id?: string;
	kind?: PublicLearningQuestion["kind"];
	/** Explicitly named document; the server resolves it against the manifest. */
	designated?: { by: "source_id" | "content_hash" | "source_identity"; value: string };
	allow_model_fallback: boolean;
	/** Client-generated retry identity: repeated failures reuse it. */
	request_id: string;
	expected_revision: number;
	/**
	 * C4: the completed attempt this question continues from.
	 *
	 * Required by the server once the checkpoint is at `feedback`; omitted for the
	 * first question of a session. It names the attempt, it does not prove it
	 * completed — the server re-checks the record.
	 */
	after_attempt_id?: string;
	/** C4-C: this generation is an explicit due-review request, not ordinary practice. */
	intent?: "review";
}

/** Generate one question. The server owns provenance, ids and the model identity. */
export async function generateLearningQuestion(
	sessionId: string,
	input: GenerateQuestionInput,
): Promise<GeneratedQuestion> {
	return apiFetch<GeneratedQuestion>(`${base(sessionId)}/questions/generate`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

/**
 * Message for a failed generation.
 *
 * Prefers the server's own explanation (it distinguishes "no knowledge source",
 * "retrieval unavailable", "invalid model output" …) and falls back to the
 * shared learning-error copy only when the body carries none.
 */
export function describeGenerationError(error: unknown): string {
	const data = (error as { data?: Record<string, unknown> } | undefined)?.data;
	const serverMessage = typeof data?.message === "string" ? data.message : "";
	if (serverMessage) return serverMessage;
	return describeLearningError(error);
}

/** The learner's answer submission for the current question. */
export interface AttemptSubmission {
	attempt_id: string;
	question_id: string;
	question_version: string;
	answer: string;
	expected_revision: number;
}

export interface SavedAttemptView {
	attempt_id: string;
	question_id: string;
	question_version: string;
	accepted_at: string;
}

/** A single rubric criterion judgment, as the server computed it. */
export interface PublicCriterionJudgment {
	criterion_id: string;
	judgment: "met" | "partially_met" | "not_met" | "unknown";
	explanation: string;
}

/** Public assessment: result + score + feedback, never the reference answer or rubric weights. */
export interface PublicAssessment {
	result: "correct" | "partial" | "incorrect" | "unknown";
	score?: number;
	feedback: string;
	unknown_reason?: string;
	criteria: PublicCriterionJudgment[];
}

/** Public view of one saved answer and its evaluation state (C2). */
export interface PublicAttemptView {
	attempt_id: string;
	question_id: string;
	question_version: string;
	/** The learner's own answer, verbatim. */
	answer: string;
	accepted_at: string;
	stage: "answer_saved" | "evaluating" | "evaluation_failed" | "evaluated" | "evidence_recorded" | "profile_projected" | "completed";
	assessment?: PublicAssessment;
	failure?: { code: string; message: string };
	retryable: boolean;
	evaluation_attempts: number;
}

/** Save the learner's answer for the current question. */
export async function submitAnswer(
	sessionId: string,
	input: AttemptSubmission,
): Promise<{ created: boolean; attempt: SavedAttemptView; checkpoint: LearningCheckpointView }> {
	return apiFetch<{ created: boolean; attempt: SavedAttemptView; checkpoint: LearningCheckpointView }>(
		`${base(sessionId)}/attempts`,
		{ method: "POST", body: JSON.stringify(input) },
	);
}

/** Evaluate a saved answer. `retry` re-scores a previously failed attempt. */
export async function evaluateAnswer(
	sessionId: string,
	attemptId: string,
	revision: number,
	options: { retry?: boolean } = {},
): Promise<{
	replayed: boolean;
	pending_action: string;
	assessment?: PublicAssessment;
	checkpoint: LearningCheckpointView;
}> {
	return apiFetch<{
		replayed: boolean;
		pending_action: string;
		assessment?: PublicAssessment;
		checkpoint: LearningCheckpointView;
	}>(`${base(sessionId)}/attempts/${encodeURIComponent(attemptId)}/evaluate`, {
		method: "POST",
		body: JSON.stringify({ revision, ...(options.retry ? { retry: true } : {}) }),
	});
}

export interface FinalizeAttemptResponse {
	replayed: boolean;
	profile_version: number;
	attempt: {
		attempt_id: string;
		stage: PublicAttemptView["stage"];
	};
	checkpoint: LearningCheckpointView;
}

/** Record evaluated learning result as L1 evidence and advance checkpoint (C3). */
export async function finalizeAttempt(
	sessionId: string,
	attemptId: string,
	revision: number,
): Promise<FinalizeAttemptResponse> {
	return apiFetch<FinalizeAttemptResponse>(
		`${base(sessionId)}/attempts/${encodeURIComponent(attemptId)}/finalize`,
		{
			method: "POST",
			body: JSON.stringify({ revision }),
		},
	);
}
