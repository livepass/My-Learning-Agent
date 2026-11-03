import { createLearningEvidenceEvent } from "../memory/learner/evidence.js";
import { LearningContractError } from "./contracts.js";
import type {
	LearningAttempt,
	LearningEvent,
	LearningAttemptProvenance,
	ValidatedLearningAssessment,
	EvidenceKind,
} from "../memory/learner/types.js";

/**
 * Heuristic confidence weight for rubric-guided automated LLM evaluations.
 * Explicitly documented as a heuristic prior rather than calibrated statistical accuracy.
 */
export const RUBRIC_EVALUATION_CONFIDENCE = 0.8;

/**
 * Pure adapter: construct a formal L1 learning evidence event from an authoritative
 * B2 attempt and its validated assessment.
 *
 * Requirements:
 * 1. Only reads authoritative server data (LearningAttempt, ValidatedLearningAssessment, LearningQuestion, LearningHintSnapshot).
 * 2. Conservative kind mapping:
 *    - If reference answer was revealed (hints.answer_revealed or hint_level === 3) -> "exposure" (0 mastery weight in state engine).
 *    - If hints were used (hint_level > 0) -> "guided_recall".
 *    - Else -> question.kind ("free_recall" | "application" | "transfer").
 * 3. Handles "unknown" result without fabricated score (score must be undefined).
 * 4. Binds authoritative LearningAttemptProvenance into event.evidence.learning_attempt.
 * 5. Does NOT leak user answer, reference answer, rubric definitions, or raw model response to metadata.
 * 6. Omits delay_seconds, transfer_distance, learner_confidence, misconception_id without verified sources.
 */
export function buildEvidenceFromAssessment(
	attempt: LearningAttempt,
	learnerId: string,
	now: Date = new Date(),
): LearningEvent {
	if (!learnerId || typeof learnerId !== "string" || !learnerId.trim()) {
		throw new LearningContractError("invalid_input", "Invalid learner ID");
	}

	const stage = attempt.progress.stage;
	if (
		stage !== "evaluated" &&
		stage !== "evidence_recorded" &&
		stage !== "profile_projected" &&
		stage !== "completed"
	) {
		throw new LearningContractError("invalid_assessment", "Attempt has not been evaluated");
	}

	const assessment: ValidatedLearningAssessment = attempt.progress.assessment;
	const question = attempt.question;
	if (!question || !question.concept_id) {
		throw new LearningContractError("invalid_assessment", "Missing question concept identity");
	}

	const hints = attempt.hints;
	let kind: EvidenceKind;
	if (hints.answer_revealed || hints.hint_level === 3) {
		// Conservative policy: revealing the answer reduces the event to an exposure
		// so it does not falsely boost independent retrieval mastery.
		kind = "exposure";
	} else if (hints.hint_level > 0) {
		kind = "guided_recall";
	} else {
		kind = question.kind;
	}

	const isUnknown = assessment.result === "unknown";
	const score = isUnknown
		? undefined
		: typeof assessment.score === "number" && Number.isFinite(assessment.score)
			? Math.max(0, Math.min(1, assessment.score))
			: undefined;

	const provenance: LearningAttemptProvenance = {
		session_id: attempt.session_id,
		attempt_id: attempt.attempt_id,
		question_id: attempt.question_id,
		question_version: attempt.question_version,
		rubric_version: question.rubric_version,
		model: structuredClone(assessment.model),
		hints: structuredClone(hints),
	};

	const event = createLearningEvidenceEvent(
		learnerId,
		{
			concept_id: question.concept_id,
			kind,
			result: assessment.result,
			score,
			hint_level: hints.hint_level,
			evaluator: "rubric",
			evaluator_confidence: RUBRIC_EVALUATION_CONFIDENCE,
			session_id: attempt.session_id,
			// Strict metadata privacy: do not copy private rubric, reference answer,
			// user answer or raw model outputs into L1 event metadata.
		},
		now,
	);

	// Context session alignment
	event.context.session_id = attempt.session_id;
	if (!event.context.concept_ids?.includes(question.concept_id)) {
		event.context.concept_ids = [question.concept_id];
	}

	// Formal attempt identity alignment
	if (event.evidence) {
		event.evidence.session_id = attempt.session_id;
		event.evidence.learner_id = learnerId;
		event.evidence.learning_attempt = provenance;
	}

	return event;
}
