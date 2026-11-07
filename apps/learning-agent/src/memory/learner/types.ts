import { randomUUID } from "node:crypto";

// ============================================================================
// Learner Profile Types
// ============================================================================

/**
 * Projection cursor stored in the same atomic replace as the derived fields it
 * describes. `version` is a business revision counter and must never be used as
 * an event offset: an event can be projected without a user-visible change and
 * a manual edit can bump the revision without touching the log.
 */
export interface ProfileProjection {
	/** Highest event sequence already folded into the derived fields. */
	applied_seq: number;
	/** Rule version used for the projection; a bump requires a rebuild. */
	rule_version: number;
	/** Latest fact time (max event timestamp) the projection was computed at. */
	as_of?: string;
}

export interface LearnerProfile {
	learner_id: string;
	version: number;
	updated_at: string;
	goals: LearningGoal[];
	knowledge_states: KnowledgeState[];
	misconceptions: Misconception[];
	preferences: LearnerPreferences;
	/** Mixed user/agent summary. Treated as user-owned: rebuilds never overwrite it. */
	profile_summary: string;
	/** Event-derived summary rebuilt from the ledger; never contains manual text. */
	derived_summary?: string;
	projection?: ProfileProjection;
	/** Monotonic counter for human edit ordering (owner issued). */
	manual_edit_seq?: number;
	/** Goal tombstones: a deleted goal must not be resurrected by replaying old events. */
	deleted_goals?: Record<string, ManualStamp>;
	/** Set only by an explicit recovery that accepted the loss of human fields. */
	manual_fields_lost?: boolean;
}

/**
 * Ownership stamp for a field the user manages directly.
 *
 * `at_seq` is the ledger position the human edit had already observed, so an
 * event may only overwrite the field when its own `seq` is strictly greater.
 * `edit` is an owner-issued monotonic counter used to order manual edits among
 * themselves and for auditing. No wall-clock comparison is involved, so equal
 * timestamps and clock rollback cannot reorder ownership.
 */
export interface ManualStamp {
	at_seq: number;
	edit: number;
}

export type GoalManualField = "title" | "priority" | "status" | "success_criteria";
export type PreferenceManualField = "explanation_style" | "practice_style" | "feedback_tone" | "avoid";
export type MisconceptionManualField = "status" | "severity" | "repair_strategy";

export interface LearningGoal {
	goal_id: string;
	title: string;
	type: "skill" | "concept" | "project" | "exam" | "habit";
	priority: number;
	status: "active" | "paused" | "completed" | "archived";
	success_criteria: string[];
	source: "user_declared" | "agent_inferred" | "imported";
	updated_at: string;
	manual?: Partial<Record<GoalManualField, ManualStamp>>;
}

export interface KnowledgeState {
	concept_id: string;
	concept_name: string;
	domain: string;
	/**
	 * E4.1a: the course this knowledge state belongs to.
	 *
	 * Absent on every pre-E4.1a state — those stay 「未归类」 forever and are
	 * never retroactively assigned. A state is attributed only when its first
	 * evidence was recorded under a course-bound session.
	 */
	course_id?: string;
	/**
	 * Heuristic score in [0,1] accumulated from fixed per-event increments
	 * (see MASTERY_DELTAS in auto-profile.ts). NOT a calibrated probability —
	 * use for relative ordering (what to review first), not absolute claims.
	 */
	mastery: number;
	/** Heuristic: how much evidence backs the mastery score. Not statistical confidence. */
	confidence: number;
	/** Heuristic: resistance to decay. Grows with positive deltas; no real forgetting model. */
	stability: number;
	estimate_confidence?: number;
	stability_days?: number;
	retrievability?: number;
	state_label?: KnowledgeStateLabel;
	last_evidence_at?: string;
	last_successful_retrieval_at?: string;
	last_result?: EvidenceResult;
	exposure_count?: number;
	retrieval_count?: number;
	lapse_count?: number;
	successful_transfer_count?: number;
	last_practiced_at?: string;
	review_due_at?: string;
	evidence_ids: string[];
	diagnosis: string;
	next_actions: string[];
	/**
	 * Where the numeric/count fields came from. `derived` states are rebuilt from
	 * the evidence ledger; `manual` / `legacy` states have no reproducible
	 * origin and are preserved as-is instead of being re-added to replay gains.
	 */
	origin?: "derived" | "manual" | "legacy";
	/** True when a legacy value was kept as-is because its source is unknown. */
	provenance_unknown?: boolean;
}

