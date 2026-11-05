import { describe, expect, it } from "vitest";
import { evaluateBranchEditSafety } from "./branch-edit-guard.js";
import type { LearningAttempt, LearningSessionRecord } from "../memory/learner/types.js";

/**
 * E1.1: the server decides from B2, not from the client's snapshot. The matrix
 * below pins the conservative policy: anything that already published a
 * question, exposed material or accepted an answer blocks the branch.
 */

function record(overrides: {
	checkpoint?: Partial<LearningSessionRecord["checkpoint"]>;
	questions?: unknown[];
	exposures?: unknown[];
	attempts?: LearningAttempt[];
} = {}): LearningSessionRecord {
	return {
		schema_version: 1,
		checkpoint: {
			schema_version: 1,
			session_id: "s1",
			revision: 1,
			status: "active",
			step: "conversation",
			exposure_sequence: 0,
			updated_at: "2026-11-05T00:00:00.000Z",
			...overrides.checkpoint,
		},
		questions: (overrides.questions ?? []) as unknown as LearningSessionRecord["questions"],
		exposures: (overrides.exposures ?? []) as unknown as LearningSessionRecord["exposures"],
		attempts: overrides.attempts ?? [],
	};
}

function attempt(stage: string, id = "att-1"): LearningAttempt {
	return {
		session_id: "s1",
		attempt_id: id,
		question_id: "q1",
		question_version: "1",
		answer: "作答",
		accepted_at: "2026-11-05T00:00:00.000Z",
		accepted_revision: 1,
		question: {} as LearningAttempt["question"],
		hints: {} as LearningAttempt["hints"],
		evaluation_attempts: 0,
		progress: { stage } as LearningAttempt["progress"],
	};
}

describe("evaluateBranchEditSafety", () => {
	it("allows a session with no B2 record", () => {
		expect(evaluateBranchEditSafety(undefined)).toEqual({ allowed: true });
	});

	it("allows a pristine record (no question, exposure or attempt)", () => {
		expect(evaluateBranchEditSafety(record())).toEqual({ allowed: true });
	});

	it("refuses once an answer was accepted, even before evaluation", () => {
		const verdict = evaluateBranchEditSafety(record({
			checkpoint: { step: "awaiting_answer", pending_attempt_id: "att-1" },
			attempts: [attempt("answer_saved")],
		}));
		expect(verdict).toMatchObject({ allowed: false, code: "learning_attempt_pending" });
	});

	it("refuses while an evaluation or C3 finalize is still running", () => {
		for (const stage of ["evaluating", "evaluation_failed", "evaluated", "evidence_recorded", "profile_projected"]) {
			expect(evaluateBranchEditSafety(record({
				checkpoint: { step: "feedback" },
				attempts: [attempt(stage)],
			}))).toMatchObject({ allowed: false, code: "learning_attempt_pending" });
		}
	});

	it("refuses once evidence is formally recorded", () => {
		expect(evaluateBranchEditSafety(record({
			checkpoint: { step: "feedback", last_completed_attempt_id: "att-1" },
			attempts: [attempt("completed")],
		}))).toMatchObject({ allowed: false, code: "learning_evidence_locked" });

		// A completed checkpoint without a surviving attempt still means evidence.
		expect(evaluateBranchEditSafety(record({
			checkpoint: { status: "completed" },
		}))).toMatchObject({ allowed: false, code: "learning_evidence_locked" });
	});

	it("refuses a published question card that is waiting for an answer", () => {
		expect(evaluateBranchEditSafety(record({
			checkpoint: { step: "awaiting_answer" },
		}))).toMatchObject({ allowed: false, code: "learning_task_pending" });

		expect(evaluateBranchEditSafety(record({
			checkpoint: { step: "awaiting_answer", question: { question_id: "q1", question_version: "1" } },
			questions: [{ question_id: "q1", question_version: "1" }],
		}))).toMatchObject({ allowed: false, code: "learning_task_pending" });
	});

	it("refuses a skipped question and a recorded hint exposure", () => {
		expect(evaluateBranchEditSafety(record({
			questions: [{ question_id: "q1", question_version: "1" }],
		}))).toMatchObject({ allowed: false, code: "learning_task_pending" });

		expect(evaluateBranchEditSafety(record({
			exposures: [{ exposure_id: "e1" }],
		}))).toMatchObject({ allowed: false, code: "learning_task_pending" });
	});

	it("refuses when the checkpoint references an attempt that is not saved", () => {
		// Defensive: a corrupt-but-readable record must not be treated as safe.
		expect(evaluateBranchEditSafety(record({
			checkpoint: { pending_attempt_id: "ghost" },
		}))).toMatchObject({ allowed: false, code: "learning_attempt_pending" });
	});
});
