import type { LearningSessionRecord } from "../memory/learner/types.js";

/**
 * E1.1 — authoritative edit guard for conversation branching.
 *
 * Editing a user turn drops every later message from the active branch. B2
 * (the session learning record) is the authority for whether that history still
 * backs an open or completed learning task, so the decision must be made from
 * the record itself — never from the client's earlier `GET /learning` snapshot.
 *
 * The policy is deliberately conservative: only a record that has never
 * published a question, exposed a hint/answer, or accepted an answer may be
 * branched. Anything else is refused with a specific, user-explainable code.
 * This function is pure: it never writes, repairs or projects anything.
 */

export type BranchEditRefusalCode =
	| "learning_evidence_locked"
	| "learning_attempt_pending"
	| "learning_task_pending";

export type BranchEditSafety =
	| { allowed: true }
	| { allowed: false; code: BranchEditRefusalCode; message: string };

/** Thrown from inside the branch's queue slot when B2 forbids the edit. */
export class BranchEditRefusedError extends Error {
	constructor(public readonly code: BranchEditRefusalCode, message: string) {
		super(message);
		this.name = "BranchEditRefusedError";
	}
}

const EVIDENCE_MESSAGE = "该会话已记录正式的学习证据。编辑历史会断开证据与对话的对应关系；本轮不会修改学习档案，已取消编辑。";
const ATTEMPT_MESSAGE = "该会话有已保存或正在评分的作答。请先完成评分并记录证据，再编辑历史消息。";
const TASK_MESSAGE = "该会话还有已发布或待完成的题目。请先完成当前学习任务，再编辑历史消息。";

function stageOf(attempt: LearningSessionRecord["attempts"][number]): string {
	const progress = (attempt as { progress?: { stage?: unknown } } | undefined)?.progress;
	return typeof progress?.stage === "string" ? progress.stage : "";
}

export function evaluateBranchEditSafety(record: LearningSessionRecord | undefined): BranchEditSafety {
	if (!record) return { allowed: true };
	const checkpoint = record.checkpoint;
	const attempts = Array.isArray(record.attempts) ? record.attempts : [];
	const questions = Array.isArray(record.questions) ? record.questions : [];
	const exposures = Array.isArray(record.exposures) ? record.exposures : [];

	// An accepted answer is either waiting for evaluation or already carries an
	// assessment; both are uninterruptible learning work for this history.
	if (checkpoint?.pending_attempt_id) {
		return { allowed: false, code: "learning_attempt_pending", message: ATTEMPT_MESSAGE };
	}
	if (attempts.length > 0) {
		const open = attempts.some((attempt) => stageOf(attempt) !== "completed");
		if (open) {
			return { allowed: false, code: "learning_attempt_pending", message: ATTEMPT_MESSAGE };
		}
		return { allowed: false, code: "learning_evidence_locked", message: EVIDENCE_MESSAGE };
	}
	if (checkpoint?.last_completed_attempt_id || checkpoint?.status === "completed") {
		return { allowed: false, code: "learning_evidence_locked", message: EVIDENCE_MESSAGE };
	}

	// A published question card (even unanswered or skipped) is bound to the
	// conversation the learner is editing. Hints/answers shown for it are also
	// conversation-scoped learning material.
	if (
		checkpoint?.step !== "conversation"
		|| checkpoint?.question
		|| questions.length > 0
		|| exposures.length > 0
	) {
		return { allowed: false, code: "learning_task_pending", message: TASK_MESSAGE };
	}

	return { allowed: true };
}
