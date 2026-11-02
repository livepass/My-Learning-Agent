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
}

export interface PublicLearningQuestion {
	question_id: string;
	question_version: string;
	concept_id: string;
	goal_id?: string;
	prompt: string;
	kind: "free_recall" | "application" | "transfer";
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
