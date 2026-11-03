export interface LearnerProfile {
	learner_id: string;
	version: number;
	updated_at: string;
	goals: LearningGoal[];
	knowledge_states: KnowledgeState[];
	misconceptions: Misconception[];
	preferences: LearnerPreferences;
	profile_summary: string;
}

export type GoalType = "skill" | "concept" | "project" | "exam" | "habit";
export type GoalStatus = "active" | "paused" | "completed" | "archived";

export interface LearningGoal {
	goal_id: string;
	title: string;
	type: GoalType;
	priority: number;
	status: GoalStatus;
	success_criteria: string[];
	source: "user_declared" | "agent_inferred" | "imported";
	updated_at: string;
}

export interface KnowledgeState {
	concept_id: string;
	concept_name: string;
	domain: string;
	mastery: number;
	confidence: number;
	stability: number;
	last_practiced_at?: string;
	review_due_at?: string;
	evidence_ids: string[];
	diagnosis: string;
	next_actions: string[];
}

export type MisconceptionStatus = "active" | "repairing" | "resolved" | "stale";

export interface Misconception {
	misconception_id: string;
	concept_id: string;
	description: string;
	status: MisconceptionStatus;
	severity: number;
	confidence: number;
	first_seen_at: string;
	last_seen_at: string;
	evidence_ids: string[];
	repair_strategy: string;
}

export interface LearnerPreferences {
	explanation_style: string[];
	practice_style: string[];
	feedback_tone: string[];
	avoid: string[];
}

/** C4-B: read-only next-step recommendation from the L1 profile. */
export type LearningRecommendationAction = "review" | "learn" | "practice" | "diagnose" | "transfer";
export type LearningRecommendationReason =
	| "active_misconception"
	| "review_due"
	| "fragile_evidence"
	| "learning_needs_diagnosis"
	| "stable_transfer";

export interface RecommendationEvidenceBasis {
	state_label?: "unknown" | "learning" | "fragile" | "review_due" | "stable" | "misconception";
	review_due_at?: string;
	last_result?: "correct" | "partial" | "incorrect" | "unknown";
	evidence_count: number;
	has_active_misconception: boolean;
	provenance_limited: boolean;
	exposure_only: boolean;
}

export interface LearningRecommendation {
	concept_id: string;
	/** Absent when the stored name is a machine identity. */
	concept_name?: string;
	name_available: boolean;
	action: LearningRecommendationAction;
	suggested_kind?: "free_recall" | "application" | "transfer";
	reason_code: LearningRecommendationReason;
	reason: string;
	also_matches: LearningRecommendationReason[];
	evidence_basis: RecommendationEvidenceBasis;
}

export interface RecommendationSnapshot {
	as_of: string;
	generated_at: string;
	profile_version: number;
	projection?: { applied_seq: number; rule_version: number; as_of?: string };
	recommendations: LearningRecommendation[];
	status: "ok" | "empty";
	empty_reason?: "no_knowledge_evidence" | "no_actionable_state";
	limit: number;
}
