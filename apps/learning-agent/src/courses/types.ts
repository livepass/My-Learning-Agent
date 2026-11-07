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

export const COURSE_STATUSES = ["in_progress", "paused", "completed", "archived"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const PLAN_STATUSES = ["draft", "active", "completed", "archived"] as const;
export type StudyPlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_ORIGINS = ["user", "agent_suggested"] as const;
export type StudyPlanOrigin = (typeof PLAN_ORIGINS)[number];

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type LearningTaskStatus = (typeof TASK_STATUSES)[number];

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
 * A study plan belongs to exactly one course. `origin` distinguishes a plan the
 * learner wrote from a draft the agent suggested; an `agent_suggested` plan is
 * always created as `draft` and becomes usable only after an explicit status
 * update (the confirmation step in E4.3).
 */
export interface StudyPlan {
	plan_id: string;
	course_id: string;
	title: string;
	description: string;
	goal_id: string | null;
	status: StudyPlanStatus;
	origin: StudyPlanOrigin;
	created_at: string;
	updated_at: string;
}

export interface LearningTask {
	task_id: string;
	course_id: string;
	plan_id: string | null;
	title: string;
	concept_ids: string[];
	source_ids: string[];
	status: LearningTaskStatus;
	created_at: string;
	updated_at: string;
}

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

/** Limits applied by the store (authoritative) and mirrored by the routes. */
export const MAX_COURSE_TITLE = 120;
export const MAX_PLAN_TITLE = 120;
export const MAX_TASK_TITLE = 200;
export const MAX_DESCRIPTION = 4000;
export const MAX_ID_LIST = 200;

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

export function isSessionOrigin(value: unknown): value is CourseSessionOrigin {
	return typeof value === "string" && (SESSION_ORIGINS as readonly string[]).includes(value);
}

export function isSourceBindingStatus(value: unknown): value is CourseSourceBindingStatus {
	return typeof value === "string" && (SOURCE_BINDING_STATUSES as readonly string[]).includes(value);
}
