import { apiFetch } from "./client.js";

/**
 * `/api/courses/*` client (E4.5a).
 *
 * Types mirror the server payloads field for field (snake_case): the course
 * domain in `src/courses` is the single authority for course, plan, task,
 * material and learning-start state, so this module adds no derived fields and
 * makes no optimistic writes. Every read accepts an `AbortSignal` so a page
 * that switches course can cancel the response it no longer wants.
 */

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export type CourseStatus = "in_progress" | "paused" | "completed" | "archived";
export type PlanStatus = "draft" | "active" | "completed" | "archived";
export type PlanOrigin = "user" | "agent_suggested";
export type PlanBasis = "course_material" | "model_knowledge";
export type TaskStatus = "pending" | "in_progress" | "completed";
export type TaskDifficulty = "basic" | "standard" | "challenge";
export type SourceBindingStatus = "active" | "detached";
export type ManifestStatus = "pending" | "extracted" | "indexed" | "error";
export type SessionOrigin = "task" | "free_question" | "manual";
export type PlanAdjustmentType =
	| "review_prerequisite"
	| "add_practice"
	| "defer_task"
	| "reorder_task"
	| "adjust_difficulty";

// ---------------------------------------------------------------------------
// Course
// ---------------------------------------------------------------------------

export interface Course {
	course_id: string;
	title: string;
	description: string;
	status: CourseStatus;
	created_at: string;
	updated_at: string;
}

export interface CourseCounts {
	goals: number;
	plans: number;
	tasks: number;
	sessions: number;
	sources: number;
}

/** `GET /api/courses` row: the course plus its explicit relation counts. */
export interface CourseSummary extends Course {
	counts: CourseCounts;
}

export interface CourseGoalBinding {
	binding_id: string;
	course_id: string;
	goal_id: string;
	created_at: string;
}

export interface CourseSessionBinding {
	binding_id: string;
	course_id: string;
	session_id: string;
	task_id: string | null;
	origin: SessionOrigin;
	created_at: string;
}

export interface CourseSourceBinding {
	binding_id: string;
	course_id: string;
	source_id: string;
	status: SourceBindingStatus;
	created_at: string;
	updated_at: string;
	detached_at?: string;
}

/** Public manifest summary; `status` is processing state, never ownership. */
export interface CourseSourceSummary {
	title: string;
	status: ManifestStatus;
	source_type: string;
	passage_count: number;
	page_count?: number;
	error?: string;
	updated_at: string;
	indexed_at?: string;
}

export interface CourseSourceView extends CourseSourceBinding {
	source: CourseSourceSummary | null;
}

/**
 * One indexed source the current course may attach.
 *
 * `courses` lists the courses that already hold an active binding; an empty
 * array means the document is still unclassified. The server computes this —
 * the client never infers ownership from a manifest alone.
 */
export interface CourseSourceCandidate {
	source_id: string;
	title: string;
	source_type: string;
	status: ManifestStatus;
	passage_count: number;
	page_count?: number;
	indexed_at?: string;
	/** The course the learner is looking at, when it already owns this source. */
	bound_to_current: boolean;
	courses: Array<{ course_id: string; title: string }>;
}

export interface CourseSourceSection {
	path: string;
	ordinal: number;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
}

export interface CourseSourceDetail {
	course_id: string;
	binding: CourseSourceBinding;
	source: CourseSourceSummary | null;
	sections: CourseSourceSection[];
}

export interface UnclassifiedRecords {
	sessions: string[];
	sources: string[];
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface PlanSourceUnit {
	unit_id: string;
	source_id: string;
	source_title: string;
	page_path: string;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
}

export interface PlanGeneration {
	request_id?: string;
	basis: PlanBasis;
	model: { provider?: string; model?: string; [key: string]: unknown };
	generated_at?: string;
	goal_ids?: string[];
	source_ids: string[];
	provided_units: number;
	units: PlanSourceUnit[];
	assumptions?: string[];
	uncertainties?: string[];
	material_note: string;
}

export interface PlanAdjustmentRecord {
	adjustment_id: string;
	suggestion_id: string;
	type: PlanAdjustmentType;
	applied_at: string;
	reason_code: string;
	concept_id?: string;
	task_id?: string;
	changes: string[];
}

export interface StudyPlan {
	plan_id: string;
	course_id: string;
	title: string;
	description: string;
	goal_id: string | null;
	status: PlanStatus;
	origin: PlanOrigin;
	target_date?: string;
	daily_minutes?: number;
	revision: number;
	generation?: PlanGeneration;
	adjustments?: PlanAdjustmentRecord[];
	created_at: string;
	updated_at: string;
}

/** `GET /api/courses/:id/plans` row: plan + counts, excerpts stripped. */
export interface PlanListItem extends StudyPlan {
	stage_count: number;
	task_count: number;
	completed_task_count: number;
	/** E4.7: tasks that already left `pending`; non-zero means history exists. */
	started_task_count: number;
}

// ---------------------------------------------------------------------------
// Deletion (E4.7)
// ---------------------------------------------------------------------------

/** Stable, machine-readable reason a delete is refused. */
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
	/** Ready to print; never a path or the learner's own text. */
	message: string;
	count?: number;
}