export interface Misconception {
	misconception_id: string;
	concept_id: string;
	description: string;
	status: "active" | "repairing" | "resolved" | "stale";
	severity: number;
	confidence: number;
	first_seen_at: string;
	last_seen_at: string;
	evidence_ids: string[];
	repair_strategy: string;
	manual?: Partial<Record<MisconceptionManualField, ManualStamp>>;
}

export interface LearnerPreferences {
	explanation_style: string[];
	practice_style: string[];
	feedback_tone: string[];
	avoid: string[];
	/** Per-list ownership stamps; an observed manual value wins over older events. */
	manual?: Partial<Record<PreferenceManualField, ManualStamp>>;
}

// ============================================================================
// Learning Event Types
// ============================================================================

export type LearningEventType =
	| "goal_declared"
	| "exercise_attempt"
	| "concept_explained"
	| "learning_evidence"
	| "evidence_corrected"
	| "self_assessed"
	| "preference_stated"
	| "feedback_received"
	| "milestone_reached";

export type EvidenceKind =
	| "exposure"
	| "recognition"
	| "guided_recall"
	| "free_recall"
	| "application"
	| "transfer"
	| "self_report"
	| "manual_override";

export type EvidenceResult = "correct" | "partial" | "incorrect" | "unknown";

export type EvidenceEvaluator = "deterministic" | "rubric" | "model" | "teacher" | "self";

export interface LearningEvidence {
	evidence_id: string;
	event_id: string;
	learner_id: string;
	concept_id: string;
	/** E4.1a: course of the question that produced this evidence; absent = unclassified. */
	course_id?: string;
	occurred_at: string;
	kind: EvidenceKind;
	result: EvidenceResult;
	score?: number;
	hint_level: 0 | 1 | 2 | 3;
	delay_seconds?: number;
	transfer_distance?: number;
	learner_confidence?: number;
	evaluator: EvidenceEvaluator;
	evaluator_confidence: number;
	session_id?: string;
	/** Explicitly links a repair check to one known misconception. */
	misconception_id?: string;
	metadata?: Record<string, unknown>;
	/** Server-owned provenance; legacy evidence may have no saved attempt. */
	learning_attempt?: LearningAttemptProvenance;
}

// ============================================================================
// S2 learning contracts. Types alone do not enable scoring or persistence.
// ============================================================================

export interface LearningQuestionRef {
	question_id: string;
	question_version: string;
}

/** Persisted privately; public responses must omit rubric, hints and answer. */
export interface LearningQuestion extends LearningQuestionRef {
	concept_id: string;
	goal_id?: string;
	prompt: string;
	kind: "free_recall" | "application" | "transfer";
	rubric_version: string;
	rubric: { criterion_id: string; description: string; weight: number }[];
	hints: string[];
	reference_answer: string;
	/** C1 only. Private provenance; absent on questions written before C1. */
	knowledge?: LearningQuestionKnowledge;
	/** C1 only. Private request identity used for idempotent retries. */
	generation?: LearningQuestionGeneration;
}

export type PublicLearningQuestion = Pick<LearningQuestion,
	"question_id" | "question_version" | "concept_id" | "goal_id" | "prompt" | "kind">
	/** Server-recorded review provenance, so a refresh restores it without the URL. */
	& { review?: true };

export type LearningExposure = LearningQuestionRef & {
	exposure_id: string;
	/** Monotonic within one learning session; assigned by its sole writer. */
	sequence: number;
	occurred_at: string;
} & ({ kind: "hint"; level: 1 | 2 } | { kind: "answer"; level: 3 });

export interface LearningHintSnapshot {
	through_sequence: number;
	exposure_ids: string[];
	hint_level: 0 | 1 | 2 | 3;
	answer_revealed: boolean;
}

/**
 * What a question was generated from (C1). Private: never part of a public
 * question projection.
 *
 * L2-backed variants carry a bounded copy of the adopted excerpt, because a
 * hash can prove identity but cannot reconstruct the text after the wiki page
 * changes. Model-backed variants carry no snapshot and no citation — only the
 * runtime-reported model identity.
 *
 * Optional on `LearningQuestion`: records written before C1 have no `knowledge`
 * field and stay valid, and nothing backfills them.
 */
