import { describe, expect, it } from "vitest";
import { buildEvidenceFromAssessment, RUBRIC_EVALUATION_CONFIDENCE } from "./evidence-adapter.js";
import { assertConsistentAttemptIdentity, dedupeContentDigest, dedupeFingerprint } from "../memory/learner/dedupe-index.js";
import { LearningContractError } from "./contracts.js";
import type {
	LearningAttempt,
	LearningHintSnapshot,
	LearningModelIdentity,
	LearningQuestion,
	ValidatedLearningAssessment,
} from "../memory/learner/types.js";

const MODEL_IDENTITY: LearningModelIdentity = {
	provider_id: "test_provider",
	model_id: "test_model",
	model_version: "2026.1",
	version_source: "provider_reported",
};

function sampleQuestion(kind: "free_recall" | "application" | "transfer" = "application"): LearningQuestion {
	return {
		question_id: "q_algo_1",
		question_version: "v1",
		concept_id: "cs.algorithms.binary_search",
		prompt: "解释二分查找的前提条件",
		kind,
		rubric_version: "r_v1",
		rubric: [{ criterion_id: "sorted", description: "数组有序", weight: 1 }],
		hints: ["提示1", "提示2"],
		reference_answer: "私有参考答案：必须是有序数组",
	};
}

function sampleAssessment(overrides: Partial<ValidatedLearningAssessment> = {}): ValidatedLearningAssessment {
	return {
		session_id: "sess_101",
		attempt_id: "att_202",
		question_id: "q_algo_1",
		question_version: "v1",
		rubric_version: "r_v1",
		model: MODEL_IDENTITY,
		hints: { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
		result: "correct",
		score: 1.0,
		feedback: "回答非常准确，指出了有序性的要求。",
		criteria: [{ criterion_id: "sorted", judgment: "met", explanation: "明确指出了有序前提" }],
		assessed_at: "2026-11-03T12:00:00.000Z",
		...overrides,
	};
}

function sampleAttempt(
	assessment: ValidatedLearningAssessment = sampleAssessment(),
	hints: LearningHintSnapshot = { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
	question: LearningQuestion = sampleQuestion(),
): LearningAttempt {
	return {
		session_id: "sess_101",
		attempt_id: "att_202",
		question_id: question.question_id,
		question_version: question.question_version,
		answer: "二分查找要求数组元素必须是有序排列的。",
		accepted_at: "2026-11-03T11:59:00.000Z",
		accepted_revision: 3,
		question,
		hints,
		evaluation_attempts: 1,
		progress: {
			stage: "evaluated",
			assessment,
		},
	};
}

describe("evidence-adapter", () => {
	it("rejects invalid learner ID or un-evaluated attempts", () => {
		const attempt = sampleAttempt();
		expect(() => buildEvidenceFromAssessment(attempt, "")).toThrow(LearningContractError);
		expect(() => buildEvidenceFromAssessment(attempt, "   ")).toThrow(LearningContractError);

		const unevaluated: LearningAttempt = {
			...attempt,
			progress: { stage: "answer_saved" },
		};
		expect(() => buildEvidenceFromAssessment(unevaluated, "learner_1")).toThrow(LearningContractError);

		const failed: LearningAttempt = {
			...attempt,
			progress: { stage: "evaluation_failed", failure: { code: "timeout", message: "timed out", failed_at: "2026-11-03T12:00:00Z" } },
		};
		expect(() => buildEvidenceFromAssessment(failed, "learner_1")).toThrow(LearningContractError);
	});

	it("maps kind without hints to question.kind", () => {
		for (const qKind of ["free_recall", "application", "transfer"] as const) {
			const attempt = sampleAttempt(sampleAssessment(), { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false }, sampleQuestion(qKind));
			const event = buildEvidenceFromAssessment(attempt, "learner_1");
			expect(event.evidence?.kind).toBe(qKind);
			expect(event.evidence?.hint_level).toBe(0);
		}
	});

	it("maps kind with hints to guided_recall and answer_revealed to exposure", () => {
		// Hint level 1 -> guided_recall
		const attemptWithHint = sampleAttempt(
			sampleAssessment(),
			{ through_sequence: 1, exposure_ids: ["exp_1"], hint_level: 1, answer_revealed: false },
			sampleQuestion("transfer"),
		);
		const eventWithHint = buildEvidenceFromAssessment(attemptWithHint, "learner_1");
		expect(eventWithHint.evidence?.kind).toBe("guided_recall");
		expect(eventWithHint.evidence?.hint_level).toBe(1);

		// Answer revealed -> exposure
		const attemptRevealed = sampleAttempt(
			sampleAssessment(),
			{ through_sequence: 2, exposure_ids: ["exp_1", "exp_2"], hint_level: 3, answer_revealed: true },
			sampleQuestion("free_recall"),
		);
		const eventRevealed = buildEvidenceFromAssessment(attemptRevealed, "learner_1");
		expect(eventRevealed.evidence?.kind).toBe("exposure");
		expect(eventRevealed.evidence?.hint_level).toBe(3);
	});

	it("preserves valid scores for correct and partial, but clears score for unknown", () => {
		// Correct
		const correctAttempt = sampleAttempt(sampleAssessment({ result: "correct", score: 0.95 }));
		const correctEvent = buildEvidenceFromAssessment(correctAttempt, "learner_1");
		expect(correctEvent.evidence?.result).toBe("correct");
		expect(correctEvent.evidence?.score).toBe(0.95);

		// Partial
		const partialAttempt = sampleAttempt(sampleAssessment({ result: "partial", score: 0.5 }));
		const partialEvent = buildEvidenceFromAssessment(partialAttempt, "learner_1");
		expect(partialEvent.evidence?.result).toBe("partial");
		expect(partialEvent.evidence?.score).toBe(0.5);

		// Unknown: score must be undefined
		const unknownAttempt = sampleAttempt(sampleAssessment({
			result: "unknown",
			score: 0,
			unknown_reason: "答案文字过短无法判定",
		}));
		const unknownEvent = buildEvidenceFromAssessment(unknownAttempt, "learner_1");
		expect(unknownEvent.evidence?.result).toBe("unknown");
		expect(unknownEvent.evidence?.score).toBeUndefined();
	});

	it("populates formal learning_attempt provenance and passes dedupe consistency checks", () => {
		const attempt = sampleAttempt();
		const event = buildEvidenceFromAssessment(attempt, "learner_1");

		expect(event.event_type).toBe("learning_evidence");
		expect(event.learner_id).toBe("learner_1");
		expect(event.evidence?.concept_id).toBe("cs.algorithms.binary_search");
		expect(event.evidence?.evaluator).toBe("rubric");
		expect(event.evidence?.evaluator_confidence).toBe(RUBRIC_EVALUATION_CONFIDENCE);

		const prov = event.evidence?.learning_attempt;
		expect(prov).toBeDefined();
		expect(prov?.session_id).toBe("sess_101");
		expect(prov?.attempt_id).toBe("att_202");
		expect(prov?.question_id).toBe("q_algo_1");
		expect(prov?.question_version).toBe("v1");
		expect(prov?.rubric_version).toBe("r_v1");
		expect(prov?.model).toEqual(MODEL_IDENTITY);

		// Verifies that assertConsistentAttemptIdentity does not throw
		expect(() => assertConsistentAttemptIdentity(event)).not.toThrow();

		// Verifies formal dedupe fingerprint
		const fingerprint = dedupeFingerprint(event);
		expect(fingerprint).toBe("formal\u0000learner_1\u0000sess_101\u0000att_202");
	});

	it("enforces metadata privacy and omits fabricated fields", () => {
		const attempt = sampleAttempt();
		const event = buildEvidenceFromAssessment(attempt, "learner_1");

		// Private answer & rubric data must not be in metadata
		expect(event.evidence?.metadata).toBeUndefined();
		expect(event.payload).toEqual({
			concept: "cs.algorithms.binary_search",
			kind: "application",
			result: "correct",
			hint_level: 0,
		});

		// Fabricated fields must be undefined
		expect(event.evidence?.delay_seconds).toBeUndefined();
		expect(event.evidence?.transfer_distance).toBeUndefined();
		expect(event.evidence?.learner_confidence).toBeUndefined();
		expect(event.evidence?.misconception_id).toBeUndefined();
	});

	it("produces deterministic dedupeContentDigest across separate candidate generations", () => {
		const attempt = sampleAttempt();
		const event1 = buildEvidenceFromAssessment(attempt, "learner_1", new Date(1000));
		const event2 = buildEvidenceFromAssessment(attempt, "learner_1", new Date(2000));

		// Even though event1 and event2 have different event_id, evidence_id, and timestamps:
		expect(event1.event_id).not.toBe(event2.event_id);
		expect(event1.evidence?.evidence_id).not.toBe(event2.evidence?.evidence_id);

		// Their dedupeContentDigest must match identically!
		const digest1 = dedupeContentDigest(event1);
		const digest2 = dedupeContentDigest(event2);
		expect(digest1).toBe(digest2);
	});
});