export interface CourseDeletionReport {
	course_id: string;
	title: string;
	deletable: boolean;
	blockers: DeletionBlocker[];
	counts: {
		plans: number;
		stages: number;
		tasks: number;
		started_tasks: number;
		sessions: number;
		goals: number;
		sources: number;
	};
	/** At least one material association would be removed (the file stays). */
	has_material: boolean;
}

export interface PlanDeletionReport {
	course_id: string;
	plan_id: string;
	title: string;
	status: PlanStatus;
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

export interface DeletionOutcome {
	deleted: true;
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

export interface TaskSourceRef {
	source_id: string;
	page_path: string;
	heading_path?: string;
	page_start?: number;
	page_end?: number;
	unit_id?: string;
}

export interface LearningTask {
	task_id: string;
	course_id: string;
	plan_id: string | null;
	stage_id: string | null;
	title: string;
	order: number;
	estimated_minutes: number | null;
	difficulty: TaskDifficulty;
	concept_ids: string[];
	concept_labels?: string[];
	source_ids: string[];
	source_refs?: TaskSourceRef[];
	rationale?: string;
	status: TaskStatus;
	completed_at?: string;
	created_at: string;
	updated_at: string;
}

export interface PlanDetail {
	plan: StudyPlan;
	stages: PlanStage[];
	tasks: LearningTask[];
	progress?: { total: number; completed: number; knowledge_effect: string };
	duplicate?: boolean;
	matched?: string;
	basis?: PlanBasis;
	generation?: PlanGeneration;
	status?: PlanStatus;
	requires_confirmation?: boolean;
}

export interface PlanSuggestion {
	suggestion_id: string;
	type: PlanAdjustmentType;
	title: string;
	reason: string;
	reason_code: string;
	task_id?: string;
	task_title?: string;
	before_task_id?: string;
	concept_id?: string;
	concept_label?: string;
	difficulty?: TaskDifficulty;
	estimated_minutes?: number;
	evidence: {
		concept_id?: string;
		state_label?: string;
		review_due_at?: string;
		evidence_count: number;
		mastery?: number;
		misconception_ids?: string[];
		prerequisite_concept_id?: string;
	};
	requires_confirmation: true;
	changes: string;
}

export interface PlanSuggestionsResult {
	plan_id: string;
	revision: number;
	suggestions: PlanSuggestion[];
	note: string;
}

export interface StageDraft {
	stage_id?: string | null;
	title: string;
	description?: string;
	tasks?: TaskDraft[];
}

export interface TaskDraft {
	task_id?: string | null;
	title: string;
	concept_ids?: string[];
	concept_labels?: string[];
	source_ids?: string[];
	estimated_minutes?: number | null;
	difficulty?: TaskDifficulty;
	rationale?: string;
	status?: TaskStatus;
}

export interface PlanStructure {
	plan: StudyPlan;
	stages: PlanStage[];
	tasks: LearningTask[];
}

// ---------------------------------------------------------------------------
// Daily recommendations
// ---------------------------------------------------------------------------

export type DailyItemReason = "review_due" | "in_progress" | "next_task" | "over_budget";

export interface DailyTaskItem {
	kind: "task";
	task_id: string;
	title: string;
	status: TaskStatus;
	order: number;
	stage_id: string | null;
	stage_title?: string;
	estimated_minutes: number;
	difficulty: TaskDifficulty;
	concept_ids: string[];
	source_ids: string[];
	reason_code: Exclude<DailyItemReason, "review_due">;
	reason: string;
}

export interface DailyReviewItem {
	kind: "review";
	concept_id: string;
	concept_name?: string;
	name_available: boolean;
	state_label?: string;
	review_due_at: string;
	evidence_count: number;
	estimated_minutes: number;
	reason_code: "review_due";
	reason: string;
}

export type DailyPlanItem = DailyTaskItem | DailyReviewItem;

export type DailyCourseStatus = "ok" | "no_active_plan" | "empty_plan" | "all_completed";

export interface CourseDailyPlan {
	course_id: string;
	course_title: string;
	status: DailyCourseStatus;
	daily_minutes: number;
	plan: { plan_id: string; title: string; revision: number } | null;
	other_active_plans: number;
	items: DailyPlanItem[];
	planned_minutes: number;
	task_progress: { total: number; completed: number; in_progress: number; percent: number };
	knowledge: {
		due_reviews: number;
		weak_concepts: number;
		stable_concepts: number;
		evidence_backed_concepts: number;
	};
	notes: string[];
}

export interface DailyPlanSnapshot {
	as_of: string;
	generated_at: string;
	minutes_override: number | null;
	courses: CourseDailyPlan[];
	total_planned_minutes: number;
}

// ---------------------------------------------------------------------------
// Course-scoped learner view
// ---------------------------------------------------------------------------

export interface CourseLearnerGoal {
	goal_id: string;
	title: string;
	type: string;
	priority: number;
	status: string;
	success_criteria: string[];
	source: string;
	updated_at: string;
}

export interface CourseKnowledgeState {
	concept_id: string;
	concept_name: string;
	domain: string;
	course_id?: string;
	mastery: number;
	confidence: number;
	stability: number;
	review_due_at?: string;
	evidence_ids: string[];
	diagnosis: string;
	next_actions: string[];
	state_label?: string;
	origin?: "derived" | "manual" | "legacy";
	provenance_unknown?: boolean;
}

export interface CourseLearnerView {
	course: Course;
	goals: CourseLearnerGoal[];
	knowledge_states: CourseKnowledgeState[];
	preferences: {
		explanation_style: string[];
		practice_style: string[];
		feedback_tone: string[];
		avoid: string[];
	};
	unclassified: { knowledge_states: number; goals: number };
}

export interface CourseSettings {
	course_id: string;
	daily_minutes: number | null;
	updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Learning start + session context
// ---------------------------------------------------------------------------

export interface LearningStartTaskView {
	task_id: string;
	title: string;
	status: string;
	stage_id: string | null;
	plan_id: string | null;
	estimated_minutes: number | null;
	concept_ids: string[];
	concept_labels?: string[];
}

export interface LearningStartResult {
	request_id: string;
	session: { session_id: string; active: boolean; created: boolean; resumed: boolean };
	course: { course_id: string; title: string; status: CourseStatus };
	task: LearningStartTaskView | null;
	goal_id: string | null;
	learning: { created: boolean; checkpoint: { revision: number; status: string; step: string } | null };
	context_ready: boolean;
	warnings: string[];
}

export interface SessionCourseContext {
	session_id: string;
	unclassified: boolean;
	binding: CourseSessionBinding | null;
	course: Course | null;
	task: LearningStartTaskView | null;
	source_ids: string[];
	goal_ids: string[];
}

export interface CourseSessionsResult {
	sessions: CourseSessionBinding[];
	duplicate_task_bindings?: Array<{ task_id: string; session_ids: string[]; note: string }>;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export async function listCourses(signal?: AbortSignal): Promise<CourseSummary[]> {
	const data = await apiFetch<{ courses: CourseSummary[] }>("/api/courses", { signal });
	return data.courses;
}

/** `GET /api/courses/:id`: one read, so counts and lists always agree. */
export interface CourseDetail {
	course: Course;
	counts: CourseCounts;
	goals: CourseGoalBinding[];
	plans: StudyPlan[];
	stages: PlanStage[];
	tasks: LearningTask[];
	sessions: CourseSessionBinding[];
	sources: CourseSourceBinding[];
}

export async function getCourse(courseId: string, signal?: AbortSignal): Promise<CourseDetail> {
	return apiFetch<CourseDetail>(`/api/courses/${encodeURIComponent(courseId)}`, { signal });
}

export async function createCourse(input: { title: string; description?: string }): Promise<Course> {
	return apiFetch<Course>("/api/courses", { method: "POST", body: JSON.stringify(input) });
}

export async function updateCourse(
	courseId: string,
	patch: { title?: string; description?: string; status?: CourseStatus },
): Promise<Course> {
	return apiFetch<Course>(`/api/courses/${encodeURIComponent(courseId)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

export async function archiveCourse(courseId: string): Promise<Course> {
	return apiFetch<Course>(`/api/courses/${encodeURIComponent(courseId)}/archive`, { method: "POST" });
}

/**
 * Restore an archived course. The server always restores it to `paused`: the
 * pre-archive status was never stored, and resuming learning must be explicit.
 */
export async function restoreCourse(courseId: string): Promise<Course> {
	return apiFetch<Course>(`/api/courses/${encodeURIComponent(courseId)}/restore`, { method: "POST" });
}

/**
 * Resume a restored course (`paused → in_progress`).
 *
 * Status only: the server creates no session and no learning record, so this
 * never starts studying on the learner's behalf. Archived courses must be
 * restored first — this endpoint refuses them.
 */
export async function resumeCourse(courseId: string): Promise<Course> {
	return apiFetch<Course>(`/api/courses/${encodeURIComponent(courseId)}/resume`, { method: "POST" });
}

/**
 * What a permanent delete would remove, and every reason it is refused.
 *
 * A read, so opening the confirmation dialog has no side effect. The server
 * computes it from one state snapshot: counts and blockers always agree.
 */
export async function getCourseDeletionPreview(
	courseId: string,
	signal?: AbortSignal,
): Promise<CourseDeletionReport> {
	return apiFetch<CourseDeletionReport>(
		`/api/courses/${encodeURIComponent(courseId)}/delete-preview`,
		{ signal },
	);
}

export async function deleteCourse(courseId: string): Promise<DeletionOutcome> {
	return apiFetch<DeletionOutcome>(`/api/courses/${encodeURIComponent(courseId)}`, { method: "DELETE" });
}

export async function bindCourseGoal(courseId: string, goalId: string): Promise<CourseGoalBinding> {
	return apiFetch<CourseGoalBinding>(`/api/courses/${encodeURIComponent(courseId)}/goals`, {
		method: "POST",
		body: JSON.stringify({ goal_id: goalId }),
	});
}

export async function unbindCourseGoal(courseId: string, goalId: string): Promise<void> {
	await apiFetch(`/api/courses/${encodeURIComponent(courseId)}/goals/${encodeURIComponent(goalId)}`, {
		method: "DELETE",
	});
}

export async function getCourseSettings(courseId: string, signal?: AbortSignal): Promise<CourseSettings> {
	return apiFetch<CourseSettings>(`/api/courses/${encodeURIComponent(courseId)}/settings`, { signal });
}

export async function putCourseSettings(courseId: string, dailyMinutes: number): Promise<CourseSettings> {
	return apiFetch<CourseSettings>(`/api/courses/${encodeURIComponent(courseId)}/settings`, {
		method: "PUT",
		body: JSON.stringify({ daily_minutes: dailyMinutes }),
	});
}

export async function getCourseLearner(courseId: string, signal?: AbortSignal): Promise<CourseLearnerView> {
	return apiFetch<CourseLearnerView>(`/api/courses/${encodeURIComponent(courseId)}/learner`, { signal });
}

export async function getDailyPlans(
	options: { courseId?: string; minutes?: number; signal?: AbortSignal } = {},
): Promise<DailyPlanSnapshot> {
	const params = new URLSearchParams();
	if (options.courseId) params.set("course_id", options.courseId);
	if (options.minutes !== undefined) params.set("minutes", String(options.minutes));
	const query = params.toString();
	return apiFetch<DailyPlanSnapshot>(`/api/courses/daily${query ? `?${query}` : ""}`, { signal: options.signal });
}

export async function getUnclassified(signal?: AbortSignal): Promise<UnclassifiedRecords> {
	return apiFetch<UnclassifiedRecords>("/api/courses/unclassified", { signal });
}

// --- Plans -----------------------------------------------------------------

export async function listPlans(courseId: string, signal?: AbortSignal): Promise<PlanListItem[]> {
	const data = await apiFetch<{ plans: PlanListItem[] }>(`/api/courses/${encodeURIComponent(courseId)}/plans`, { signal });
	return data.plans;
}

export async function getPlanDetail(
	courseId: string,
	planId: string,
	signal?: AbortSignal,
): Promise<PlanDetail> {
	return apiFetch<PlanDetail>(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}`,
		{ signal },
	);
}

export async function createPlan(
	courseId: string,
	input: {
		title: string;
		description?: string;
		goal_id?: string | null;
		target_date?: string | null;
		daily_minutes?: number | null;
		status?: PlanStatus;
		origin?: PlanOrigin;
		stages?: StageDraft[];
		tasks?: TaskDraft[];
	},
): Promise<PlanStructure | StudyPlan> {
	return apiFetch(`/api/courses/${encodeURIComponent(courseId)}/plans`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function generatePlan(
	courseId: string,
	input: {
		request_id: string;
		basis: PlanBasis;
		daily_minutes?: number;
		target_date?: string;
		foundation?: string;
		goal_ids?: string[];
		force?: boolean;
	},
): Promise<PlanDetail> {
	return apiFetch<PlanDetail>(`/api/courses/${encodeURIComponent(courseId)}/plans/generate`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function replacePlanDraft(
	courseId: string,
	planId: string,
	input: {
		expected_revision: number;
		title?: string;
		description?: string;
		goal_id?: string | null;
		target_date?: string | null;
		daily_minutes?: number | null;
		stages: StageDraft[];
		tasks?: TaskDraft[];
	},
): Promise<PlanStructure> {
	return apiFetch<PlanStructure>(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/draft`,
		{ method: "PUT", body: JSON.stringify(input) },
	);
}

export async function replacePlanStages(
	courseId: string,
	planId: string,
	input: { expected_revision: number; stages: Array<{ stage_id?: string | null; title: string; description?: string }> },
): Promise<PlanStructure> {
	return apiFetch<PlanStructure>(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/stages`,
		{ method: "PUT", body: JSON.stringify(input) },
	);
}

export async function confirmPlan(
	courseId: string,
	planId: string,
	input: { expected_revision: number; replace_active?: boolean },
): Promise<{ plan: StudyPlan; alreadyActive: boolean; archivedPlanIds: string[] }> {
	return apiFetch(`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/confirm`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function getPlanDeletionPreview(
	courseId: string,
	planId: string,
	signal?: AbortSignal,
): Promise<PlanDeletionReport> {
	return apiFetch<PlanDeletionReport>(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/delete-preview`,
		{ signal },
	);
}

/** Permanent plan delete: drafts and confirmed-but-unstarted plans only. */
export async function deletePlan(courseId: string, planId: string): Promise<DeletionOutcome> {
	return apiFetch<DeletionOutcome>(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}`,
		{ method: "DELETE" },
	);
}

/** Archive a plan: keeps its tasks, sessions and records readable. */
export async function archivePlan(courseId: string, planId: string): Promise<StudyPlan> {
	return apiFetch<StudyPlan>(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/archive`,
		{ method: "POST" },
	);
}

export async function reorderPlanTasks(
	courseId: string,
	planId: string,
	input: { expected_revision: number; task_ids: string[] },
): Promise<{ tasks: LearningTask[] }> {
	return apiFetch(`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/tasks/reorder`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function getPlanSuggestions(
	courseId: string,
	planId: string,
	signal?: AbortSignal,
): Promise<PlanSuggestionsResult> {
	return apiFetch<PlanSuggestionsResult>(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/suggestions`,
		{ signal },
	);
}

export async function applyPlanSuggestion(
	courseId: string,
	planId: string,
	suggestionId: string,
	input: { type: PlanAdjustmentType; expected_revision: number },
): Promise<PlanStructure & { adjustment: PlanAdjustmentRecord; applied_suggestion: PlanSuggestion }> {
	return apiFetch(
		`/api/courses/${encodeURIComponent(courseId)}/plans/${encodeURIComponent(planId)}/suggestions/${encodeURIComponent(suggestionId)}/apply`,
		{ method: "POST", body: JSON.stringify(input) },
	);
}

// --- Tasks -----------------------------------------------------------------

export async function listTasks(
	courseId: string,
	options: { planId?: string; signal?: AbortSignal } = {},
): Promise<LearningTask[]> {
	const params = new URLSearchParams();
	if (options.planId) params.set("plan_id", options.planId);
	const query = params.toString();
	const data = await apiFetch<{ tasks: LearningTask[] }>(
		`/api/courses/${encodeURIComponent(courseId)}/tasks${query ? `?${query}` : ""}`,
		{ signal: options.signal },
	);
	return data.tasks;
}

export async function updateTask(
	courseId: string,
	taskId: string,
	patch: {
		title?: string;
		status?: TaskStatus;
		estimated_minutes?: number | null;
		difficulty?: TaskDifficulty;
		rationale?: string;
		order?: number;
	},
): Promise<LearningTask> {
	return apiFetch<LearningTask>(
		`/api/courses/${encodeURIComponent(courseId)}/tasks/${encodeURIComponent(taskId)}`,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
}

// --- Learning --------------------------------------------------------------

export async function startCourseLearning(
	courseId: string,
	input: { task_id?: string | null; request_id: string },
): Promise<LearningStartResult> {
	return apiFetch<LearningStartResult>(`/api/courses/${encodeURIComponent(courseId)}/learning/start`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function getCourseSessions(courseId: string, signal?: AbortSignal): Promise<CourseSessionsResult> {
	return apiFetch<CourseSessionsResult>(`/api/courses/${encodeURIComponent(courseId)}/sessions`, { signal });
}

export async function getSessionCourseContext(
	sessionId: string,
	signal?: AbortSignal,
): Promise<SessionCourseContext> {
	return apiFetch<SessionCourseContext>(
		`/api/courses/bindings/session/${encodeURIComponent(sessionId)}`,
		{ signal },
	);
}

// --- Sources ---------------------------------------------------------------

export async function listCourseSources(
	courseId: string,
	options: { includeDetached?: boolean; signal?: AbortSignal } = {},
): Promise<CourseSourceView[]> {
	const params = new URLSearchParams();
	if (options.includeDetached) params.set("include_detached", "true");
	const query = params.toString();
	const data = await apiFetch<{ sources: CourseSourceView[] }>(
		`/api/courses/${encodeURIComponent(courseId)}/sources${query ? `?${query}` : ""}`,
		{ signal: options.signal },
	);
	return data.sources;
}

export interface UploadCourseSourceResult {
	course_id: string;
	binding_id: string;
	source_id: string;
	title: string;
	status: ManifestStatus;
	duplicate: boolean;
	passage_count: number;
	page_count?: number;
	source_type: string;
}

export async function uploadCourseSource(
	courseId: string,
	input: { fileName: string; mimeType?: string; dataBase64: string; title?: string },
): Promise<UploadCourseSourceResult> {
	return apiFetch<UploadCourseSourceResult>(
		`/api/courses/${encodeURIComponent(courseId)}/sources/upload`,
		{ method: "POST", body: JSON.stringify(input) },
	);
}

export async function getCourseSource(
	courseId: string,
	sourceId: string,
	signal?: AbortSignal,
): Promise<CourseSourceDetail> {
	return apiFetch<CourseSourceDetail>(
		`/api/courses/${encodeURIComponent(courseId)}/sources/${encodeURIComponent(sourceId)}`,
		{ signal },
	);
}

export async function retryCourseSource(courseId: string, sourceId: string): Promise<{
	source_id: string;
	status: ManifestStatus;
	duplicate: boolean;
	passage_count: number;
	page_count?: number;
}> {
	return apiFetch(
		`/api/courses/${encodeURIComponent(courseId)}/sources/${encodeURIComponent(sourceId)}/retry`,
		{ method: "POST" },
	);
}

/**
 * Sources that can be attached to this course, including ones already bound to
 * another course (same document, several courses). Indexed only: an unindexed
 * source cannot serve planning or learning yet.
 */
export async function listCourseSourceCandidates(
	courseId: string,
	signal?: AbortSignal,
): Promise<CourseSourceCandidate[]> {
	const data = await apiFetch<{ sources: CourseSourceCandidate[] }>(
		`/api/courses/${encodeURIComponent(courseId)}/source-candidates`,
		{ signal },
	);
	return data.sources;
}

export async function bindCourseSource(courseId: string, sourceId: string): Promise<CourseSourceBinding> {
	return apiFetch<CourseSourceBinding>(`/api/courses/${encodeURIComponent(courseId)}/sources`, {
		method: "POST",
		body: JSON.stringify({ source_id: sourceId }),
	});
}

export async function unbindCourseSource(courseId: string, sourceId: string): Promise<void> {
	await apiFetch(
		`/api/courses/${encodeURIComponent(courseId)}/sources/${encodeURIComponent(sourceId)}`,
		{ method: "DELETE" },
	);
}

/**
 * The server's conflict payload (`revision`) or `undefined`.
 *
 * A 409 means the plan draft moved under us; the caller must re-read before
 * retrying instead of overwriting the newer revision.
 */
export function conflictRevision(error: unknown): number | undefined {
	const revision = (error as { data?: { revision?: unknown } } | undefined)?.data?.revision;
	return typeof revision === "number" && Number.isSafeInteger(revision) ? revision : undefined;
}

/** The server's stable error code (`course_conflict`, `suggestion_stale`, …). */
export function courseErrorCode(error: unknown): string | undefined {
	const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
	return typeof code === "string" ? code : undefined;
}