export type LearningQuestionKnowledge =
	| {
		kind: "l2_document";
		/** `ManifestEntry.id`. */
		source_id: string;
		/** `ManifestEntry.source.identity`, trimmed; `null` when the entry had none. */
		source_identity: string | null;
		/** `ManifestEntry.contentHash` — the ingested original, not the wiki page. */
		original_content_hash: string;
		/** Wiki-relative logical path of the adopted excerpt. */
		page_path: string;
		/** sha256[:16] over `snippet_text`. */
		snippet_hash: string;
		/** Length of `snippet_text` in UTF-16 code units. */
		snippet_chars: number;
		/** Bounded private snapshot of the adopted excerpt. */
		snippet_text: string;
		/** ISO timestamp of generation. */
		bound_at: string;
		/** Runtime model identity that drafted the question. */
		model: LearningModelIdentity;
	}
	| {
		kind: "model_knowledge";
		ground: "no_source_requested" | "no_matching_source";
		bound_at: string;
		model: LearningModelIdentity;
	};

/**
 * Server-issued identity of the generation request that produced a question.
 * Kept beside the question so a retried request can find its own result
 * without a second persistence index.
 */
export interface LearningQuestionGeneration {
	request_id: string;
	/** Hash over the normalised request; a different payload under the same id is rejected. */
	fingerprint: string;
	/** C4 only. The completed attempt this question was generated after. */
	after_attempt_id?: string;
	/**
	 * C4-C only. The learner explicitly asked for this question as a due review.
	 *
	 * Provenance, not achievement: it says who started the question and why, never
	 * that the concept is mastered, due, or that a second kind of evidence exists.
	 * Mastery still comes solely from C3 evidence projection.
	 */
	review?: true;
	/**
	 * E4.1a: the course context resolved from the session binding when this
	 * question was generated. Frozen here so the evidence written at finalize
	 * time is attributed to the course the question was asked in, even if the
	 * binding was added afterwards. Absent = unclassified (all pre-E4.1a rows).
	 */
	course_id?: string;
}

export type LearningModelIdentity = {
	provider_id: string;
	model_id: string;
} & ({ model_version: string; version_source: "provider_reported" }
	/** Never substitute a configured model name for an unavailable provider revision. */
	| { model_version: null; version_source: "unavailable" });

export interface LearningAttemptProvenance extends LearningQuestionRef {
	session_id: string;
	attempt_id: string;
	rubric_version: string;
	model: LearningModelIdentity;
	hints: LearningHintSnapshot;
}

/** The only caller-owned submission fields; no scores, versions of models or hint claims. */
export interface LearningAttemptSubmission extends LearningQuestionRef {
	attempt_id: string;
	expected_revision: number;
	answer: string;
}

export type LearningCriterionJudgment = "met" | "partially_met" | "not_met" | "unknown";

export interface ValidatedLearningAssessment extends LearningAttemptProvenance {
	result: EvidenceResult;
	/** Computed from rubric judgments by the server, never accepted from a caller/model. */
	score?: number;
	feedback: string;
	unknown_reason?: string;
	criteria: { criterion_id: string; judgment: LearningCriterionJudgment; explanation: string }[];
	assessed_at: string;
}

export interface LearningEvaluationFailure {
	code: "provider_error" | "timeout" | "invalid_assessment" | "interrupted" | "retry_limit";
	/** Sanitized user-facing reason, without credentials, raw provider response or local paths. */
	message: string;
	failed_at: string;
}

/** Every transition must be persisted before the subsequent side effect. */
export type LearningAttemptProgress =
	| { stage: "answer_saved" }
	| { stage: "evaluating"; process_run_id: string; evaluation_run_id: string; model: LearningModelIdentity; started_at: string }
	| { stage: "evaluation_failed"; failure: LearningEvaluationFailure }
	| { stage: "evaluated"; assessment: ValidatedLearningAssessment }
	| { stage: "evidence_recorded"; assessment: ValidatedLearningAssessment; event: LearningEvent }
	| { stage: "profile_projected"; assessment: ValidatedLearningAssessment; event: LearningEvent; profile_version: number }
	| { stage: "completed"; assessment: ValidatedLearningAssessment; event: LearningEvent; profile_version: number; checkpoint_advanced: boolean };

export interface LearningAttempt extends LearningQuestionRef {
	session_id: string;
	attempt_id: string;
	/** Exact answer, including whitespace; immutable after acceptance. */
	answer: string;
	accepted_at: string;
	accepted_revision: number;
	question: LearningQuestion;
	hints: LearningHintSnapshot;
	/** Counts begun model calls, including calls interrupted by process exit. */
	evaluation_attempts: number;
	progress: LearningAttemptProgress;
}

