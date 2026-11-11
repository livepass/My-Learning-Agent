/**
 * E4.1 course contracts.
 *
 * A Course is deliberately NOT a LearningGoal. Goals stay owned by L1
 * (`memory/learner`); a course relates to one only through an explicit
 * `CourseGoalBinding` record. Nothing here infers ownership from a title, a
 * chat topic or a session's content: a record without a binding stays
 * 「未归类」 and is reported as such by the API.
 *
 * Each entity below has exactly one persisted list owned by
 * `courses/course-store.ts`; no other module writes those files.
 */

import type { LearningModelIdentity } from "../memory/learner/types.js";

export const COURSE_STATUSES = ["in_progress", "paused", "completed", "archived"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const PLAN_STATUSES = ["draft", "active", "completed", "archived"] as const;
export type StudyPlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_ORIGINS = ["user", "agent_suggested"] as const;
export type StudyPlanOrigin = (typeof PLAN_ORIGINS)[number];

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type LearningTaskStatus = (typeof TASK_STATUSES)[number];

/**
 * E4.3a — task difficulty is a planning hint, not a mastery judgement.
 * Adjusting it never writes L1: only evidence recorded through the learning
 * flow can change a knowledge state.
 */
export const TASK_DIFFICULTIES = ["basic", "standard", "challenge"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

/**
 * E4.3b — what the plan was generated from.
 *
 * `course_material` means every citation comes from an indexed passage of this
 * course; `model_knowledge` means the learner explicitly chose a general
 * planning basis and the plan carries no citation at all. There is no third
 * state: an unlabelled plan is never presented as material-based.
 */
export const PLAN_BASES = ["course_material", "model_knowledge"] as const;
export type PlanBasis = (typeof PLAN_BASES)[number];

/**
 * How a session came to belong to a course. Provenance only: it records who
 * started the session, never that the course was inferred from its content.
 */
export const SESSION_ORIGINS = ["task", "free_question", "manual"] as const;
export type CourseSessionOrigin = (typeof SESSION_ORIGINS)[number];

/**
 * A source binding can be detached without deleting its history. Detaching is
 * a status change, not a delete: E4.2 needs to prove that a document *was*
 * course material, and a re-bind must reuse the original binding id instead of
 * minting a second identity for the same pair.
 */
export const SOURCE_BINDING_STATUSES = ["active", "detached"] as const;
export type CourseSourceBindingStatus = (typeof SOURCE_BINDING_STATUSES)[number];

export interface Course {
	course_id: string;
	title: string;
	description: string;
	status: CourseStatus;
	created_at: string;
	updated_at: string;
}

/** Explicit course ↔ L1 goal association. A goal may serve several courses. */
export interface CourseGoalBinding {
	binding_id: string;
	course_id: string;
	goal_id: string;
	created_at: string;
}

/**
 * One bounded excerpt the generator actually adopted, kept with the plan so
 * "why this task exists" can still be answered after the wiki page changes.
 * `excerpt` is a private snapshot; public list responses drop it.
 */
export interface PlanSourceUnit {
	unit_id: string;
	source_id: string;
	source_title: string;
	page_path: string;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
	excerpt: string;
}

/**
 * E4.3b generation provenance. Server-issued: request identity, basis, model
 * identity, goal/course scope and the adopted excerpts never come from the
 * model. `units` holds only the units a task actually cites; `provided_units`
 * records how large the candidate set was, which is what makes "not the whole
 * textbook" auditable.
 */
export interface PlanGeneration {
	request_id: string;
	/** Full fingerprint: intent + course + material + profile versions. */
	fingerprint: string;
	/**
	 * Intent-only fingerprint (course, goals, budget, date, basis, foundation).
	 * A retry with the same request id is a replay even if material/profile
	 * changed since; a different intent under the same id is a conflict.
	 */
	request_fingerprint?: string;
	basis: PlanBasis;
	model: LearningModelIdentity;
	generated_at: string;
	goal_ids: string[];
	/** Active course sources considered during retrieval. */
	source_ids: string[];
	provided_units: number;
	units: PlanSourceUnit[];
	assumptions: string[];
	uncertainties: string[];
	/** Explicit disclosure shown to the learner; never a fabricated citation. */
	material_note: string;
}

/** Stored snapshot of the facts a suggestion was based on. */
export interface PlanAdjustmentEvidence {
	concept_id?: string;
	state_label?: string;
	review_due_at?: string;
	evidence_count: number;
	mastery?: number;
	misconception_ids?: string[];
	prerequisite_concept_id?: string;
}

/** E4.3e applied change provenance: suggestions never rewrite silently. */
export interface PlanAdjustmentRecord {
	adjustment_id: string;
	suggestion_id: string;
	type: PlanAdjustmentType;
	applied_at: string;
	reason_code: string;
	concept_id?: string;
	task_id?: string;
	/** Evidence snapshot at apply time; never a chat message or model opinion. */
	evidence?: PlanAdjustmentEvidence;
	/** Human-readable summary of what changed, kept for audit. */
	changes: string[];
}

/**
 * A study plan belongs to exactly one course. `origin` distinguishes a plan the
 * learner wrote from a draft the agent suggested; an `agent_suggested` plan is
 * always created as `draft` and becomes usable only after an explicit
 * confirmation call (E4.3c), never through a status patch.
 *
 * `revision` is the optimistic-concurrency token for draft edits and confirm:
 * a stale edit is refused rather than applied on top of someone else's change.
 */
export interface StudyPlan {
	plan_id: string;
	course_id: string;
	title: string;
	description: string;
	goal_id: string | null;
	status: StudyPlanStatus;
	origin: StudyPlanOrigin;
	/** ISO date (`YYYY-MM-DD`) the learner wants to finish by; optional. */
	target_date?: string;
	/** Per-plan snapshot of the daily budget used when it was generated. */
	daily_minutes?: number;
	revision: number;
	generation?: PlanGeneration;
	adjustments?: PlanAdjustmentRecord[];
	created_at: string;
	updated_at: string;
}

/** A phase inside a plan. Tasks reference it optionally; order is 0-based. */
export interface PlanStage {
	stage_id: string;
	course_id: string;
	plan_id: string;
	title: string;
	description: string;
	order: number;
	created_at: string;
	updated_at: string;
}

/**
 * Provenance of one task's citation: a real passage of a real course source.
 * The server fills these from the material unit it handed the model, so a task
 * can never name a page the course did not provide.
 */
export interface TaskSourceRef {
	source_id: string;
	page_path: string;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
	/** `PlanSourceUnit.unit_id` inside the generating plan, when generated. */
	unit_id?: string;
}

export interface LearningTask {
	task_id: string;
	course_id: string;
	plan_id: string | null;
	/** Optional phase; must belong to the same plan. */
	stage_id: string | null;
	title: string;
	/** 0-based position inside its plan (or inside the course for plan-less tasks). */
	order: number;
	estimated_minutes: number | null;
	difficulty: TaskDifficulty;
	concept_ids: string[];
	/** Display labels aligned with `concept_ids`; absent for legacy tasks. */
	concept_labels?: string[];
	source_ids: string[];
	source_refs?: TaskSourceRef[];
	/** Why this task exists, in the plan's own words. Never an evidence claim. */
	rationale?: string;
	status: LearningTaskStatus;
	completed_at?: string;
	created_at: string;
	updated_at: string;
}

/**
 * Per-course planning preferences. A separate record instead of new `Course`
 * fields keeps the E4.1 course entity byte-compatible; one row per course.
 */
export interface CourseStudySettings {
	course_id: string;
	/** Fallback daily budget when a recommendation request has no `minutes`. */
	daily_minutes: number;
	updated_at: string;
}

export const PLAN_ADJUSTMENT_TYPES = [
	"review_prerequisite",
	"add_practice",
	"defer_task",
	"reorder_task",
	"adjust_difficulty",
] as const;
export type PlanAdjustmentType = (typeof PLAN_ADJUSTMENT_TYPES)[number];

/**
 * A session belongs to at most one course. The binding is immutable: the store
 * refuses to re-associate a session with another course instead of silently
 * rewriting history. `task_id` lets "继续学习" find the task's existing session
 * instead of creating a second one.
 */
export interface CourseSessionBinding {
	binding_id: string;
	course_id: string;
	session_id: string;
	task_id: string | null;
	origin: CourseSessionOrigin;
	created_at: string;
}

/**
 * E4.4a — a 「开始学习」 request and the session it produced.
 *
 * The record exists before the session does. That ordering is the whole point:
 * if session creation succeeds but the course binding fails, the request still
 * names the session it created, so a retry can finish or undo that exact
 * attempt instead of leaving an orphan that nobody can find again.
 *
 * `status`:
 * - `creating` — reserved, no session id yet (a concurrent duplicate must not
 *   start a second session);
 * - `created`  — the session file exists but the course binding is not written
 *   yet (the compensation window);
 * - `ready`    — session + binding are consistent; later duplicates replay it.
 */
export interface LearningStart {
	request_id: string;
	course_id: string;
	task_id: string | null;
	session_id: string | null;
	status: LearningStartStatus;
	created_at: string;
	updated_at: string;
}

export const LEARNING_START_STATUSES = ["creating", "created", "ready"] as const;
export type LearningStartStatus = (typeof LEARNING_START_STATUSES)[number];

export function isLearningStartStatus(value: unknown): value is LearningStartStatus {
	return typeof value === "string" && (LEARNING_START_STATUSES as readonly string[]).includes(value);
}

/**
 * One L2 source may serve several courses; ownership is always explicit.
 *
 * `status` is the association state (`active` / `detached`), `updated_at` the
 * last state change and `detached_at` the audit stamp of the latest detach.
 * Older records without the new fields load as `active` with
 * `updated_at = created_at` — no migration pass rewrites them.
 */
export interface CourseSourceBinding {
	binding_id: string;
	course_id: string;
	source_id: string;
	status: CourseSourceBindingStatus;
	created_at: string;
	updated_at: string;
	detached_at?: string;
}

export interface CourseCounts {
	goals: number;
	plans: number;
	tasks: number;
	sessions: number;
	sources: number;
}

/**
 * E4.7 — reasons a destructive delete is refused.
 *
 * A code is stable and machine-readable so the confirmation dialog can name
 * *why* deletion is unavailable instead of showing one generic error. Each
 * code corresponds to real learning history that a delete would orphan:
 *
 * - `course_sessions` / `plan_sessions` — a conversation was started for it;
 * - `started_tasks` — a task left `pending`, i.e. the learner worked on it;
 * - `pending_learning_start` — a 「开始学习」 request has not finished yet;
 * - `learning_evidence` — B2 already recorded a formal attempt (never inferred
 *   from chat, a task checkbox or a self-report);
 * - `mastery_states` — L1 holds course-scoped knowledge states;
 * - `plan_completed` — the learner marked the plan finished.
 *
 * Deleting any of those would break the L1/L2/L3/B2 evidence chain, so the
 * only offered action is archiving.
 */
export type DeletionBlockerCode =
	| "course_sessions"
	| "plan_sessions"
	| "started_tasks"
	| "pending_learning_start"
	| "learning_evidence"
	| "mastery_states"
	| "plan_completed";

export interface DeletionBlocker {
	code: DeletionBlockerCode;
	/** Human-readable reason, safe to show as-is (no path, no user content). */
	message: string;
	/** How many records caused the block, when it is countable. */
	count?: number;
}

/**
 * What a permanent course delete would remove, and why it may be refused.
 *
 * `counts` is computed from one state read so the dialog can promise exactly
 * what disappears; `sources` counts material associations only — the L2
 * document itself is shared and is never part of a delete.
 */
export interface CourseDeletionReport {
	course_id: string;
	title: string;
	deletable: boolean;
	blockers: DeletionBlocker[];
	counts: {
		plans: number;
		stages: number;
		tasks: number;
		/** Tasks that already left `pending`; a non-zero value blocks deletion. */
		started_tasks: number;
		sessions: number;
		goals: number;
		sources: number;
	};
	/** True when at least one active material association would be removed. */
	has_material: boolean;
}

export interface PlanDeletionReport {
	course_id: string;
	plan_id: string;
	title: string;
	status: StudyPlanStatus;
	deletable: boolean;
	blockers: DeletionBlocker[];
	counts: {
		stages: number;
		tasks: number;
		completed_tasks: number;
		started_tasks: number;
		sessions: number;
	};
}

/** What one delete actually removed; used for the response and for tests. */
export interface DeletionOutcome {
	course_id: string;
	plan_id?: string;
	removed: {
		plans: number;
		stages: number;
		tasks: number;
		sessions: number;
		goals: number;
		sources: number;
		learning_starts: number;
	};
}

/** Limits applied by the store (authoritative) and mirrored by the routes. */
export const MAX_COURSE_TITLE = 120;
export const MAX_PLAN_TITLE = 120;
export const MAX_TASK_TITLE = 200;
export const MAX_DESCRIPTION = 4000;
export const MAX_ID_LIST = 200;
export const MAX_STAGE_TITLE = 120;
export const MAX_STAGE_DESCRIPTION = 1000;
export const MAX_RATIONALE = 600;
export const MAX_CONCEPT_LABEL = 120;
export const MAX_PLAN_STAGES = 12;
export const MAX_STAGE_TASKS = 12;
export const MAX_PLAN_TASKS = 60;
export const MIN_ESTIMATED_MINUTES = 5;
export const MAX_ESTIMATED_MINUTES = 600;
export const MIN_DAILY_MINUTES = 5;
export const MAX_DAILY_MINUTES = 720;
export const MAX_TARGET_DATE = "2100-12-31";
export const MIN_TARGET_DATE = "2000-01-01";

/**
 * Identifier shape accepted for stored ids (course/plan/task/binding targets).
 * Generated ids are `course_xxxxxxxx` style, session ids end in `.jsonl`, and
 * source ids are `l2src_xxxxxxxx`. Separators and prototype keys are rejected
 * so an id can never escape a map key or a path segment.
 */
export function isSafeRecordId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= 128
		&& /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}

export function isCourseStatus(value: unknown): value is CourseStatus {
	return typeof value === "string" && (COURSE_STATUSES as readonly string[]).includes(value);
}

export function isPlanStatus(value: unknown): value is StudyPlanStatus {
	return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

export function isPlanOrigin(value: unknown): value is StudyPlanOrigin {
	return typeof value === "string" && (PLAN_ORIGINS as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is LearningTaskStatus {
	return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskDifficulty(value: unknown): value is TaskDifficulty {
	return typeof value === "string" && (TASK_DIFFICULTIES as readonly string[]).includes(value);
}

export function isPlanBasis(value: unknown): value is PlanBasis {
	return typeof value === "string" && (PLAN_BASES as readonly string[]).includes(value);
}

export function isPlanAdjustmentType(value: unknown): value is PlanAdjustmentType {
	return typeof value === "string" && (PLAN_ADJUSTMENT_TYPES as readonly string[]).includes(value);
}

export function isSessionOrigin(value: unknown): value is CourseSessionOrigin {
	return typeof value === "string" && (SESSION_ORIGINS as readonly string[]).includes(value);
}

export function isSourceBindingStatus(value: unknown): value is CourseSourceBindingStatus {
	return typeof value === "string" && (SOURCE_BINDING_STATUSES as readonly string[]).includes(value);
}