export interface LearningCheckpoint {
	schema_version: 1;
	session_id: string;
	revision: number;
	goal_id?: string;
	status: "active" | "paused" | "completed";
	step: "conversation" | "awaiting_answer" | "feedback";
	question?: LearningQuestionRef;
	pending_attempt_id?: string;
	last_completed_attempt_id?: string;
	/** Last durably recorded hint/answer exposure in the session. */
	exposure_sequence: number;
	updated_at: string;
}

/** Proposed aggregate owned by one learning-record writer, separate from chat question cards. */
export interface LearningSessionRecord {
	schema_version: 1;
	checkpoint: LearningCheckpoint;
	/** Published question versions are immutable, including after a skipped question. */
	questions: LearningQuestion[];
	exposures: LearningExposure[];
	attempts: LearningAttempt[];
}

export type KnowledgeStateLabel =
	| "unknown"
	| "learning"
	| "fragile"
	| "review_due"
	| "stable"
	| "misconception";

export interface DerivedKnowledgeState {
	concept_id: string;
	concept_name: string;
	domain: string;
	/** E4.1a: inherited from the stored state; absent = unclassified. */
	course_id?: string;
	mastery: number;
	estimate_confidence: number;
	stability_days: number;
	retrievability?: number;
	last_evidence_at?: string;
	last_successful_retrieval_at?: string;
	last_result?: EvidenceResult;
	next_review_at?: string;
	exposure_count: number;
	retrieval_count: number;
	lapse_count: number;
	successful_transfer_count: number;
	active_misconception_ids: string[];
	evidence_ids: string[];
	state_label: KnowledgeStateLabel;
	diagnosis: string;
	next_actions: string[];
}

export interface LearningEvent {
	schema_version?: 1 | 2 | 3;
	/** Monotonic position in the learner ledger, assigned by the L1 owner. */
	seq?: number;
	event_id: string;
	learner_id: string;
	timestamp: string;
	event_type: LearningEventType;
	context: {
		goal_id?: string;
		concept_ids?: string[];
		session_id?: string;
	};
	payload: Record<string, unknown>;
	dedupe_key?: string;
	evidence?: LearningEvidence;
	/** Append-only correction of an earlier evidence record; never a re-attempt. */
	correction?: LearningEvidenceCorrection;
	derived_signals?: {
		mastery_delta?: number;
		misconception_candidates?: string[];
		affect?: string;
		preference_candidates?: string[];
	};
}

/**
 * A correction is appended next to the original evidence, never in place of
 * it. The original record stays immutable; the effective view is computed by
 * replaying the correction chain in ledger order.
 */
export interface LearningEvidenceCorrection {
	schema_version: 1;
	correction_id: string;
	/** Original evidence this correction revises. */
	evidence_id: string;
	event_id: string;
	learner_id: string;
	occurred_at: string;
	corrected_result: EvidenceResult;
	corrected_score?: number;
	reason: string;
	/** Previous correction in the chain; omitted for the first revision. */
	supersedes?: string;
}

// ============================================================================
// Context Pack (injected into system prompt)
// ============================================================================

export interface LearnerContextPack {
	active_goal?: string;
	relevant_concepts: {
		concept_id: string;
		mastery: number;
		diagnosis: string;
		estimate_confidence?: number;
		retrievability?: number;
		state_label?: KnowledgeStateLabel;
		recommended_action?: string;
	}[];
	active_misconceptions: string[];
	teaching_hints: string[];
	recent_events?: {
		event_id: string;
		event_type: LearningEventType;
		timestamp: string;
		summary: string;
	}[];
	review_due_concepts?: {
		concept_id: string;
		review_due_at: string;
		mastery: number;
	}[];
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createDefaultProfile(learnerId?: string): LearnerProfile {
	return {
		learner_id: learnerId ?? "default",
		version: 0,
		updated_at: new Date().toISOString(),
		goals: [],
		knowledge_states: [],
		misconceptions: [],
		preferences: {
			explanation_style: [],
			practice_style: [],
			feedback_tone: [],
			avoid: [],
		},
		profile_summary: "",
	};
}

export function createLearningEvent(
	learnerId: string,
	eventType: LearningEventType,
	context: LearningEvent["context"],
	payload: Record<string, unknown>,
	derivedSignals?: LearningEvent["derived_signals"],
): LearningEvent {
	return {
		event_id: `evt_${randomUUID().slice(0, 8)}`,
		learner_id: learnerId,
		timestamp: new Date().toISOString(),
		event_type: eventType,
		context,
		payload,
		derived_signals: derivedSignals,
	};
}
