import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { logger } from "../logger.js";
import { isDerivedConceptId } from "../shared/concept-id.js";
import { FileStoreError, readJsonStrict, writeJsonDurable } from "../storage/file-store.js";
import { WriterLockError, acquireWriterLock, type WriterLockHandle } from "../storage/writer-lock.js";
import {
	MAX_CONCEPT_LABEL,
	MAX_COURSE_TITLE,
	MAX_DAILY_MINUTES,
	MAX_DESCRIPTION,
	MAX_ESTIMATED_MINUTES,
	MAX_ID_LIST,
	MAX_PLAN_STAGES,
	MAX_PLAN_TASKS,
	MAX_PLAN_TITLE,
	MAX_RATIONALE,
	MAX_STAGE_DESCRIPTION,
	MAX_STAGE_TASKS,
	MAX_STAGE_TITLE,
	MAX_TARGET_DATE,
	MAX_TASK_TITLE,
	MIN_DAILY_MINUTES,
	MIN_ESTIMATED_MINUTES,
	MIN_TARGET_DATE,
	isCourseStatus,
	isPlanBasis,
	isPlanOrigin,
	isPlanStatus,
	isSafeRecordId,
	isLearningStartStatus,
	isSessionOrigin,
	isSourceBindingStatus,
	isTaskDifficulty,
	isTaskStatus,
	type Course,
	type CourseCounts,
	type CourseDeletionReport,
	type CourseDeletionSessionDetail,
	type CourseDeletionTaskDetail,
	type CourseGoalBinding,
	type CourseSessionBinding,
	type CourseSessionOrigin,
	type CourseSourceBinding,
	type CourseStatus,
	type CourseStudySettings,
	type DeletionBlocker,
	type DeletionOutcome,
	type LearningStart,
	type LearningTask,
	type LearningTaskStatus,
	type PlanAdjustmentEvidence,
	type PlanAdjustmentRecord,
	type PlanAdjustmentType,
	type PlanDeletionReport,
	type PlanGeneration,
	type PlanStage,
	type StudyPlan,
	type StudyPlanOrigin,
	type StudyPlanStatus,
	type TaskDifficulty,
	type TaskSourceRef,
} from "./types.js";

/**
 * Single owner of the course data in `<dataDir>/courses/state.json`.
 *
 * Why one file: every relation (course ↔ goal, plan, task, session, source) is
 * read-modify-write state whose invariants span collections — a session binding
 * must not name a missing course, a task's plan must belong to the same course.
 * Splitting them across files would create several partial write paths and
 * allow exactly those broken states. One atomic replace per mutation keeps the
 * whole relation set consistent.
 *
 * Concurrency contract (same discipline as `shared/session-meta-store.ts`):
 * - every read-modify-write runs on one in-process queue keyed by the file path;
 * - cross-process exclusivity comes from the data-directory writer lock, which
 *   is acquired before the first write (or asserted when a handle is injected)
 *   and re-checked before every write;
 * - writes are atomic and durable, so a crash leaves the previous or the next
 *   complete state, never a torn one.
 *
 * Legacy data: there is no older course file to migrate. A missing file is an
 * empty state (no courses yet), never an error; sessions and sources created
 * before E4.1 simply have no binding and stay 「未归类」. Nothing in this store
 * infers a course from a title, a chat topic or a session's content.
 */

const COURSE_STATE_FILE = join("courses", "state.json");

export type CourseStoreErrorCode =
	| "COURSE_INVALID"
	| "COURSE_CORRUPT"
	| "COURSE_UNREADABLE"
	| "COURSE_IO"
	| "COURSE_NOT_FOUND"
	| "COURSE_CONFLICT"
	| "COURSE_SESSION_CONFLICT"
	| "COURSE_TASK_PLAN_MISMATCH"
	/** E4.7-R1: an archived course cannot gain new learning activity. */
	| "COURSE_ARCHIVED"
	| "COURSE_WRITER_LOCK"
	| "COURSE_LOCK_LOST"
	| "COURSE_CLOSED";

export class CourseStoreError extends Error {
	readonly code: CourseStoreErrorCode;
	/** Present on a plan revision conflict so a client can re-read instead of guessing. */
	readonly currentRevision?: number;
	/**
	 * Present on a refused delete: every concrete reason the record must be
	 * archived instead. The route forwards these verbatim in its 409 payload,
	 * so a client never has to parse one generic message.
	 */
	readonly blockers?: DeletionBlocker[];

	constructor(
		code: CourseStoreErrorCode,
		message: string,
		details: { currentRevision?: number; blockers?: DeletionBlocker[] } = {},
	) {
		super(message);
		this.name = "CourseStoreError";
		this.code = code;
		if (details.currentRevision !== undefined) this.currentRevision = details.currentRevision;
		if (details.blockers !== undefined) this.blockers = details.blockers;
	}
}

export interface CourseStateFile {
	schema_version: 1;
	/** Monotonic per-file write counter; diagnostics and optimistic guards. */
	revision: number;
	courses: Course[];
	goal_bindings: CourseGoalBinding[];
	plans: StudyPlan[];
	/** E4.3a: phases of a plan. Absent in a pre-E4.3 file and read as []. */
	stages: PlanStage[];
	tasks: LearningTask[];
	session_bindings: CourseSessionBinding[];
	source_bindings: CourseSourceBinding[];
	/** E4.3a: per-course daily budget. Absent in a pre-E4.3 file and read as []. */
	study_settings: CourseStudySettings[];
	/** E4.4a: 「开始学习」 attempts. Absent in a pre-E4.4 file and read as []. */
	learning_starts: LearningStart[];
}

export interface CourseStoreOptions {
	dataDir: string;
	/** Handle from a process that already owns the writer lock for `dataDir`. */
	lock?: WriterLockHandle;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

export interface CreateCourseInput {
	title: string;
	description?: string;
	status?: CourseStatus;
}

export interface UpdateCourseInput {
	title?: string;
	description?: string;
	status?: CourseStatus;
}

export interface CreatePlanInput {
	title: string;
	description?: string;
	goalId?: string | null;
	status?: StudyPlanStatus;
	origin?: StudyPlanOrigin;
	/** `YYYY-MM-DD`; omitted when the learner has no deadline. */
	targetDate?: string | null;
	/** Daily budget snapshot; omitted when the course default should apply. */
	dailyMinutes?: number | null;
}

export interface UpdatePlanInput {
	title?: string;
	description?: string;
	status?: StudyPlanStatus;
	goalId?: string | null;
	targetDate?: string | null;
	dailyMinutes?: number | null;
}

/** One task inside a stage payload. `task_id` present = update an existing row. */
export interface TaskDraft {
	task_id?: string | null;
	title: string;
	conceptIds?: string[];
	conceptLabels?: string[];
	sourceIds?: string[];
	sourceRefs?: TaskSourceRef[];
	estimatedMinutes?: number | null;
	difficulty?: TaskDifficulty;
	rationale?: string;
	status?: LearningTaskStatus;
}

export interface StageDraft {
	stage_id?: string | null;
	title: string;
	description?: string;
	tasks?: TaskDraft[];
}

/** Atomic plan creation: the plan, its stages and its tasks land together. */
export interface CreatePlanStructureInput extends CreatePlanInput {
	stages?: StageDraft[];
	/** Tasks without a stage. Order follows the array. */
	tasks?: TaskDraft[];
}

/** Atomic draft replacement. Tasks absent from the payload are removed. */
export interface ReplacePlanDraftInput {
	expectedRevision: number;
	title?: string;
	description?: string;
	goalId?: string | null;
	targetDate?: string | null;
	dailyMinutes?: number | null;
	stages: StageDraft[];
	tasks?: TaskDraft[];
}

export interface SaveGeneratedPlanInput {
	title: string;
	description?: string;
	goalId?: string | null;
	targetDate?: string | null;
	dailyMinutes?: number | null;
	generation: PlanGeneration;
	stages: Array<{
		title: string;
		description?: string;
		tasks: Array<{
			title: string;
			conceptIds?: string[];
			conceptLabels?: string[];
			sourceIds?: string[];
			sourceRefs?: TaskSourceRef[];
			estimatedMinutes?: number | null;
			difficulty?: TaskDifficulty;
			rationale?: string;
		}>;
	}>;
}

export interface SaveGeneratedPlanResult {
	plan: StudyPlan;
	stages: PlanStage[];
	tasks: LearningTask[];
	/** False when the same request/fingerprint already produced this plan. */
	created: boolean;
}

export type GeneratedPlanLookup =
	| { status: "none" }
	| {
		status: "found";
		plan: StudyPlan;
		stages: PlanStage[];
		tasks: LearningTask[];
		matched: "request_id" | "fingerprint";
	}
	| { status: "conflict"; plan: StudyPlan };

export interface ConfirmPlanInput {
	expectedRevision: number;
	/** Required when another plan of the course is already active. */
	replaceActive?: boolean;
}

export interface ReorderTasksInput {
	expectedRevision: number;
	/** Every task id of the plan, in the new order. Partial lists are refused. */
	taskIds: string[];
}

/** Stage-only replacement: titles/order change, tasks stay where they are. */
export interface ReplaceStagesInput {
	expectedRevision: number;
	stages: Array<{ stage_id?: string | null; title: string; description?: string }>;
}

export interface PlanAdjustmentInput {
	expectedRevision: number;
	suggestionId: string;
	type: PlanAdjustmentType;
	/** Target task the suggestion was computed for. */
	taskId?: string;
	/** For `reorder_task`: move `taskId` before this task. */
	beforeTaskId?: string;
	/** Concept the inserted review/practice task is about. */
	conceptId?: string;
	conceptLabel?: string;
	reasonCode: string;
	evidence?: PlanAdjustmentEvidence;
	/** For `adjust_difficulty`. */
	difficulty?: TaskDifficulty;
}

export interface CreateTaskInput {
	title: string;
	planId?: string | null;
	stageId?: string | null;
	conceptIds?: string[];
	conceptLabels?: string[];
	sourceIds?: string[];
	sourceRefs?: TaskSourceRef[];
	estimatedMinutes?: number | null;
	difficulty?: TaskDifficulty;
	rationale?: string;
	status?: LearningTaskStatus;
}

export interface UpdateTaskInput {
	title?: string;
	status?: LearningTaskStatus;
	planId?: string | null;
	stageId?: string | null;
	conceptIds?: string[];
	conceptLabels?: string[];
	sourceIds?: string[];
	sourceRefs?: TaskSourceRef[];
	estimatedMinutes?: number | null;
	difficulty?: TaskDifficulty;
	rationale?: string;
	/** 0-based insert position; other tasks shift. */
	order?: number;
	/**
	 * Source plan revision for a cross-plan move or an order change. The route
	 * requires it when `planId` moves the task to another plan, so a stale
	 * client cannot append into a plan that changed since it was read.
	 */
	expectedPlanRevision?: number;
	/** Target plan revision, checked when the caller supplies it. */
	expectedTargetRevision?: number;
}

export interface BindSessionInput {
	courseId: string;
	sessionId: string;
	taskId?: string | null;
	origin?: CourseSessionOrigin;
}

/** Consistent view of one course and every explicit relation it owns. */
export interface CourseSnapshot {
	course: Course;
	counts: CourseCounts;
	goals: CourseGoalBinding[];
	plans: StudyPlan[];
	stages: PlanStage[];
	tasks: LearningTask[];
	sessions: CourseSessionBinding[];
	sources: CourseSourceBinding[];
}

export interface BindingResult<T> {
	binding: T;
	/** False when an identical binding already existed (idempotent retry). */
	created: boolean;
}

/**
 * Everything the four memory layers need to know about one session's course.
 *
 * Resolved from a single state read so a concurrent binding write cannot make
 * the course and its source set disagree inside one request. `sourceIds`
 * contains active source bindings only: a detached document is history, not
 * retrieval scope.
 */
export interface CourseSessionContext {
	binding: CourseSessionBinding;
	course: Course;
	task: LearningTask | null;
	sourceIds: string[];
	goalIds: string[];
}

/**
 * What a delete is about to touch, handed to the external evidence probe.
 *
 * The store owns every course relation but not L1 mastery states or B2 learning
 * records; those owners are asked inside the same write transaction so a
 * concurrent 「开始学习」 cannot slip an evidence-bearing session between the
 * check and the delete.
 */
export interface DeletionEvidenceContext {
	target: "course" | "plan";
	courseId: string;
	/** Present when the target is one plan. */
	planId?: string;
	/** Sessions bound to the target; also a blocker in their own right. */
	sessionIds: string[];
	/** Tasks of the plan being deleted (empty for a course delete). */
	taskIds: string[];
}

export interface CourseDeletionOptions {
	/**
	 * Read-only probe for evidence owned by other modules (B2 formal attempts,
	 * L1 course-scoped mastery states). It runs inside the store's serialized
	 * write transaction and may only add blockers, never remove one.
	 */
	externalBlockers?: (context: DeletionEvidenceContext) => Promise<DeletionBlocker[]>;
}

/** One queue per file path, shared by every store instance in this process. */
const fileQueues = new Map<string, Promise<unknown>>();

function runExclusive<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const previous = fileQueues.get(filePath) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const tail = run.then(() => undefined, () => undefined);
	fileQueues.set(filePath, tail);
	void tail.finally(() => {
		if (fileQueues.get(filePath) === tail) fileQueues.delete(filePath);
	});
	return run;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState(): CourseStateFile {
	return {
		schema_version: 1,
		revision: 0,
		courses: [],
		goal_bindings: [],
		plans: [],
		stages: [],
		tasks: [],
		session_bindings: [],
		source_bindings: [],
		study_settings: [],
		learning_starts: [],
	};
}

function mapFileStoreError(err: unknown): CourseStoreError {
	if (err instanceof FileStoreError) {
		if (err.code === "FILE_CORRUPT") return new CourseStoreError("COURSE_CORRUPT", "课程数据不是合法 JSON，已停止写入");
		if (err.code === "FILE_UNREADABLE") return new CourseStoreError("COURSE_UNREADABLE", "课程数据读取失败");
		return new CourseStoreError("COURSE_IO", "课程数据写入失败");
	}
	if (err instanceof CourseStoreError) return err;
	logger.warn({ err }, "unexpected course store failure");
	return new CourseStoreError("COURSE_IO", "课程数据操作失败");
}

function mapLockError(err: unknown): CourseStoreError {
	if (err instanceof WriterLockError) {
		if (err.code === "WRITER_LOCK_HELD") return new CourseStoreError("COURSE_WRITER_LOCK", "数据目录已被另一个进程写入");
		if (err.code === "WRITER_LOCK_LOST") return new CourseStoreError("COURSE_LOCK_LOST", "写入权已丢失，已停止写入");
		return new CourseStoreError("COURSE_WRITER_LOCK", "写入锁不可用，已停止写入");
	}
	logger.warn({ err }, "failed to acquire course writer lock");
	return new CourseStoreError("COURSE_WRITER_LOCK", "无法取得写入权");
}

function invalid(message: string): CourseStoreError {
	return new CourseStoreError("COURSE_INVALID", message);
}

function normalizeTitle(value: unknown, label: string, max: number): string {
	if (typeof value !== "string") throw invalid(`${label}必须是字符串`);
	const title = value.trim();
	if (!title) throw invalid(`${label}不能为空`);
	if (title.length > max) throw invalid(`${label}过长`);
	return title;
}

function normalizeDescription(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw invalid("描述必须是字符串");
	if (value.length > MAX_DESCRIPTION) throw invalid("描述过长");
	return value;
}

/** Optional id: `null`/absent stay absent; anything else must be a safe id. */
function optionalId(value: unknown, label: string): string | null {
	if (value === undefined || value === null) return null;
	if (!isSafeRecordId(value)) throw invalid(`${label}不合法`);
	return value;
}

function idList(value: unknown, label: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw invalid(`${label}必须是数组`);
	if (value.length > MAX_ID_LIST) throw invalid(`${label}数量过多`);
	const seen = new Set<string>();
	for (const item of value) {
		if (!isSafeRecordId(item)) throw invalid(`${label}包含不合法的 ID`);
		seen.add(item);
	}
	return [...seen];
}

function nextId(prefix: string): string {
	return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Keep the start log bounded: it is an idempotency window, not history. */
const MAX_LEARNING_STARTS = 200;
const LEARNING_START_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function pruneLearningStarts(state: CourseStateFile, nowIso: string): void {
	const cutoff = Date.parse(nowIso) - LEARNING_START_RETENTION_MS;
	const kept = state.learning_starts.filter((record) => {
		const at = Date.parse(record.updated_at);
		return !Number.isFinite(at) || at >= cutoff;
	});
	// Oldest first: a duplicate click is recent, so trimming from the front can
	// never drop the record it is about to replay.
	state.learning_starts = kept.length > MAX_LEARNING_STARTS
		? kept.slice(kept.length - MAX_LEARNING_STARTS)
		: kept;
}

/** `null` = no estimate. A stored value must be a whole number of minutes. */
function optionalMinutes(value: unknown, label: string): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(`${label}必须是整数分钟`);
	if (value < MIN_ESTIMATED_MINUTES || value > MAX_ESTIMATED_MINUTES) {
		throw invalid(`${label}超出允许范围`);
	}
	return value;
}

function optionalDailyMinutes(value: unknown): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid("每日学习时间必须是整数分钟");
	if (value < MIN_DAILY_MINUTES || value > MAX_DAILY_MINUTES) throw invalid("每日学习时间超出允许范围");
	return value;
}

function optionalTargetDate(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (!isIsoDate(value)) throw invalid("目标完成日期必须是 YYYY-MM-DD");
	return value;
}

function normalizeDifficulty(value: unknown): TaskDifficulty {
	if (value === undefined || value === null) return "standard";
	if (!isTaskDifficulty(value)) throw invalid("任务难度不合法");
	return value;
}

function normalizeRationale(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw invalid("任务说明必须是字符串");
	if (value.length > MAX_RATIONALE) throw invalid("任务说明过长");
	const trimmed = value.trim();
	return trimmed || undefined;
}

function conceptLabelList(value: unknown, conceptIds?: readonly string[]): string[] {
	if (!Array.isArray(value)) throw invalid("知识点名称必须是数组");
	if (conceptIds !== undefined && value.length !== conceptIds.length) {
		throw invalid("知识点名称必须与知识点 ID 一一对应");
	}
	const labels: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") throw invalid("知识点名称必须是字符串");
		if (item.length > MAX_CONCEPT_LABEL) throw invalid("知识点名称过长");
		labels.push(item.trim());
	}
	return labels;
}

/**
 * Validate a citation. Only the server builds these (from material units), but
 * a persisted file is still untrusted input: the path must be a wiki-relative
 * page path and page numbers must be positive integers.
 */
function sourceRefList(value: unknown): TaskSourceRef[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw invalid("来源引用必须是数组");
	if (value.length > MAX_ID_LIST) throw invalid("来源引用数量过多");
	const refs: TaskSourceRef[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid("来源引用条目不合法");
		const entry = item as Record<string, unknown>;
		if (!isSafeRecordId(entry.source_id)) throw invalid("来源引用 ID 不合法");
		if (typeof entry.page_path !== "string" || !entry.page_path || entry.page_path.length > 512) {
			throw invalid("来源引用路径不合法");
		}
		const page = (candidate: unknown): number | undefined =>
			typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
		const pageStart = page(entry.page_start);
		const pageEnd = page(entry.page_end);
		refs.push({
			source_id: entry.source_id,
			page_path: entry.page_path,
			...(typeof entry.heading_path === "string" && entry.heading_path.trim()
				? { heading_path: entry.heading_path.trim().slice(0, 300) }
				: {}),
			...(pageStart !== undefined ? { page_start: pageStart } : {}),
			...(pageEnd !== undefined ? { page_end: pageEnd } : {}),
			...(typeof entry.unit_id === "string" ? { unit_id: entry.unit_id } : {}),
		});
	}
	return refs;
}

function sortTasks(tasks: Iterable<LearningTask>): LearningTask[] {
	return [...tasks].sort((a, b) => (a.order - b.order) || a.created_at.localeCompare(b.created_at)
		|| a.task_id.localeCompare(b.task_id));
}

/**
 * Validate a persisted state file. A file that parses but has the wrong shape
 * is corruption, not "empty": treating it as empty would let the next write
 * erase the user's courses.
 */
function validateState(value: unknown): CourseStateFile {
	if (!isPlainObject(value)) throw new CourseStoreError("COURSE_CORRUPT", "课程数据结构不受支持，已停止写入");
	const lists = ["courses", "goal_bindings", "plans", "tasks", "session_bindings", "source_bindings"] as const;
	for (const key of lists) {
		if (!Array.isArray(value[key])) throw new CourseStoreError("COURSE_CORRUPT", "课程数据结构不受支持，已停止写入");
	}
	if (value.schema_version !== 1) throw new CourseStoreError("COURSE_CORRUPT", "课程数据版本不受支持，已停止写入");
	const state = value as unknown as CourseStateFile;
	// E4.3a added two lists. A file written before them is a valid, complete
	// state with no phases and no per-course budget — not corruption.
	if (!Array.isArray(state.stages)) state.stages = [];
	if (!Array.isArray(state.study_settings)) state.study_settings = [];
	// E4.4a added learning-start records. A pre-E4.4 file simply has none.
	if (!Array.isArray(state.learning_starts)) state.learning_starts = [];
	state.learning_starts = state.learning_starts
		.filter((record) => isPlainObject(record) && isSafeRecordId(record.request_id))
		.map((record) => ({
			...record,
			task_id: record.task_id ?? null,
			session_id: typeof record.session_id === "string" ? record.session_id : null,
			status: isLearningStartStatus(record.status) ? record.status : "created",
			updated_at: typeof record.updated_at === "string" && record.updated_at ? record.updated_at : record.created_at,
		}));
	// Shape of each record is normalized on read so an older record missing a
	// field added later still loads (defaults below never invent ownership).
	state.courses = state.courses.map((course) => ({
		...course,
		description: typeof course.description === "string" ? course.description : "",
	}));
	state.plans = state.plans.map((plan) => ({
		...plan,
		description: typeof plan.description === "string" ? plan.description : "",
		goal_id: plan.goal_id ?? null,
		revision: Number.isSafeInteger(plan.revision) && plan.revision >= 1 ? plan.revision : 1,
		...(isIsoDate(plan.target_date) ? { target_date: plan.target_date } : { target_date: undefined }),
		...(Number.isSafeInteger(plan.daily_minutes) && (plan.daily_minutes as number) >= MIN_DAILY_MINUTES
			? { daily_minutes: plan.daily_minutes }
			: { daily_minutes: undefined }),
		...(Array.isArray(plan.adjustments) ? { adjustments: plan.adjustments } : {}),
	}));
	// Old tasks have no `order`: their meaning was "created_at ascending". Assign
	// the next free slot in that same order and keep any already-stored order,
	// so upgrading never reshuffles a plan the learner already sees.
	const taskGroups = new Map<string, LearningTask[]>();
	for (const task of state.tasks) {
		task.plan_id = task.plan_id ?? null;
		task.stage_id = task.stage_id ?? null;
		task.concept_ids = Array.isArray(task.concept_ids) ? task.concept_ids : [];
		task.source_ids = Array.isArray(task.source_ids) ? task.source_ids : [];
		task.concept_labels = Array.isArray(task.concept_labels) ? task.concept_labels : undefined;
		task.source_refs = Array.isArray(task.source_refs) ? task.source_refs : undefined;
		task.difficulty = isTaskDifficulty(task.difficulty) ? task.difficulty : "standard";
		task.estimated_minutes = Number.isSafeInteger(task.estimated_minutes)
			&& (task.estimated_minutes as number) >= MIN_ESTIMATED_MINUTES
			&& (task.estimated_minutes as number) <= MAX_ESTIMATED_MINUTES
			? task.estimated_minutes
			: null;
		task.rationale = typeof task.rationale === "string" ? task.rationale : undefined;
		task.completed_at = typeof task.completed_at === "string" ? task.completed_at : undefined;
		const key = `${task.course_id}\u0000${task.plan_id ?? ""}`;
		const group = taskGroups.get(key) ?? [];
		group.push(task);
		taskGroups.set(key, group);
	}
	for (const group of taskGroups.values()) {
		const ordered = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at)
			|| a.task_id.localeCompare(b.task_id));
		const used = new Set<number>();
		for (const task of ordered) {
			if (Number.isSafeInteger(task.order) && task.order >= 0) used.add(task.order);
		}
		let cursor = used.size > 0 ? Math.max(...used) + 1 : 0;
		for (const task of ordered) {
			if (Number.isSafeInteger(task.order) && task.order >= 0) continue;
			while (used.has(cursor)) cursor += 1;
			task.order = cursor;
			used.add(cursor);
			cursor += 1;
		}
	}
	state.stages = state.stages.map((stage) => ({
		...stage,
		description: typeof stage.description === "string" ? stage.description : "",
		order: Number.isSafeInteger(stage.order) && stage.order >= 0 ? stage.order : 0,
	}));
	state.session_bindings = state.session_bindings.map((binding) => ({
		...binding,
		task_id: binding.task_id ?? null,
	}));
	// E4.1a: source bindings gained an association state. A pre-E4.1a record had
	// no status; it was an active association by construction, so that is the
	// only safe default. `updated_at` mirrors `created_at` until a real change.
	state.source_bindings = state.source_bindings.map((binding) => ({
		...binding,
		status: isSourceBindingStatus(binding.status) ? binding.status : "active",
		updated_at: typeof binding.updated_at === "string" && binding.updated_at
			? binding.updated_at
			: binding.created_at,
	}));
	state.study_settings = state.study_settings
		.filter((settings) => settings && typeof settings.course_id === "string")
		.map((settings) => ({
			course_id: settings.course_id,
			daily_minutes: Number.isSafeInteger(settings.daily_minutes)
				&& settings.daily_minutes >= MIN_DAILY_MINUTES
				&& settings.daily_minutes <= MAX_DAILY_MINUTES
				? settings.daily_minutes
				: 30,
			updated_at: typeof settings.updated_at === "string" ? settings.updated_at : new Date(0).toISOString(),
		}));
	return state;
}

/** `YYYY-MM-DD` inside a sane range. A full timestamp is not accepted here. */
function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	if (value < MIN_TARGET_DATE || value > MAX_TARGET_DATE) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export class CourseStore {
	readonly dataDir: string;
	readonly filePath: string;

	private readonly injectedLock?: WriterLockHandle;
	private ownLock?: WriterLockHandle;
	private readonly now: () => Date;
	private closed = false;

	constructor(options: CourseStoreOptions) {
		this.dataDir = options.dataDir;
		this.filePath = join(options.dataDir, COURSE_STATE_FILE);
		this.injectedLock = options.lock;
		this.now = options.now ?? (() => new Date());
	}

	// ------------------------------------------------------------------
	// Reads
	// ------------------------------------------------------------------

	async readState(): Promise<CourseStateFile> {
		const read = await readJsonStrict<unknown>(this.filePath).catch((err: unknown) => {
			throw mapFileStoreError(err);
		});
		if (!read.found) return emptyState();
		return validateState(read.value);
	}

	async listCourses(): Promise<Course[]> {
		const state = await this.readState();
		return [...state.courses].sort((a, b) => a.created_at.localeCompare(b.created_at));
	}

	async getCourse(courseId: string): Promise<Course | undefined> {
		if (!isSafeRecordId(courseId)) return undefined;
		const state = await this.readState();
		return state.courses.find((course) => course.course_id === courseId);
	}

	async counts(courseId: string): Promise<CourseCounts> {
		return countsOf(await this.readState(), courseId);
	}

	/**
	 * One read for a course detail view. Every relation in the response comes
	 * from the same state snapshot, so counts and lists can never disagree
	 * because a concurrent write landed between two separate reads.
	 */
	async snapshot(courseId: string): Promise<CourseSnapshot | undefined> {
		const state = await this.readState();
		const course = state.courses.find((candidate) => candidate.course_id === courseId);
		if (!course) return undefined;
		return {
			course: { ...course },
			counts: countsOf(state, courseId),
			goals: state.goal_bindings.filter((binding) => binding.course_id === courseId),
			plans: state.plans
				.filter((plan) => plan.course_id === courseId)
				.sort((a, b) => a.created_at.localeCompare(b.created_at)),
			stages: state.stages
				.filter((stage) => stage.course_id === courseId)
				.sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at)),
			tasks: sortTasks(state.tasks.filter((task) => task.course_id === courseId)),
			sessions: state.session_bindings
				.filter((binding) => binding.course_id === courseId)
				.sort((a, b) => a.created_at.localeCompare(b.created_at)),
			sources: state.source_bindings.filter(
				(binding) => binding.course_id === courseId && binding.status === "active",
			),
		};
	}

	async listGoalBindings(courseId: string): Promise<CourseGoalBinding[]> {
		const state = await this.readState();
		return state.goal_bindings.filter((binding) => binding.course_id === courseId);
	}

	async listPlans(courseId: string): Promise<StudyPlan[]> {
		const state = await this.readState();
		return state.plans
			.filter((plan) => plan.course_id === courseId)
			.sort((a, b) => a.created_at.localeCompare(b.created_at));
	}

	async getPlan(courseId: string, planId: string): Promise<StudyPlan | undefined> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) return undefined;
		const state = await this.readState();
		return state.plans.find((plan) => plan.course_id === courseId && plan.plan_id === planId);
	}

	async listStages(courseId: string, planId?: string): Promise<PlanStage[]> {
		const state = await this.readState();
		return state.stages
			.filter((stage) => stage.course_id === courseId && (planId === undefined || stage.plan_id === planId))
			.sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));
	}

	async listTasks(courseId: string, planId?: string | null): Promise<LearningTask[]> {
		const state = await this.readState();
		return sortTasks(state.tasks.filter(
			(task) => task.course_id === courseId && (planId === undefined || task.plan_id === planId),
		));
	}

	async getTask(courseId: string, taskId: string): Promise<LearningTask | undefined> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(taskId)) return undefined;
		const state = await this.readState();
		return state.tasks.find((task) => task.course_id === courseId && task.task_id === taskId);
	}

	async getStudySettings(courseId: string): Promise<CourseStudySettings | undefined> {
		if (!isSafeRecordId(courseId)) return undefined;
		const state = await this.readState();
		return state.study_settings.find((settings) => settings.course_id === courseId);
	}

	async listStudySettings(): Promise<CourseStudySettings[]> {
		const state = await this.readState();
		return [...state.study_settings];
	}

	async setStudySettings(courseId: string, dailyMinutes: number): Promise<CourseStudySettings> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		const minutes = optionalDailyMinutes(dailyMinutes);
		if (minutes === null) throw invalid("每日学习时间不能为空");
		return this.mutate((state) => {
			findCourse(state, courseId);
			const now = this.now().toISOString();
			const existing = state.study_settings.find((settings) => settings.course_id === courseId);
			if (existing) {
				existing.daily_minutes = minutes;
				existing.updated_at = now;
				return { ...existing };
			}
			const settings: CourseStudySettings = { course_id: courseId, daily_minutes: minutes, updated_at: now };
			state.study_settings.push(settings);
			return settings;
		});
	}

	async listSessionBindings(courseId: string): Promise<CourseSessionBinding[]> {
		const state = await this.readState();
		return state.session_bindings
			.filter((binding) => binding.course_id === courseId)
			.sort((a, b) => a.created_at.localeCompare(b.created_at));
	}

	async listSourceBindings(courseId: string, options: { includeDetached?: boolean } = {}): Promise<CourseSourceBinding[]> {
		const state = await this.readState();
		return state.source_bindings
			.filter((binding) => binding.course_id === courseId
				&& (options.includeDetached === true || binding.status === "active"));
	}

	/** One explicit source binding, including a detached (historical) one. */
	async getSourceBinding(courseId: string, sourceId: string): Promise<CourseSourceBinding | undefined> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(sourceId)) return undefined;
		const state = await this.readState();
		return state.source_bindings.find(
			(binding) => binding.course_id === courseId && binding.source_id === sourceId,
		);
	}

	/** Binding for a session, or `undefined` for a legacy/unclassified session. */
	async getSessionBinding(sessionId: string): Promise<CourseSessionBinding | undefined> {
		if (!isSafeRecordId(sessionId)) return undefined;
		const state = await this.readState();
		return state.session_bindings.find((binding) => binding.session_id === sessionId);
	}

	/**
	 * E4.7-R1 — one read mapping every bound session to its course scope.
	 *
	 * The session list needs to know, for each conversation, whether its parent
	 * course is archived. Asking `getSessionContext` per row would re-read and
	 * re-validate the whole state file once per session, so the list endpoint
	 * uses this single pass instead.
	 */
	async sessionCourseScopes(): Promise<Map<string, { course_id: string; title: string; archived: boolean }>> {
		const state = await this.readState();
		const courses = new Map(state.courses.map((course) => [course.course_id, course]));
		const scopes = new Map<string, { course_id: string; title: string; archived: boolean }>();
		for (const binding of state.session_bindings) {
			const course = courses.get(binding.course_id);
			if (!course) continue;
			scopes.set(binding.session_id, {
				course_id: course.course_id,
				title: course.title,
				archived: course.status === "archived",
			});
		}
		return scopes;
	}

	/**
	 * One-read course context for a session: binding, course, task, active
	 * source ids and bound goal ids. Returns `undefined` when the session has no
	 * binding — the caller reports 「未归类」 and must not guess a course.
	 *
	 * A binding that names a missing course is an inconsistent relation, not an
	 * unclassified session: it throws so the caller surfaces a conflict instead
	 * of silently widening the scope to the whole knowledge base.
	 */
	async getSessionContext(sessionId: string): Promise<CourseSessionContext | undefined> {
		if (!isSafeRecordId(sessionId)) return undefined;
		const state = await this.readState();
		const binding = state.session_bindings.find((candidate) => candidate.session_id === sessionId);
		if (!binding) return undefined;
		const course = state.courses.find((candidate) => candidate.course_id === binding.course_id);
		if (!course) throw new CourseStoreError("COURSE_CONFLICT", "会话所属课程不存在，课程归属不一致");
		const task = binding.task_id
			? state.tasks.find((candidate) => candidate.task_id === binding.task_id && candidate.course_id === course.course_id) ?? null
			: null;
		return {
			binding: { ...binding },
			course: { ...course },
			task: task ? { ...task } : null,
			sourceIds: state.source_bindings
				.filter((candidate) => candidate.course_id === course.course_id && candidate.status === "active")
				.map((candidate) => candidate.source_id),
			goalIds: state.goal_bindings
				.filter((candidate) => candidate.course_id === course.course_id)
				.map((candidate) => candidate.goal_id),
		};
	}

	// ------------------------------------------------------------------
	// Course mutations
	// ------------------------------------------------------------------

	async createCourse(input: CreateCourseInput): Promise<Course> {
		const title = normalizeTitle(input.title, "课程标题", MAX_COURSE_TITLE);
		const description = normalizeDescription(input.description);
		const status = input.status === undefined ? "in_progress" : input.status;
		if (!isCourseStatus(status)) throw invalid("课程状态不合法");
		const now = this.now().toISOString();
		const course: Course = {
			course_id: nextId("course"),
			title,
			description,
			status,
			created_at: now,
			updated_at: now,
		};
		return this.mutate((state) => {
			state.courses.push(course);
			return course;
		});
	}

	async updateCourse(courseId: string, patch: UpdateCourseInput): Promise<Course> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		const title = patch.title === undefined ? undefined : normalizeTitle(patch.title, "课程标题", MAX_COURSE_TITLE);
		const description = patch.description === undefined ? undefined : normalizeDescription(patch.description);
		if (patch.status !== undefined && !isCourseStatus(patch.status)) throw invalid("课程状态不合法");
		return this.mutate((state) => {
			const course = findCourse(state, courseId);
			// E4.7-R1: leaving the archive is a formal restore, not an incidental
			// status patch. Without this guard `PATCH {status:"in_progress"}` would
			// bypass `restoreCourse`, resurrecting a course into today's plan while
			// skipping the restore semantics (paused, no auto-resume).
			if (course.status === "archived" && patch.status !== undefined && patch.status !== "archived") {
				throw new CourseStoreError(
					"COURSE_ARCHIVED",
					"课程已归档，不能直接修改状态；请先在「归档课程」中恢复课程。",
				);
			}
			if (title !== undefined) course.title = title;
			if (description !== undefined) course.description = description;
			if (patch.status !== undefined) course.status = patch.status;
			course.updated_at = this.now().toISOString();
			return { ...course };
		});
	}

	/**
	 * Archive a course. Archiving never deletes: goals, plans, tasks, sessions
	 * and source bindings stay readable so history and L1/B2 data are intact.
	 */
	async archiveCourse(courseId: string): Promise<Course> {
		return this.updateCourse(courseId, { status: "archived" });
	}

	/**
	 * E4.7-R1 — restore an archived course.
	 *
	 * Always `paused`, never `in_progress`: the pre-archive status was never
	 * stored, and restoring straight to "in progress" would put the course back
	 * into today's plan and re-activate its plan without the learner asking. A
	 * paused course keeps plans, tasks, material and session links intact, and
	 * the learner resumes it explicitly.
	 *
	 * Idempotent: restoring a course that is not archived changes nothing.
	 */
	async restoreCourse(courseId: string): Promise<Course> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		return this.mutateOptional((state) => {
			const course = findCourse(state, courseId);
			if (course.status !== "archived") return { write: false, result: { ...course } };
			course.status = "paused";
			course.updated_at = this.now().toISOString();
			return { write: true, result: { ...course } };
		});
	}

	/**
	 * E4.7-R1 — resume a paused course.
	 *
	 * Restoring an archived course always lands on `paused`, which would be a
	 * dead end without this explicit step: the card disables 开始学习 and the
	 * daily plan skips paused courses. Resuming changes the status only — it
	 * creates no session, binding or learning record, so 继续课程 never starts
	 * studying on the learner's behalf.
	 *
	 * Idempotent for an already in-progress course; archived courses must go
	 * through `restoreCourse`, completed courses cannot be reopened here.
	 */
	async resumeCourse(courseId: string): Promise<Course> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		return this.mutate((state) => {
			const course = findCourse(state, courseId);
			if (course.status === "archived") {
				throw new CourseStoreError(
					"COURSE_ARCHIVED",
					"课程已归档，请先在「归档课程」中恢复课程，再继续课程。",
				);
			}
			if (course.status === "in_progress") return { ...course };
			if (course.status !== "paused") {
				throw new CourseStoreError("COURSE_CONFLICT", "只有已暂停的课程可以继续");
			}
			course.status = "in_progress";
			course.updated_at = this.now().toISOString();
			return { ...course };
		});
	}

	/**
	 * E4.7 — preflight for a permanent course delete.
	 *
	 * Reads one state snapshot, so the counts the confirmation dialog shows are
	 * exactly the rows a delete would remove. Blockers owned by other modules
	 * (B2 evidence, L1 mastery) are added by the caller through `externalBlockers`
	 * — the dialog and the delete therefore always agree.
	 */
	async inspectCourseDeletion(courseId: string, options: CourseDeletionOptions = {}): Promise<CourseDeletionReport> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		const state = await this.readState();
		const report = courseDeletionReport(state, courseId, this.now().getTime());
		if (options.externalBlockers) {
			// Always probed, even when a local blocker already applies: the dialog
			// must be able to list every reason at once instead of revealing the
			// B2/L1 ones only after the first reason is resolved.
			const external = await options.externalBlockers({
				target: "course",
				courseId,
				sessionIds: state.session_bindings
					.filter((binding) => binding.course_id === courseId)
					.map((binding) => binding.session_id),
				taskIds: [],
			});
			if (external.length > 0) {
				report.blockers = mergeBlockers(report.blockers, external);
				report.deletable = false;
			}
		}
		return report;
	}

	/**
	 * E4.7 — permanently delete a course that holds no real learning history.
	 *
	 * Everything happens in one `state.json` write, so a crash leaves either the
	 * whole course or none of it:
	 *
	 * - the `Course` row, its plans, stages and (necessarily unstarted) tasks;
	 * - goal bindings and material *associations* (the L2 document itself is
	 *   shared and stays in the manifest/wiki);
	 * - the per-course study settings and 「开始学习」 request records.
	 *
	 * Refused with `COURSE_CONFLICT` + `blockers` when any session, started task,
	 * unfinished start request or external evidence exists: those are history, and
	 * archiving is the only action that keeps L1/B2 intact.
	 *
	 * The external probe runs inside the serialized write transaction, so the
	 * check and the delete cannot be split by a concurrent `learning/start`:
	 * either its reservation is already visible here, or it runs after the
	 * course is gone and fails without creating a binding.
	 */
	async deleteCourse(courseId: string, options: CourseDeletionOptions = {}): Promise<DeletionOutcome> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		return this.mutateGuarded(async (state) => {
			const report = courseDeletionReport(state, courseId, this.now().getTime());
			const blockers = [...report.blockers];
			if (options.externalBlockers) {
				const external = await options.externalBlockers({
					target: "course",
					courseId,
					sessionIds: state.session_bindings
						.filter((binding) => binding.course_id === courseId)
						.map((binding) => binding.session_id),
					taskIds: [],
				});
				blockers.push(...external);
			}
			assertDeletable(blockers, "该课程已有真实学习记录，不能永久删除；请改用归档。");
			const removed = purgeCourse(state, courseId);
			return { write: true, result: { course_id: courseId, removed } };
		});
	}

	// ------------------------------------------------------------------
	// Bindings
	// ------------------------------------------------------------------

	/** Idempotent: the same goal bound twice returns the original binding. */
	async bindGoal(courseId: string, goalId: string): Promise<BindingResult<CourseGoalBinding>> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		if (!isSafeRecordId(goalId)) throw invalid("学习目标 ID 不合法");
		return this.mutate((state) => {
			findCourse(state, courseId);
			const existing = state.goal_bindings.find(
				(binding) => binding.course_id === courseId && binding.goal_id === goalId,
			);
			if (existing) return { binding: existing, created: false };
			const binding: CourseGoalBinding = {
				binding_id: nextId("binding"),
				course_id: courseId,
				goal_id: goalId,
				created_at: this.now().toISOString(),
			};
			state.goal_bindings.push(binding);
			return { binding, created: true };
		});
	}

	async unbindGoal(courseId: string, goalId: string): Promise<boolean> {
		return this.mutate((state) => {
			findCourse(state, courseId);
			const before = state.goal_bindings.length;
			state.goal_bindings = state.goal_bindings.filter(
				(binding) => !(binding.course_id === courseId && binding.goal_id === goalId),
			);
			return state.goal_bindings.length !== before;
		});
	}

	/**
	 * Bind an L2 source to a course. Uploading/indexing a document never calls
	 * this; a source becomes course material only through this explicit call.
	 * The same source may serve several courses (one binding each).
	 *
	 * Re-binding a detached pair reactivates the original record instead of
	 * creating a second binding for the same (course, source) pair.
	 */
	async bindSource(courseId: string, sourceId: string): Promise<BindingResult<CourseSourceBinding>> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		if (!isSafeRecordId(sourceId)) throw invalid("资料来源 ID 不合法");
		return this.mutate((state) => {
			findCourse(state, courseId);
			const existing = state.source_bindings.find(
				(binding) => binding.course_id === courseId && binding.source_id === sourceId,
			);
			if (existing) {
				if (existing.status === "active") return { binding: existing, created: false };
				const now = this.now().toISOString();
				existing.status = "active";
				existing.updated_at = now;
				delete existing.detached_at;
				return { binding: existing, created: false };
			}
			const now = this.now().toISOString();
			const binding: CourseSourceBinding = {
				binding_id: nextId("binding"),
				course_id: courseId,
				source_id: sourceId,
				status: "active",
				created_at: now,
				updated_at: now,
			};
			state.source_bindings.push(binding);
			return { binding, created: true };
		});
	}

	/**
	 * Detach a source from a course. The binding record stays with
	 * `status: "detached"` and a `detached_at` audit stamp, because E4.2 must be
	 * able to tell "never course material" from "was material, later removed".
	 * The L2 manifest, raw file and wiki pages are untouched.
	 */
	async unbindSource(courseId: string, sourceId: string): Promise<boolean> {
		return this.mutate((state) => {
			findCourse(state, courseId);
			const binding = state.source_bindings.find(
				(candidate) => candidate.course_id === courseId
					&& candidate.source_id === sourceId
					&& candidate.status === "active",
			);
			if (!binding) return false;
			const now = this.now().toISOString();
			binding.status = "detached";
			binding.updated_at = now;
			binding.detached_at = now;
			return true;
		});
	}

	/**
	 * Bind a session to a course, exactly once.
	 *
	 * - an identical retry (same course, same task) returns the stored binding,
	 *   so a duplicate click or network retry never creates a second session
	 *   binding;
	 * - a session already bound to another course is refused — re-association
	 *   would silently move history into the wrong course;
	 * - the same course may attach a task to a session that had none (a free
	 *   question later adopted by a task), but never replace an existing task.
	 */
	async bindSession(input: BindSessionInput): Promise<BindingResult<CourseSessionBinding>> {
		if (!isSafeRecordId(input.courseId)) throw invalid("课程 ID 不合法");
		if (!isSafeRecordId(input.sessionId)) throw invalid("会话 ID 不合法");
		const taskId = optionalId(input.taskId, "学习任务 ID");
		const origin = input.origin === undefined ? "manual" : input.origin;
		if (!isSessionOrigin(origin)) throw invalid("会话来源不合法");
		return this.mutate((state) => {
			assertCourseNotArchived(state, input.courseId, "绑定学习会话");
			const task = taskId ? findTask(state, input.courseId, taskId) : null;
			const existing = state.session_bindings.find((binding) => binding.session_id === input.sessionId);
			if (existing) {
				if (existing.course_id !== input.courseId) {
					throw new CourseStoreError("COURSE_SESSION_CONFLICT", "该会话已属于另一门课程，不能改绑");
				}
				if (taskId && !existing.task_id) {
					// E4.6-R1: adopting a task creates a task↔session relation, so
					// the same executability rule applies as for a fresh binding.
					assertTaskPlanExecutable(state, task!);
					// Adopting a task is still a task binding: it must not create
					// the second session for a task that already has one.
					assertTaskHasSingleSession(state, input.courseId, taskId, input.sessionId);
					existing.task_id = taskId;
					return { binding: existing, created: false };
				}
				if (taskId && existing.task_id !== taskId) {
					throw new CourseStoreError("COURSE_SESSION_CONFLICT", "该会话已绑定另一个学习任务，不能改绑");
				}
				return { binding: existing, created: false };
			}
			// E4.6-R1: a session for a plan task is a real learning record, so the
			// plan must be executable. Checked here, inside the write transaction,
			// because the manual-bind route is a second entry point besides
			// `learning/start` and must not be able to start a draft plan's task.
			if (task) assertTaskPlanExecutable(state, task);
			// E4.4-R1: 「一个任务一个默认会话」 is enforced inside the same write
			// transaction as the insert. A caller-side check is not enough: two
			// processes (or a retry after a lost response) can both pass it and
			// then append two bindings.
			if (taskId) assertTaskHasSingleSession(state, input.courseId, taskId, input.sessionId);
			const binding: CourseSessionBinding = {
				binding_id: nextId("binding"),
				course_id: input.courseId,
				session_id: input.sessionId,
				task_id: taskId,
				origin,
				created_at: this.now().toISOString(),
			};
			state.session_bindings.push(binding);
			return { binding, created: true };
		});
	}

	/**
	 * E4.4-R1: report tasks that already have more than one session binding.
	 *
	 * Such records can exist in a file written before this rule. They are
	 * reported, never repaired silently: removing a binding would orphan a
	 * conversation (and possibly its B2 record), and picking a "winner" here
	 * would hide the inconsistency from the learner.
	 */
	async listDuplicateTaskBindings(courseId: string): Promise<Array<{ task_id: string; session_ids: string[] }>> {
		if (!isSafeRecordId(courseId)) return [];
		const state = await this.readState();
		return duplicateTaskBindings(state, courseId);
	}

	/**
	 * Drop a session binding after the session itself is gone.
	 *
	 * Deleting a session is the only way a binding may legitimately disappear:
	 * the record it names no longer exists, so keeping it would make a course
	 * detail list a session that cannot be opened. Idempotent and a no-op for
	 * an unbound session, so a retried delete never rewrites the file.
	 */
	async removeSessionBinding(sessionId: string): Promise<boolean> {
		if (!isSafeRecordId(sessionId)) return false;
		const state = await this.readState();
		if (!state.session_bindings.some((binding) => binding.session_id === sessionId)) return false;
		return this.mutate((current) => {
			const before = current.session_bindings.length;
			current.session_bindings = current.session_bindings.filter((binding) => binding.session_id !== sessionId);
			return current.session_bindings.length !== before;
		});
	}

	// ------------------------------------------------------------------
	// Learning starts (E4.4a)
	// ------------------------------------------------------------------

	async getLearningStart(requestId: string): Promise<LearningStart | undefined> {
		if (!isSafeRecordId(requestId)) return undefined;
		const state = await this.readState();
		const record = state.learning_starts.find((candidate) => candidate.request_id === requestId);
		return record ? { ...record } : undefined;
	}

	/**
	 * Reserve a 「开始学习」 request before any session exists.
	 *
	 * One atomic write guarantees a single attempt per `request_id`: a duplicate
	 * gets the reserved record back (so it can wait/replay rather than create a
	 * second session), and reusing the id for another course/task is a conflict.
	 * The record is the recovery anchor if the process dies between "session
	 * created" and "binding written".
	 */
	async reserveLearningStart(input: {
		courseId: string;
		requestId: string;
		taskId?: string | null;
	}): Promise<{ record: LearningStart; created: boolean }> {
		if (!isSafeRecordId(input.courseId)) throw invalid("课程 ID 不合法");
		if (!isSafeRecordId(input.requestId)) throw invalid("请求 ID 不合法");
		const taskId = optionalId(input.taskId, "学习任务 ID");
		return this.mutate((state) => {
			assertCourseNotArchived(state, input.courseId, "开始学习");
			if (taskId) findTask(state, input.courseId, taskId);
			const existing = state.learning_starts.find((record) => record.request_id === input.requestId);
			if (existing) {
				if (existing.course_id !== input.courseId || existing.task_id !== taskId) {
					throw new CourseStoreError("COURSE_CONFLICT", "该请求 ID 已用于另一个开始学习请求");
				}
				return { record: { ...existing }, created: false };
			}
			const now = this.now().toISOString();
			const record: LearningStart = {
				request_id: input.requestId,
				course_id: input.courseId,
				task_id: taskId,
				session_id: null,
				status: "creating",
				created_at: now,
				updated_at: now,
			};
			state.learning_starts.push(record);
			pruneLearningStarts(state, now);
			return { record: { ...record }, created: true };
		});
	}

	/** Record the session this request created, still before the binding. */
	async attachLearningStartSession(requestId: string, sessionId: string): Promise<LearningStart> {
		if (!isSafeRecordId(requestId) || !isSafeRecordId(sessionId)) throw invalid("请求或会话 ID 不合法");
		return this.mutate((state) => {
			const record = state.learning_starts.find((candidate) => candidate.request_id === requestId);
			if (!record) throw new CourseStoreError("COURSE_NOT_FOUND", "开始学习请求不存在");
			if (record.session_id && record.session_id !== sessionId) {
				throw new CourseStoreError("COURSE_CONFLICT", "该请求已关联另一个会话");
			}
			record.session_id = sessionId;
			record.status = "created";
			record.updated_at = this.now().toISOString();
			return { ...record };
		});
	}

	/** Session and binding are consistent: later replays may return this pair. */
	async markLearningStartReady(requestId: string, sessionId: string): Promise<LearningStart> {
		if (!isSafeRecordId(requestId) || !isSafeRecordId(sessionId)) throw invalid("请求或会话 ID 不合法");
		return this.mutate((state) => {
			const record = state.learning_starts.find((candidate) => candidate.request_id === requestId);
			if (!record) throw new CourseStoreError("COURSE_NOT_FOUND", "开始学习请求不存在");
			if (record.session_id && record.session_id !== sessionId) {
				throw new CourseStoreError("COURSE_CONFLICT", "该请求已关联另一个会话");
			}
			record.session_id = sessionId;
			record.status = "ready";
			record.updated_at = this.now().toISOString();
			return { ...record };
		});
	}

	/** Drop a failed attempt so the same request id can be retried cleanly. */
	async abortLearningStart(requestId: string): Promise<boolean> {
		if (!isSafeRecordId(requestId)) return false;
		return this.mutate((state) => {
			const before = state.learning_starts.length;
			state.learning_starts = state.learning_starts.filter((record) => record.request_id !== requestId);
			return state.learning_starts.length !== before;
		});
	}

	// ------------------------------------------------------------------
	// Plans
	// ------------------------------------------------------------------

	/**
	 * Create a plan. An agent-suggested plan is forced to `draft`: it becomes
	 * usable only after the learner confirms it (E4.3c), never automatically.
	 */
	async createPlan(courseId: string, input: CreatePlanInput): Promise<StudyPlan> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		const title = normalizeTitle(input.title, "计划标题", MAX_PLAN_TITLE);
		const description = normalizeDescription(input.description);
		const origin = input.origin === undefined ? "user" : input.origin;
		if (!isPlanOrigin(origin)) throw invalid("计划来源不合法");
		const requestedStatus = input.status === undefined ? (origin === "agent_suggested" ? "draft" : "active") : input.status;
		if (!isPlanStatus(requestedStatus)) throw invalid("计划状态不合法");
		const status: StudyPlanStatus = origin === "agent_suggested" && requestedStatus !== "draft" ? "draft" : requestedStatus;
		const goalId = optionalId(input.goalId, "学习目标 ID");
		const targetDate = optionalTargetDate(input.targetDate);
		const dailyMinutes = optionalDailyMinutes(input.dailyMinutes);
		const now = this.now().toISOString();
		const plan: StudyPlan = {
			plan_id: nextId("plan"),
			course_id: courseId,
			title,
			description,
			goal_id: goalId,
			status,
			origin,
			revision: 1,
			...(targetDate ? { target_date: targetDate } : {}),
			...(dailyMinutes !== null ? { daily_minutes: dailyMinutes } : {}),
			created_at: now,
			updated_at: now,
		};
		return this.mutate((state) => {
			findCourse(state, courseId);
			if (goalId) assertGoalBound(state, courseId, goalId);
			state.plans.push(plan);
			return plan;
		});
	}

	/**
	 * E4.3a/c — create a manual plan together with its phases and tasks in one
	 * write. A failure at any point leaves the previous state untouched; there
	 * is no window where a plan exists without the tasks it was saved with.
	 */
	async createPlanWithStructure(
		courseId: string,
		input: CreatePlanStructureInput,
	): Promise<{ plan: StudyPlan; stages: PlanStage[]; tasks: LearningTask[] }> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		const title = normalizeTitle(input.title, "计划标题", MAX_PLAN_TITLE);
		const description = normalizeDescription(input.description);
		const origin = input.origin === undefined ? "user" : input.origin;
		if (!isPlanOrigin(origin)) throw invalid("计划来源不合法");
		const requestedStatus = input.status === undefined ? (origin === "agent_suggested" ? "draft" : "active") : input.status;
		if (!isPlanStatus(requestedStatus)) throw invalid("计划状态不合法");
		const status: StudyPlanStatus = origin === "agent_suggested" && requestedStatus !== "draft" ? "draft" : requestedStatus;
		const goalId = optionalId(input.goalId, "学习目标 ID");
		const targetDate = optionalTargetDate(input.targetDate);
		const dailyMinutes = optionalDailyMinutes(input.dailyMinutes);
		const stagesInput = input.stages ?? [];
		const looseTasks = input.tasks ?? [];
		assertStructureLimits(stagesInput, looseTasks);

		return this.mutate((state) => {
			findCourse(state, courseId);
			if (goalId) assertGoalBound(state, courseId, goalId);
			const now = this.now().toISOString();
			const plan: StudyPlan = {
				plan_id: nextId("plan"),
				course_id: courseId,
				title,
				description,
				goal_id: goalId,
				status,
				origin,
				revision: 1,
				...(targetDate ? { target_date: targetDate } : {}),
				...(dailyMinutes !== null ? { daily_minutes: dailyMinutes } : {}),
				created_at: now,
				updated_at: now,
			};
			state.plans.push(plan);
			const stages: PlanStage[] = [];
			const tasks: LearningTask[] = [];
			let order = 0;
			for (const [index, draft] of stagesInput.entries()) {
				const stage: PlanStage = {
					stage_id: nextId("stage"),
					course_id: courseId,
					plan_id: plan.plan_id,
					title: normalizeTitle(draft.title, "阶段标题", MAX_STAGE_TITLE),
					description: normalizeStageDescription(draft.description),
					order: index,
					created_at: now,
					updated_at: now,
				};
				stages.push(stage);
				for (const taskDraft of draft.tasks ?? []) {
					tasks.push(buildTask(courseId, plan.plan_id, stage.stage_id, order, taskDraft, now));
					order += 1;
				}
			}
			for (const taskDraft of looseTasks) {
				tasks.push(buildTask(courseId, plan.plan_id, null, order, taskDraft, now));
				order += 1;
			}
			state.stages.push(...stages);
			state.tasks.push(...tasks);
			return { plan: { ...plan }, stages, tasks: sortTasks(tasks) };
		});
	}

	/**
	 * Read-only idempotency lookup used before spending a model call.
	 *
	 * A request id that was already used with another fingerprint is a conflict,
	 * not a replay. A fingerprint match returns the original plan even when the
	 * caller sent a new request id, which is how a double click avoids a second
	 * draft. `force` is handled by passing `matchFingerprint: false`: the same
	 * request id still replays, but a new request id may create a new draft.
	 */
	async lookupGeneratedPlan(
		courseId: string,
		requestId: string,
		fingerprint: string,
		options: { matchFingerprint?: boolean; requestFingerprint?: string } = {},
	): Promise<GeneratedPlanLookup> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(requestId)) return { status: "none" };
		const state = await this.readState();
		const plans = state.plans.filter((plan) => plan.course_id === courseId && plan.generation);
		const byRequest = plans.find((plan) => plan.generation!.request_id === requestId);
		if (byRequest) {
			const intent = options.requestFingerprint ?? fingerprint;
			const storedIntent = byRequest.generation!.request_fingerprint ?? byRequest.generation!.fingerprint;
			if (storedIntent !== intent) {
				return { status: "conflict", plan: { ...byRequest } };
			}
			return {
				status: "found",
				plan: { ...byRequest },
				stages: state.stages.filter((stage) => stage.plan_id === byRequest.plan_id).sort(byStageOrder),
				tasks: sortTasks(state.tasks.filter((task) => task.plan_id === byRequest.plan_id)),
				matched: "request_id",
			};
		}
		if (options.matchFingerprint !== false) {
			const byFingerprint = plans.find((plan) => plan.generation!.fingerprint === fingerprint);
			if (byFingerprint) {
				return {
					status: "found",
					plan: { ...byFingerprint },
					stages: state.stages.filter((stage) => stage.plan_id === byFingerprint.plan_id).sort(byStageOrder),
					tasks: sortTasks(state.tasks.filter((task) => task.plan_id === byFingerprint.plan_id)),
					matched: "fingerprint",
				};
			}
		}
		return { status: "none" };
	}

	/**
	 * E4.3b — persist a validated generated plan as a `draft`.
	 *
	 * Idempotent by request id, and by fingerprint: a repeated click must not
	 * mint a second plan and a second task set. `force` only bypasses the
	 * fingerprint guard; a reused request id always returns its original plan.
	 */
	async saveGeneratedPlanDraft(
		courseId: string,
		input: SaveGeneratedPlanInput,
		options: { force?: boolean } = {},
	): Promise<SaveGeneratedPlanResult> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		const title = normalizeTitle(input.title, "计划标题", MAX_PLAN_TITLE);
		const description = normalizeDescription(input.description);
		const goalId = optionalId(input.goalId, "学习目标 ID");
		const targetDate = optionalTargetDate(input.targetDate);
		const dailyMinutes = optionalDailyMinutes(input.dailyMinutes);
		const generation = input.generation;
		if (!isSafeRecordId(generation.request_id)) throw invalid("生成请求 ID 不合法");
		if (!isPlanBasis(generation.basis)) throw invalid("规划依据不合法");
		const stagesInput = input.stages;
		assertStructureLimits(stagesInput.map((stage) => ({ title: stage.title, tasks: stage.tasks })), []);
		if (stagesInput.length === 0) throw invalid("计划至少需要一个阶段");

		return this.mutateOptional<SaveGeneratedPlanResult>((state) => {
			findCourse(state, courseId);
			const duplicate = state.plans.find((plan) => plan.course_id === courseId && plan.generation
				&& (plan.generation.request_id === generation.request_id
					|| (!options.force && plan.generation.fingerprint === generation.fingerprint)));
			if (duplicate) {
				const requestMatches = duplicate.generation?.request_id !== generation.request_id
					|| (duplicate.generation?.request_fingerprint ?? duplicate.generation?.fingerprint)
						=== (generation.request_fingerprint ?? generation.fingerprint);
				if (!requestMatches) {
					throw new CourseStoreError("COURSE_CONFLICT", "该请求 ID 已用于不同的计划生成请求", {
						currentRevision: duplicate.revision,
					});
				}
				// A replay must not bump the file revision: returning the stored
				// plan is not a state change.
				return {
					write: false,
					result: {
						plan: { ...duplicate },
						stages: state.stages.filter((stage) => stage.plan_id === duplicate.plan_id).sort(byStageOrder),
						tasks: sortTasks(state.tasks.filter((task) => task.plan_id === duplicate.plan_id)),
						created: false,
					},
				};
			}
			// Only a new plan needs a currently bound goal; a replay of a plan
			// saved before the binding was removed must still return its result.
			if (goalId) assertGoalBound(state, courseId, goalId);
			const now = this.now().toISOString();
			const plan: StudyPlan = {
				plan_id: nextId("plan"),
				course_id: courseId,
				title,
				description,
				goal_id: goalId,
				// Hard-coded, not caller-controlled: an AI plan is always a draft.
				status: "draft",
				origin: "agent_suggested",
				revision: 1,
				...(targetDate ? { target_date: targetDate } : {}),
				...(dailyMinutes !== null ? { daily_minutes: dailyMinutes } : {}),
				generation: { ...generation, units: generation.units.map((unit) => ({ ...unit })) },
				created_at: now,
				updated_at: now,
			};
			state.plans.push(plan);
			const stages: PlanStage[] = [];
			const tasks: LearningTask[] = [];
			let order = 0;
			for (const [index, draft] of stagesInput.entries()) {
				const stage: PlanStage = {
					stage_id: nextId("stage"),
					course_id: courseId,
					plan_id: plan.plan_id,
					title: normalizeTitle(draft.title, "阶段标题", MAX_STAGE_TITLE),
					description: normalizeStageDescription(draft.description),
					order: index,
					created_at: now,
					updated_at: now,
				};
				stages.push(stage);
				for (const taskDraft of draft.tasks) {
					tasks.push(buildTask(courseId, plan.plan_id, stage.stage_id, order, {
						title: taskDraft.title,
						conceptIds: taskDraft.conceptIds ?? [],
						conceptLabels: taskDraft.conceptLabels,
						sourceIds: taskDraft.sourceIds ?? [],
						sourceRefs: taskDraft.sourceRefs,
						estimatedMinutes: taskDraft.estimatedMinutes,
						difficulty: taskDraft.difficulty,
						rationale: taskDraft.rationale,
					}, now));
					order += 1;
				}
			}
			state.stages.push(...stages);
			state.tasks.push(...tasks);
			return {
				write: true,
				result: { plan: { ...plan }, stages, tasks: sortTasks(tasks), created: true },
			};
		});
	}

	async updatePlan(courseId: string, planId: string, patch: UpdatePlanInput): Promise<StudyPlan> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		const title = patch.title === undefined ? undefined : normalizeTitle(patch.title, "计划标题", MAX_PLAN_TITLE);
		const description = patch.description === undefined ? undefined : normalizeDescription(patch.description);
		if (patch.status !== undefined && !isPlanStatus(patch.status)) throw invalid("计划状态不合法");
		const goalId = patch.goalId === undefined ? undefined : optionalId(patch.goalId, "学习目标 ID");
		const targetDate = patch.targetDate === undefined ? undefined : optionalTargetDate(patch.targetDate);
		const dailyMinutes = patch.dailyMinutes === undefined ? undefined : optionalDailyMinutes(patch.dailyMinutes);
		return this.mutate((state) => {
			const plan = findPlan(state, courseId, planId);
			if (patch.status !== undefined && patch.status !== plan.status) {
				assertPlanTransition(plan, patch.status);
			}
			if (title !== undefined) plan.title = title;
			if (description !== undefined) plan.description = description;
			if (patch.status !== undefined) plan.status = patch.status;
			if (goalId !== undefined) {
				if (goalId) assertGoalBound(state, courseId, goalId);
				plan.goal_id = goalId;
			}
			if (targetDate !== undefined) {
				if (targetDate) plan.target_date = targetDate;
				else delete plan.target_date;
			}
			if (dailyMinutes !== undefined) {
				if (dailyMinutes !== null) plan.daily_minutes = dailyMinutes;
				else delete plan.daily_minutes;
			}
			plan.revision += 1;
			plan.updated_at = this.now().toISOString();
			return { ...plan };
		});
	}

	/**
	 * E4.7 — archive a plan without touching what it recorded.
	 *
	 * Separate from the generic status patch on purpose: `PATCH .../plans/:id`
	 * refuses a status change on a `completed` plan (history is frozen), while
	 * archiving is exactly how a finished or in-progress plan leaves the active
	 * list. Tasks, sessions and evidence stay readable; nothing is unbound and
	 * no other plan is activated — a course left without an active plan simply
	 * reports `no_active_plan` until the learner confirms a draft.
	 *
	 * Idempotent: archiving an archived plan returns it unchanged.
	 */
	async archivePlan(courseId: string, planId: string): Promise<StudyPlan> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		return this.mutateOptional((state) => {
			const plan = findPlan(state, courseId, planId);
			if (plan.status === "archived") return { write: false, result: { ...plan } };
			plan.status = "archived";
			plan.revision += 1;
			plan.updated_at = this.now().toISOString();
			return { write: true, result: { ...plan } };
		});
	}

	/** E4.7 — preflight for a plan delete; same rules as `deletePlan`. */
	async inspectPlanDeletion(
		courseId: string,
		planId: string,
		options: CourseDeletionOptions = {},
	): Promise<PlanDeletionReport> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		const state = await this.readState();
		const report = planDeletionReport(state, courseId, planId, this.now().getTime());
		if (options.externalBlockers) {
			const taskIds = state.tasks
				.filter((task) => task.plan_id === planId && task.course_id === courseId)
				.map((task) => task.task_id);
			const taskIdSet = new Set(taskIds);
			const external = await options.externalBlockers({
				target: "plan",
				courseId,
				planId,
				sessionIds: state.session_bindings
					.filter((binding) => binding.task_id !== null && taskIdSet.has(binding.task_id))
					.map((binding) => binding.session_id),
				taskIds,
			});
			if (external.length > 0) {
				report.blockers = mergeBlockers(report.blockers, external);
				report.deletable = false;
			}
		}
		return report;
	}

	/**
	 * E4.7 — delete a draft or a confirmed-but-not-started plan.
	 *
	 * A plan is planning state: its stages and its unstarted tasks may disappear
	 * together, in one write. Once any task has left `pending`, a session points
	 * at one of its tasks, or a 「开始学习」 request for it is still open, the plan
	 * holds real learning history and is refused — archiving keeps that history
	 * readable.
	 *
	 * Deleting the active plan does not promote a draft: the course is left with
	 * `no_active_plan` and every daily view recomputes from that state.
	 */
	async deletePlan(courseId: string, planId: string, options: CourseDeletionOptions = {}): Promise<DeletionOutcome> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		return this.mutateGuarded(async (state) => {
			const report = planDeletionReport(state, courseId, planId, this.now().getTime());
			const blockers = [...report.blockers];
			if (options.externalBlockers) {
				const planTasks = state.tasks
					.filter((task) => task.plan_id === planId && task.course_id === courseId);
				const taskIds = planTasks.map((task) => task.task_id);
				const taskIdSet = new Set(taskIds);
				const external = await options.externalBlockers({
					target: "plan",
					courseId,
					planId,
					// B2 evidence is per session; only the plan's own task sessions
					// can attribute an attempt to this plan.
					sessionIds: state.session_bindings
						.filter((binding) => binding.task_id !== null && taskIdSet.has(binding.task_id))
						.map((binding) => binding.session_id),
					taskIds,
				});
				blockers.push(...external);
			}
			assertDeletable(blockers, "该计划已有真实学习记录，不能永久删除；请改用归档。");
			const removed = purgePlan(state, courseId, planId);
			return { write: true, result: { course_id: courseId, plan_id: planId, removed } };
		});
	}

	/**
	 * E4.3c — atomically replace a draft's phases and tasks.
	 *
	 * Only a draft can be rewritten as a whole. Once a plan is active, ordinary
	 * task endpoints are the editing surface, so a whole-plan replace can never
	 * silently drop progress the learner already made.
	 */
	async replacePlanDraft(
		courseId: string,
		planId: string,
		input: ReplacePlanDraftInput,
	): Promise<{ plan: StudyPlan; stages: PlanStage[]; tasks: LearningTask[] }> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		if (!Number.isSafeInteger(input.expectedRevision)) throw invalid("缺少计划版本");
		assertStructureLimits(input.stages, input.tasks ?? []);
		assertUniqueDraftIds(input.stages, input.tasks ?? []);
		const title = input.title === undefined ? undefined : normalizeTitle(input.title, "计划标题", MAX_PLAN_TITLE);
		const description = input.description === undefined ? undefined : normalizeDescription(input.description);
		const goalId = input.goalId === undefined ? undefined : optionalId(input.goalId, "学习目标 ID");
		const targetDate = input.targetDate === undefined ? undefined : optionalTargetDate(input.targetDate);
		const dailyMinutes = input.dailyMinutes === undefined ? undefined : optionalDailyMinutes(input.dailyMinutes);

		return this.mutate((state) => {
			const plan = findPlan(state, courseId, planId);
			assertDraft(plan);
			assertRevision(plan, input.expectedRevision);
			if (goalId) assertGoalBound(state, courseId, goalId);
			const now = this.now().toISOString();
			const previousTasks = new Map(state.tasks
				.filter((task) => task.plan_id === planId)
				.map((task) => [task.task_id, task]));
			const previousStages = new Map(state.stages
				.filter((stage) => stage.plan_id === planId)
				.map((stage) => [stage.stage_id, stage]));

			const stages: PlanStage[] = [];
			const tasks: LearningTask[] = [];
			let order = 0;
			for (const [index, draft] of input.stages.entries()) {
				const stageId = draft.stage_id ?? null;
				const existing = stageId ? previousStages.get(stageId) : undefined;
				if (stageId && !existing) throw invalid("阶段不属于该计划");
				const stage: PlanStage = {
					stage_id: existing?.stage_id ?? nextId("stage"),
					course_id: courseId,
					plan_id: planId,
					title: normalizeTitle(draft.title, "阶段标题", MAX_STAGE_TITLE),
					description: normalizeStageDescription(draft.description),
					order: index,
					created_at: existing?.created_at ?? now,
					updated_at: now,
				};
				stages.push(stage);
				for (const taskDraft of draft.tasks ?? []) {
					const taskId = taskDraft.task_id ?? null;
					const oldTask = taskId ? previousTasks.get(taskId) : undefined;
					if (taskId && !oldTask) throw invalid("任务不属于该计划");
					if (taskDraft.sourceRefs !== undefined) {
						if (!oldTask) throw invalid("新任务不能自定义来源引用");
						assertSameSourceRefs(taskDraft.sourceRefs, oldTask.source_refs);
					}
					tasks.push(buildTask(courseId, planId, stage.stage_id, order, taskDraft, now, oldTask));
					order += 1;
				}
			}
			for (const taskDraft of input.tasks ?? []) {
				const taskId = taskDraft.task_id ?? null;
				const oldTask = taskId ? previousTasks.get(taskId) : undefined;
				if (taskId && !oldTask) throw invalid("任务不属于该计划");
				if (taskDraft.sourceRefs !== undefined) {
					if (!oldTask) throw invalid("新任务不能自定义来源引用");
					assertSameSourceRefs(taskDraft.sourceRefs, oldTask.source_refs);
				}
				tasks.push(buildTask(courseId, planId, null, order, taskDraft, now, oldTask));
				order += 1;
			}

			// A task with a learning session keeps its history. Replacing the draft
			// may not silently delete it, or the session binding would point at a
			// nonexistent task and B2 would lose its trail.
			const keptIds = new Set(tasks.map((task) => task.task_id));
			const removedIds = [...previousTasks.keys()].filter((taskId) => !keptIds.has(taskId));
			const bound = state.session_bindings.find((binding) => binding.task_id && removedIds.includes(binding.task_id));
			if (bound) {
				throw new CourseStoreError("COURSE_CONFLICT", "任务已绑定学习会话，不能通过草稿替换删除", {
					currentRevision: plan.revision,
				});
			}
			state.stages = state.stages.filter((stage) => stage.plan_id !== planId);
			state.tasks = state.tasks.filter((task) => task.plan_id !== planId);
			state.stages.push(...stages);
			state.tasks.push(...tasks);

			if (title !== undefined) plan.title = title;
			if (description !== undefined) plan.description = description;
			if (goalId !== undefined) plan.goal_id = goalId;
			if (targetDate !== undefined) {
				if (targetDate) plan.target_date = targetDate;
				else delete plan.target_date;
			}
			if (dailyMinutes !== undefined) {
				if (dailyMinutes !== null) plan.daily_minutes = dailyMinutes;
				else delete plan.daily_minutes;
			}
			plan.revision += 1;
			plan.updated_at = now;
			return { plan: { ...plan }, stages, tasks: sortTasks(tasks) };
		});
	}

	/**
	 * E4.3a — replace a plan's phases without touching its tasks.
	 *
	 * Stage ordering is part of planning, but a whole-draft replace would drop
	 * task progress. This endpoint only owns stage titles/descriptions/order;
	 * a task whose stage disappears is detached (`stage_id: null`), never
	 * deleted.
	 */
	async replacePlanStages(
		courseId: string,
		planId: string,
		input: ReplaceStagesInput,
	): Promise<{ plan: StudyPlan; stages: PlanStage[]; tasks: LearningTask[] }> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		if (!Number.isSafeInteger(input.expectedRevision)) throw invalid("缺少计划版本");
		if (!Array.isArray(input.stages) || input.stages.length > MAX_PLAN_STAGES) throw invalid("学习阶段数量过多");
		assertUniqueStageIds(input.stages);
		return this.mutate((state) => {
			const plan = findPlan(state, courseId, planId);
			if (plan.status === "archived" || plan.status === "completed") {
				throw new CourseStoreError("COURSE_CONFLICT", "已结束的计划不能调整阶段", {
					currentRevision: plan.revision,
				});
			}
			assertRevision(plan, input.expectedRevision);
			const now = this.now().toISOString();
			const previous = new Map(state.stages
				.filter((stage) => stage.plan_id === planId)
				.map((stage) => [stage.stage_id, stage]));
			const stages: PlanStage[] = input.stages.map((draft, index) => {
				const existing = draft.stage_id ? previous.get(draft.stage_id) : undefined;
				if (draft.stage_id && !existing) throw invalid("阶段不属于该计划");
				return {
					stage_id: existing?.stage_id ?? nextId("stage"),
					course_id: courseId,
					plan_id: planId,
					title: normalizeTitle(draft.title, "阶段标题", MAX_STAGE_TITLE),
					description: normalizeStageDescription(draft.description),
					order: index,
					created_at: existing?.created_at ?? now,
					updated_at: now,
				};
			});
			const keep = new Set(stages.map((stage) => stage.stage_id));
			for (const task of state.tasks) {
				if (task.plan_id !== planId || !task.stage_id) continue;
				if (!keep.has(task.stage_id)) {
					task.stage_id = null;
					task.updated_at = now;
				}
			}
			state.stages = [...state.stages.filter((stage) => stage.plan_id !== planId), ...stages];
			plan.revision += 1;
			plan.updated_at = now;
			return {
				plan: { ...plan },
				stages,
				tasks: sortTasks(state.tasks.filter((task) => task.plan_id === planId)),
			};
		});
	}

	/**
	 * E4.3c — the only path from `draft` to `active`.
	 *
	 * A second active plan is refused unless the caller explicitly asks to
	 * replace it; nothing is archived as a side effect of generating a draft.
	 */
	async confirmPlan(
		courseId: string,
		planId: string,
		input: ConfirmPlanInput,
	): Promise<{ plan: StudyPlan; alreadyActive: boolean; archivedPlanIds: string[] }> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		if (!Number.isSafeInteger(input.expectedRevision)) throw invalid("缺少计划版本");
		return this.mutate((state) => {
			assertCourseNotArchived(state, courseId, "确认启用学习计划");
			const plan = findPlan(state, courseId, planId);
			if (plan.status === "active") {
				assertRevision(plan, input.expectedRevision);
				return { plan: { ...plan }, alreadyActive: true, archivedPlanIds: [] };
			}
			if (plan.status !== "draft") {
				throw new CourseStoreError("COURSE_CONFLICT", "只有草稿计划可以确认启用", {
					currentRevision: plan.revision,
				});
			}
			assertRevision(plan, input.expectedRevision);
			const others = state.plans.filter((candidate) => candidate.course_id === courseId
				&& candidate.plan_id !== planId
				&& candidate.status === "active");
			if (others.length > 0 && input.replaceActive !== true) {
				throw new CourseStoreError("COURSE_CONFLICT", "该课程已有启用中的计划；如需替换请明确确认", {
					currentRevision: plan.revision,
				});
			}
			const now = this.now().toISOString();
			for (const other of others) {
				other.status = "archived";
				other.revision += 1;
				other.updated_at = now;
			}
			plan.status = "active";
			plan.revision += 1;
			plan.updated_at = now;
			return { plan: { ...plan }, alreadyActive: false, archivedPlanIds: others.map((other) => other.plan_id) };
		});
	}

	// ------------------------------------------------------------------
	// Tasks
	// ------------------------------------------------------------------

	async createTask(courseId: string, input: CreateTaskInput): Promise<LearningTask> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		// E4.6-R2: a task that is being created has not been studied yet. Any
		// other status would record progress that never happened, so creation is
		// always `pending` and progress only moves through the learning flow.
		if (input.status !== undefined && input.status !== "pending") {
			throw new CourseStoreError("COURSE_CONFLICT", "新建任务必须处于未开始状态");
		}
		return this.mutate((state) => {
			findCourse(state, courseId);
			const planId = optionalId(input.planId, "学习计划 ID");
			if (planId) findPlan(state, courseId, planId);
			const stageId = this.checkedStageId(state, courseId, planId, input.stageId);
			const order = planId
				? nextOrder(state.tasks.filter((task) => task.plan_id === planId))
				: nextOrder(state.tasks.filter((task) => task.course_id === courseId && !task.plan_id));
			const task = buildTask(courseId, planId, stageId, order, {
				title: input.title,
				conceptIds: input.conceptIds,
				conceptLabels: input.conceptLabels,
				sourceIds: input.sourceIds,
				sourceRefs: input.sourceRefs,
				estimatedMinutes: input.estimatedMinutes,
				difficulty: input.difficulty,
				rationale: input.rationale,
				status: "pending",
			}, this.now().toISOString());
			state.tasks.push(task);
			this.touchPlan(state, planId);
			return { ...task };
		});
	}

	async updateTask(courseId: string, taskId: string, patch: UpdateTaskInput): Promise<LearningTask> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(taskId)) throw invalid("任务 ID 不合法");
		const title = patch.title === undefined ? undefined : normalizeTitle(patch.title, "任务标题", MAX_TASK_TITLE);
		if (patch.status !== undefined && !isTaskStatus(patch.status)) throw invalid("任务状态不合法");
		const conceptIds = patch.conceptIds === undefined ? undefined : idList(patch.conceptIds, "概念 ID");
		const sourceIds = patch.sourceIds === undefined ? undefined : idList(patch.sourceIds, "资料 ID");
		const conceptLabels = patch.conceptLabels === undefined ? undefined : conceptLabelList(patch.conceptLabels, conceptIds);
		const sourceRefs = patch.sourceRefs === undefined ? undefined : sourceRefList(patch.sourceRefs);
		const estimatedMinutes = patch.estimatedMinutes === undefined ? undefined : optionalMinutes(patch.estimatedMinutes, "预计学习时长");
		const difficulty = patch.difficulty === undefined ? undefined : normalizeDifficulty(patch.difficulty);
		const rationale = patch.rationale === undefined ? undefined : normalizeRationale(patch.rationale);
		const order = patch.order === undefined ? undefined : patch.order;
		if (order !== undefined && (!Number.isSafeInteger(order) || order < 0)) throw invalid("任务顺序不合法");

		return this.mutate((state) => {
			assertCourseNotArchived(state, courseId, "修改任务");
			const task = findTask(state, courseId, taskId);
			const previousPlanId = task.plan_id;
			const planId = patch.planId === undefined ? previousPlanId : optionalId(patch.planId, "学习计划 ID");
			if (patch.planId !== undefined && planId) findPlan(state, courseId, planId);
			const planChanged = planId !== previousPlanId;
			// A cross-plan move changes two plans. The source revision is
			// mandatory so a stale client cannot append into a plan that was
			// edited since it read the task.
			if (planChanged && previousPlanId && patch.expectedPlanRevision === undefined) {
				throw invalid("跨计划移动任务需要提供原计划版本 expected_revision");
			}
			if (patch.expectedPlanRevision !== undefined && previousPlanId) {
				assertRevision(findPlan(state, courseId, previousPlanId), patch.expectedPlanRevision);
			}
			if (planChanged && planId && patch.expectedTargetRevision !== undefined) {
				assertRevision(findPlan(state, courseId, planId), patch.expectedTargetRevision);
			}
			if (planChanged && planId) {
				// E4.6-R2b: a move into a draft plan is a planning edit, not a way to
				// park finished work. `assertTaskProgressAllowed` below only guards a
				// status *change*, so a pure `plan_id` move would otherwise carry a
				// task's progress (and its session) into an unconfirmed plan and hide
				// it from the learner. Checked in this write transaction, before any
				// field is assigned, so a refusal leaves the whole state untouched.
				assertDraftMoveAllowed(state, task, findPlan(state, courseId, planId));
			}
			const stageId = patch.stageId === undefined
				? (planChanged ? null : task.stage_id)
				: this.checkedStageId(state, courseId, planId, patch.stageId);
			task.plan_id = planId;
			task.stage_id = stageId;
			if (title !== undefined) task.title = title;
			if (patch.status !== undefined && patch.status !== task.status) {
				// E4.6-R2: task progress is a learning record. It may only advance
				// for a task whose plan is executable, and only through the learning
				// flow (`learning/start` moves pending → in_progress) or an explicit
				// completion. A draft plan's task stays pending so an AI proposal can
				// never look like work the learner already did.
				assertTaskProgressAllowed(state, task);
				task.status = patch.status;
				if (patch.status === "completed") task.completed_at = this.now().toISOString();
				else delete task.completed_at;
			}
			if (conceptIds !== undefined) task.concept_ids = conceptIds;
			if (conceptLabels !== undefined) {
				if (conceptLabels.length !== task.concept_ids.length) throw invalid("知识点名称必须与知识点 ID 一一对应");
				task.concept_labels = conceptLabels;
			}
			if (sourceIds !== undefined) {
				task.source_ids = sourceIds;
				// Removing a source must not leave a citation to it behind.
				if (sourceRefs === undefined && task.source_refs) {
					const kept = task.source_refs.filter((ref) => sourceIds.includes(ref.source_id));
					if (kept.length > 0) task.source_refs = kept;
					else delete task.source_refs;
				}
			}
			if (sourceRefs !== undefined) {
				if (sourceRefs.length > 0) task.source_refs = sourceRefs;
				else delete task.source_refs;
			}
			if (estimatedMinutes !== undefined) task.estimated_minutes = estimatedMinutes;
			if (difficulty !== undefined) task.difficulty = difficulty;
			if (rationale !== undefined) {
				if (rationale) task.rationale = rationale;
				else delete task.rationale;
			}
			if (planChanged) {
				// Close the gap in the old plan before appending to the new one.
				reindexTasks(state, courseId, previousPlanId);
				task.order = planId
					? nextOrder(state.tasks.filter((candidate) => candidate.plan_id === planId && candidate.task_id !== task.task_id))
					: nextOrder(state.tasks.filter((candidate) => candidate.course_id === courseId
						&& !candidate.plan_id && candidate.task_id !== task.task_id));
			} else if (order !== undefined && order !== task.order) {
				moveTask(state, task, order);
			}
			task.updated_at = this.now().toISOString();
			if (planChanged) this.touchPlan(state, previousPlanId);
			this.touchPlan(state, planId);
			return { ...task };
		});
	}

	/** Delete one task and close the gap in its plan's order. */
	async deleteTask(courseId: string, taskId: string): Promise<boolean> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(taskId)) return false;
		const state = await this.readState();
		const existing = state.tasks.find((task) => task.course_id === courseId && task.task_id === taskId);
		if (!existing) return false;
		return this.mutate((current) => {
			const bound = current.session_bindings.find((binding) => binding.task_id === taskId);
			if (bound) {
				const plan = existing.plan_id
					? current.plans.find((candidate) => candidate.plan_id === existing.plan_id)
					: undefined;
				throw new CourseStoreError("COURSE_CONFLICT", "任务已绑定学习会话，不能删除；会话与 B2 记录必须保留", {
					...(plan ? { currentRevision: plan.revision } : {}),
				});
			}
			const before = current.tasks.length;
			current.tasks = current.tasks.filter((task) => !(task.course_id === courseId && task.task_id === taskId));
			const changed = current.tasks.length !== before;
			if (changed) {
				reindexTasks(current, courseId, existing.plan_id);
				this.touchPlan(current, existing.plan_id);
			}
			return changed;
		});
	}

	/**
	 * E4.3a — explicit ordering. The payload must name every task of the plan:
	 * a partial list would leave ambiguous relative positions, and guessing one
	 * is exactly the silent reorder this endpoint exists to avoid.
	 */
	async reorderTasks(courseId: string, planId: string, input: ReorderTasksInput): Promise<LearningTask[]> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		if (!Number.isSafeInteger(input.expectedRevision)) throw invalid("缺少计划版本");
		if (!Array.isArray(input.taskIds) || input.taskIds.length > MAX_PLAN_TASKS) throw invalid("任务顺序不合法");
		return this.mutate((state) => {
			const plan = findPlan(state, courseId, planId);
			assertRevision(plan, input.expectedRevision);
			const tasks = state.tasks.filter((task) => task.plan_id === planId);
			if (tasks.length !== input.taskIds.length) throw invalid("任务顺序必须包含该计划的全部任务");
			const byId = new Map(tasks.map((task) => [task.task_id, task]));
			const seen = new Set<string>();
			for (const id of input.taskIds) {
				if (!isSafeRecordId(id) || !byId.has(id) || seen.has(id)) throw invalid("任务顺序包含不合法或重复的任务");
				seen.add(id);
			}
			input.taskIds.forEach((id, index) => {
				const task = byId.get(id)!;
				task.order = index;
				task.updated_at = this.now().toISOString();
			});
			plan.revision += 1;
			plan.updated_at = this.now().toISOString();
			return sortTasks(tasks);
		});
	}

	/**
	 * E4.3e — apply one user-confirmed adjustment.
	 *
	 * The revision check makes this a compare-and-swap: a suggestion computed
	 * against an older plan cannot be applied to a plan the learner has edited
	 * since. The suggestion id is stored with the change, so the plan keeps the
	 * evidence and rationale behind every adjustment.
	 */
	async applyPlanAdjustment(
		courseId: string,
		planId: string,
		input: PlanAdjustmentInput,
	): Promise<{ plan: StudyPlan; tasks: LearningTask[]; adjustment: PlanAdjustmentRecord }> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		if (!isSafeRecordId(input.suggestionId)) throw invalid("调整建议 ID 不合法");
		if (!Number.isSafeInteger(input.expectedRevision)) throw invalid("缺少计划版本");
		return this.mutate((state) => {
			assertCourseNotArchived(state, courseId, "调整学习计划");
			const plan = findPlan(state, courseId, planId);
			if (plan.status === "archived" || plan.status === "completed") {
				throw new CourseStoreError("COURSE_CONFLICT", "已结束的计划不能调整", { currentRevision: plan.revision });
			}
			assertRevision(plan, input.expectedRevision);
			const now = this.now().toISOString();
			const changes: string[] = [];
			let targetConcept: string | undefined;
			let targetTaskId: string | undefined;

			const orderSignature = (): string => sortTasks(state.tasks.filter((task) => task.plan_id === planId))
				.map((task) => task.task_id).join("\u0000");
			const beforeOrder = orderSignature();
			switch (input.type) {
				case "review_prerequisite":
				case "add_practice": {
					const conceptId = input.conceptId;
					if (!conceptId || !isSafeRecordId(conceptId)) throw invalid("调整建议缺少知识点");
					targetConcept = conceptId;
					const prefix = input.type === "review_prerequisite" ? "复习：" : "练习：";
					const duplicateSupport = state.tasks.find((task) => task.plan_id === planId
						&& task.status !== "completed"
						&& task.title.startsWith(prefix)
						&& task.concept_ids.includes(conceptId));
					if (duplicateSupport) {
						throw new CourseStoreError("COURSE_CONFLICT", "该知识点已有未完成的同类任务，无需重复添加", {
							currentRevision: plan.revision,
						});
					}
					const anchor = input.taskId ? findTask(state, courseId, input.taskId) : undefined;
					if (input.taskId && (!anchor || anchor.plan_id !== planId)) throw invalid("目标任务不属于该计划");
					targetTaskId = anchor?.task_id;
					const label = (input.conceptLabel ?? "").trim().slice(0, MAX_CONCEPT_LABEL)
						|| (isDerivedConceptId(conceptId) ? "待确认知识点" : conceptId);
					const title = input.type === "review_prerequisite" ? `复习：${label}` : `练习：${label}`;
					const order = anchor ? anchor.order : nextOrder(state.tasks.filter((task) => task.plan_id === planId));
					if (anchor) shiftTasksFrom(state, planId, order);
					const task = buildTask(courseId, planId, anchor?.stage_id ?? null, order, {
						title,
						conceptIds: [conceptId],
						conceptLabels: [label],
						sourceIds: anchor?.source_ids ?? [],
						sourceRefs: anchor?.source_refs,
						estimatedMinutes: input.type === "review_prerequisite" ? 10 : 20,
						difficulty: input.type === "review_prerequisite" ? "basic" : "standard",
						rationale: input.reasonCode === "review_due"
							? "根据 L1 到期复习证据插入的复习任务。"
							: "根据 L1 薄弱证据插入的练习任务。",
					}, now);
					state.tasks.push(task);
					targetTaskId = anchor?.task_id;
					changes.push(`在${anchor ? "任务前" : "计划末尾"}新增任务「${title}」`);
					break;
				}
				case "reorder_task": {
					if (!input.taskId) throw invalid("调整建议缺少目标任务");
					const task = findTask(state, courseId, input.taskId);
					if (task.plan_id !== planId) throw invalid("目标任务不属于该计划");
					targetTaskId = task.task_id;
					if (input.beforeTaskId) {
						const before = findTask(state, courseId, input.beforeTaskId);
						if (before.plan_id !== planId || before.task_id === task.task_id) throw invalid("参照任务不属于该计划");
						const ordered = sortTasks(state.tasks.filter((candidate) => candidate.plan_id === planId))
							.filter((candidate) => candidate.task_id !== task.task_id);
						const index = ordered.findIndex((candidate) => candidate.task_id === before.task_id);
						ordered.splice(index < 0 ? 0 : index, 0, task);
						ordered.forEach((candidate, position) => { candidate.order = position; });
						changes.push(`将任务「${task.title}」调整到「${before.title}」之前`);
					} else {
						moveTask(state, task, 0);
						changes.push(`将任务「${task.title}」调整到最前`);
					}
					break;
				}
				case "defer_task": {
					if (!input.taskId) throw invalid("调整建议缺少目标任务");
					const task = findTask(state, courseId, input.taskId);
					if (task.plan_id !== planId) throw invalid("目标任务不属于该计划");
					targetTaskId = task.task_id;
					moveTask(state, task, MAX_PLAN_TASKS);
					changes.push(`将任务「${task.title}」暂缓到计划末尾`);
					break;
				}
				case "adjust_difficulty": {
					if (!input.taskId || !input.difficulty) throw invalid("调整建议缺少任务或难度");
					const task = findTask(state, courseId, input.taskId);
					if (task.plan_id !== planId) throw invalid("目标任务不属于该计划");
					if (!isTaskDifficulty(input.difficulty)) throw invalid("任务难度不合法");
					targetTaskId = task.task_id;
					const before = task.difficulty;
					if (before === input.difficulty) {
						throw new CourseStoreError("COURSE_CONFLICT", "任务难度没有变化，无需调整", {
							currentRevision: plan.revision,
						});
					}
					task.difficulty = input.difficulty;
					task.updated_at = now;
					changes.push(`将任务「${task.title}」难度从 ${before} 调整为 ${input.difficulty}`);
					break;
				}
				default:
					throw invalid("调整类型不合法");
			}

			reindexTasks(state, courseId, planId);
			if (orderSignature() === beforeOrder && (input.type === "reorder_task" || input.type === "defer_task")) {
				throw new CourseStoreError("COURSE_CONFLICT", "任务顺序没有变化，无需调整", {
					currentRevision: plan.revision,
				});
			}
			const adjustment: PlanAdjustmentRecord = {
				adjustment_id: nextId("adj"),
				suggestion_id: input.suggestionId,
				type: input.type,
				applied_at: now,
				reason_code: input.reasonCode.slice(0, 80),
				...(targetConcept ? { concept_id: targetConcept } : {}),
				...(targetTaskId ? { task_id: targetTaskId } : {}),
				...(input.evidence ? { evidence: input.evidence } : {}),
				changes,
			};
			plan.adjustments = [...(plan.adjustments ?? []), adjustment].slice(-50);
			plan.revision += 1;
			plan.updated_at = now;
			return {
				plan: { ...plan },
				tasks: sortTasks(state.tasks.filter((task) => task.plan_id === planId)),
				adjustment,
			};
		});
	}

	/** Stop accepting new writes, drain the queue, then release an owned lock. */
	async close(): Promise<void> {
		this.closed = true;
		const tail = fileQueues.get(this.filePath);
		if (tail) await tail;
		const lock = this.ownLock;
		this.ownLock = undefined;
		await lock?.release();
	}

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	/** A stage must belong to the same plan; a cross-plan stage is a conflict. */
	private checkedStageId(
		state: CourseStateFile,
		courseId: string,
		planId: string | null,
		value: unknown,
	): string | null {
		if (value === undefined || value === null) return null;
		if (!isSafeRecordId(value)) throw invalid("学习阶段 ID 不合法");
		const stage = state.stages.find((candidate) => candidate.stage_id === value && candidate.course_id === courseId);
		if (!stage) {
			if (state.stages.some((candidate) => candidate.stage_id === value)) {
				throw new CourseStoreError("COURSE_CONFLICT", "学习阶段不属于该课程");
			}
			throw new CourseStoreError("COURSE_NOT_FOUND", "学习阶段不存在");
		}
		if (!planId || stage.plan_id !== planId) throw invalid("学习阶段不属于该计划");
		return stage.stage_id;
	}

	/** Task edits change the plan's shape, so its revision must move too. */
	private touchPlan(state: CourseStateFile, planId: string | null): void {
		if (!planId) return;
		const plan = state.plans.find((candidate) => candidate.plan_id === planId);
		if (!plan) return;
		plan.revision += 1;
		plan.updated_at = this.now().toISOString();
	}

	private assertOpen(): void {
		if (this.closed) throw new CourseStoreError("COURSE_CLOSED", "课程数据存储已关闭");
	}

	private async ensureWriteLock(): Promise<void> {
		if (this.injectedLock) {
			await this.injectedLock.assertOwned().catch((err: unknown) => {
				throw mapLockError(err);
			});
			return;
		}
		if (!this.ownLock) {
			this.ownLock = await acquireWriterLock(this.dataDir).catch((err: unknown) => {
				throw mapLockError(err);
			});
		}
		await this.ownLock.assertOwned().catch((err: unknown) => {
			throw mapLockError(err);
		});
	}

	private async mutate<T>(fn: (state: CourseStateFile) => T): Promise<T> {
		this.assertOpen();
		return runExclusive(this.filePath, async () => {
			await this.ensureWriteLock();
			const state = await this.readState();
			const result = fn(state);
			state.revision = state.revision + 1;
			await writeJsonDurable(this.filePath, state).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			return result;
		});
	}

	/**
	 * Same serialized boundary, but the callback decides whether the state
	 * actually changed. Used for idempotent replays: returning an existing plan
	 * must not rewrite the file or bump its revision.
	 */
	private async mutateOptional<T>(
		fn: (state: CourseStateFile) => { write: boolean; result: T },
	): Promise<T> {
		this.assertOpen();
		return runExclusive(this.filePath, async () => {
			await this.ensureWriteLock();
			const state = await this.readState();
			const outcome = fn(state);
			if (!outcome.write) return outcome.result;
			state.revision = state.revision + 1;
			await writeJsonDurable(this.filePath, state).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			return outcome.result;
		});
	}

	/**
	 * Serialized read-check-write for a destructive operation.
	 *
	 * The callback may `await` an outside owner (B2/L1 evidence probe) and still
	 * be atomic with respect to every other course write, because the queue slot
	 * and the writer lock are held for the whole callback. A thrown error — a
	 * refusal or a failed probe — aborts before `writeJsonDurable`, so the
	 * previous state stays byte-identical.
	 */
	private async mutateGuarded<T>(
		fn: (state: CourseStateFile) => Promise<{ write: boolean; result: T }>,
	): Promise<T> {
		this.assertOpen();
		return runExclusive(this.filePath, async () => {
			await this.ensureWriteLock();
			const state = await this.readState();
			const outcome = await fn(state);
			if (!outcome.write) return outcome.result;
			state.revision = state.revision + 1;
			await writeJsonDurable(this.filePath, state).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			return outcome.result;
		});
	}
}

/**
 * A task counts as learning history once it left `pending` or was completed
 * once. Both signals are kept because a legacy row may carry `completed_at`
 * without the matching status.
 */
function isStartedTask(task: LearningTask): boolean {
	return task.status !== "pending" || Boolean(task.completed_at);
}

/**
 * How long a sessionless 「开始学习」 reservation may block a delete.
 *
 * E4.7-R1: `learning/start` used to leave a `creating` record behind when the
 * chat queue was busy, and the delete preview reported it forever as a
 * 「尚未结束的学习启动请求」. Session creation takes milliseconds, so a
 * sessionless record older than this window is an abandoned attempt, not work
 * in flight. A record that already names a session is always honoured — it may
 * be the only pointer to a real conversation.
 */
const PENDING_START_BLOCK_WINDOW_MS = 15 * 60 * 1000;

function isUnfinishedStart(start: LearningStart, nowMs: number): boolean {
	if (start.status !== "creating" && start.status !== "created") return false;
	if (start.session_id) return true;
	const updated = Date.parse(start.updated_at || start.created_at);
	// An unreadable timestamp cannot prove the attempt is stale: keep blocking.
	if (!Number.isFinite(updated)) return true;
	return nowMs - updated <= PENDING_START_BLOCK_WINDOW_MS;
}

/** Union by code: an outside owner may repeat a reason this store already found. */
function mergeBlockers(base: DeletionBlocker[], extra: DeletionBlocker[]): DeletionBlocker[] {
	const merged = [...base];
	const seen = new Set(base.map((blocker) => blocker.code));
	for (const blocker of extra) {
		if (seen.has(blocker.code)) continue;
		seen.add(blocker.code);
		merged.push(blocker);
	}
	return merged;
}

function assertDeletable(blockers: DeletionBlocker[], message: string): void {
	if (blockers.length === 0) return;
	throw new CourseStoreError("COURSE_CONFLICT", message, { blockers });
}

/**
 * E4.7-R2 — per-task detail for the delete preview.
 *
 * The evidence classification is derived from two independent facts only: a
 * bound conversation exists, and (filled later by the route) that conversation
 * holds a formal B2 attempt. A task status is never promoted to evidence — a
 * `completed` checkbox with no conversation is exactly the case the dialog must
 * mark 「仅有任务进度，证据待核实」.
 *
 * Ordering follows the plan/stage order so the dialog reads like the course,
 * not like a random filter result.
 */
function startedTaskDetails(
	state: CourseStateFile,
	tasks: readonly LearningTask[],
): CourseDeletionTaskDetail[] {
	const plans = new Map(state.plans.map((plan) => [plan.plan_id, plan]));
	const stages = new Map(state.stages.map((stage) => [stage.stage_id, stage]));
	return tasks
		.filter(isStartedTask)
		.map((task) => {
			const plan = task.plan_id ? plans.get(task.plan_id) : undefined;
			const stage = task.stage_id ? stages.get(task.stage_id) : undefined;
			const bindings = state.session_bindings
				.filter((binding) => binding.task_id === task.task_id)
				.sort((a, b) => b.created_at.localeCompare(a.created_at));
			const detail: CourseDeletionTaskDetail = {
				task_id: task.task_id,
				task_title: task.title,
				plan_id: plan?.plan_id ?? null,
				plan_title: plan?.title ?? null,
				stage_id: stage?.stage_id ?? null,
				stage_title: stage?.title ?? null,
				task_status: task.status,
				updated_at: task.updated_at,
				session_bound: bindings.length > 0,
				session_ids: bindings.map((binding) => binding.session_id),
				// Filled from B2 by the route; a status is not evidence.
				b2_evidence: false,
				b2_evidence_count: null,
				evidence_state: bindings.length > 0 ? "session_bound" : "task_progress_only",
			};
			if (task.completed_at) detail.completed_at = task.completed_at;
			return detail;
		});
}

/**
 * E4.7-R2a — every conversation bound to a course, with its task context.
 *
 * Unlike `startedTaskDetails`, this is driven by bindings, not task status: a
 * pending task can already own a conversation, and a course-level session may
 * have no task at all. Both block a delete and must be locatable.
 *
 * `archived` / B2 fields are resolved by the route (different owners); this
 * snapshot only knows what `state.json` holds.
 */
function deletionSessionDetails(
	state: CourseStateFile,
	courseId: string,
): CourseDeletionSessionDetail[] {
	const tasks = new Map(
		state.tasks.filter((task) => task.course_id === courseId).map((task) => [task.task_id, task]),
	);
	const plans = new Map(state.plans.map((plan) => [plan.plan_id, plan]));
	const stages = new Map(state.stages.map((stage) => [stage.stage_id, stage]));
	return state.session_bindings
		.filter((binding) => binding.course_id === courseId)
		.sort((a, b) => b.created_at.localeCompare(a.created_at))
		.map((binding) => {
			const task = binding.task_id ? tasks.get(binding.task_id) ?? null : null;
			const plan = task?.plan_id ? plans.get(task.plan_id) ?? null : null;
			const stage = task?.stage_id ? stages.get(task.stage_id) ?? null : null;
			return {
				session_id: binding.session_id,
				origin: binding.origin,
				created_at: binding.created_at,
				task_id: task?.task_id ?? null,
				task_title: task?.title ?? null,
				task_status: task?.status ?? null,
				plan_id: plan?.plan_id ?? null,
				plan_title: plan?.title ?? null,
				stage_title: stage?.title ?? null,
				archived: null,
				b2_evidence_count: null,
				b2_evidence: false,
			};
		});
}

/**
 * Course delete preflight. Blockers are ordered by how directly they prove a
 * learning record: sessions, then started tasks, then an in-flight start.
 * Mastery evidence is appended by the caller because L1 is not owned here.
 */
function courseDeletionReport(state: CourseStateFile, courseId: string, nowMs: number): CourseDeletionReport {
	const course = findCourse(state, courseId);
	const plans = state.plans.filter((plan) => plan.course_id === courseId);
	const stages = state.stages.filter((stage) => stage.course_id === courseId);
	const tasks = state.tasks.filter((task) => task.course_id === courseId);
	const sessions = state.session_bindings.filter((binding) => binding.course_id === courseId);
	const goals = state.goal_bindings.filter((binding) => binding.course_id === courseId);
	const sources = state.source_bindings.filter(
		(binding) => binding.course_id === courseId && binding.status === "active",
	);
	const startedTasks = tasks.filter(isStartedTask);
	const pendingStarts = state.learning_starts.filter(
		(start) => start.course_id === courseId && isUnfinishedStart(start, nowMs),
	);
	const blockers: DeletionBlocker[] = [];
	if (sessions.length > 0) {
		blockers.push({
			code: "course_sessions",
			count: sessions.length,
			message: `该课程已有 ${sessions.length} 个学习会话，会话与学习记录必须保留，请改用归档。`,
		});
	}
	if (startedTasks.length > 0) {
		blockers.push({
			code: "started_tasks",
			count: startedTasks.length,
			message: `该课程有 ${startedTasks.length} 个任务已开始或完成，属于真实学习记录，请改用归档。`,
		});
	}
	if (pendingStarts.length > 0) {
		blockers.push({
			code: "pending_learning_start",
			count: pendingStarts.length,
			message: "该课程有尚未结束的学习启动请求，请稍后重试，或改用归档。",
		});
	}
	return {
		course_id: courseId,
		title: course.title,
		deletable: blockers.length === 0,
		blockers,
		counts: {
			plans: plans.length,
			stages: stages.length,
			tasks: tasks.length,
			started_tasks: startedTasks.length,
			sessions: sessions.length,
			goals: goals.length,
			sources: sources.length,
		},
		has_material: sources.length > 0,
		started_task_details: startedTaskDetails(state, tasks),
		session_details: deletionSessionDetails(state, courseId),
	};
}

/** Plan delete preflight. A `completed` plan is history by definition. */
function planDeletionReport(state: CourseStateFile, courseId: string, planId: string, nowMs: number): PlanDeletionReport {
	const plan = findPlan(state, courseId, planId);
	const stages = state.stages.filter((stage) => stage.plan_id === planId && stage.course_id === courseId);
	const tasks = state.tasks.filter((task) => task.plan_id === planId && task.course_id === courseId);
	const taskIds = new Set(tasks.map((task) => task.task_id));
	const sessions = state.session_bindings.filter(
		(binding) => binding.task_id !== null && taskIds.has(binding.task_id),
	);
	const completedTasks = tasks.filter((task) => task.status === "completed" || Boolean(task.completed_at));
	const startedTasks = tasks.filter(isStartedTask);
	const pendingStarts = state.learning_starts.filter(
		(start) => start.course_id === courseId
			&& start.task_id !== null
			&& taskIds.has(start.task_id)
			&& isUnfinishedStart(start, nowMs),
	);
	const blockers: DeletionBlocker[] = [];
	if (sessions.length > 0) {
		blockers.push({
			code: "plan_sessions",
			count: sessions.length,
			message: `该计划的任务已绑定 ${sessions.length} 个学习会话，只能归档。`,
		});
	}
	if (startedTasks.length > 0) {
		blockers.push({
			code: "started_tasks",
			count: startedTasks.length,
			message: `该计划有 ${startedTasks.length} 个任务已开始或完成，只能归档。`,
		});
	}
	if (pendingStarts.length > 0) {
		blockers.push({
			code: "pending_learning_start",
			count: pendingStarts.length,
			message: "该计划有尚未结束的学习启动请求，请稍后重试，或改用归档。",
		});
	}
	if (plan.status === "completed") {
		blockers.push({ code: "plan_completed", message: "该计划已完成，只能归档。" });
	}
	return {
		course_id: courseId,
		plan_id: planId,
		title: plan.title,
		status: plan.status,
		deletable: blockers.length === 0,
		blockers,
		counts: {
			stages: stages.length,
			tasks: tasks.length,
			completed_tasks: completedTasks.length,
			started_tasks: startedTasks.length,
			sessions: sessions.length,
		},
		started_task_details: startedTaskDetails(state, tasks),
	};
}

/**
 * Remove every row that belongs *only* to this course.
 *
 * Shared records are deliberately untouched: L2 documents (their bindings are
 * associations, not copies), L1 goals and states, L3 recall and B2 evidence.
 * A refusal earlier in the transaction guarantees no session binding can be
 * dropped here, so `sessions` in the outcome is always 0 — the filter is the
 * invariant, not a cleanup path.
 */
function purgeCourse(state: CourseStateFile, courseId: string): DeletionOutcome["removed"] {
	const removed: DeletionOutcome["removed"] = {
		plans: state.plans.filter((plan) => plan.course_id === courseId).length,
		stages: state.stages.filter((stage) => stage.course_id === courseId).length,
		tasks: state.tasks.filter((task) => task.course_id === courseId).length,
		sessions: state.session_bindings.filter((binding) => binding.course_id === courseId).length,
		goals: state.goal_bindings.filter((binding) => binding.course_id === courseId).length,
		sources: state.source_bindings.filter((binding) => binding.course_id === courseId).length,
		learning_starts: state.learning_starts.filter((start) => start.course_id === courseId).length,
	};
	state.courses = state.courses.filter((course) => course.course_id !== courseId);
	state.plans = state.plans.filter((plan) => plan.course_id !== courseId);
	state.stages = state.stages.filter((stage) => stage.course_id !== courseId);
	state.tasks = state.tasks.filter((task) => task.course_id !== courseId);
	state.session_bindings = state.session_bindings.filter((binding) => binding.course_id !== courseId);
	state.goal_bindings = state.goal_bindings.filter((binding) => binding.course_id !== courseId);
	state.source_bindings = state.source_bindings.filter((binding) => binding.course_id !== courseId);
	state.study_settings = state.study_settings.filter((settings) => settings.course_id !== courseId);
	state.learning_starts = state.learning_starts.filter((start) => start.course_id !== courseId);
	return removed;
}

/** Remove one plan's planning state: its stages, its tasks and their start log. */
function purgePlan(state: CourseStateFile, courseId: string, planId: string): DeletionOutcome["removed"] {
	const taskIds = new Set(
		state.tasks
			.filter((task) => task.plan_id === planId && task.course_id === courseId)
			.map((task) => task.task_id),
	);
	const removed: DeletionOutcome["removed"] = {
		plans: state.plans.filter((plan) => plan.plan_id === planId && plan.course_id === courseId).length,
		stages: state.stages.filter((stage) => stage.plan_id === planId && stage.course_id === courseId).length,
		tasks: taskIds.size,
		sessions: state.session_bindings.filter(
			(binding) => binding.task_id !== null && taskIds.has(binding.task_id),
		).length,
		goals: 0,
		sources: 0,
		learning_starts: state.learning_starts.filter(
			(start) => start.task_id !== null && taskIds.has(start.task_id),
		).length,
	};
	state.plans = state.plans.filter((plan) => !(plan.plan_id === planId && plan.course_id === courseId));
	state.stages = state.stages.filter((stage) => !(stage.plan_id === planId && stage.course_id === courseId));
	state.tasks = state.tasks.filter((task) => !(task.plan_id === planId && task.course_id === courseId));
	state.learning_starts = state.learning_starts.filter(
		(start) => start.task_id === null || !taskIds.has(start.task_id),
	);
	return removed;
}

function normalizeStageDescription(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw invalid("阶段说明必须是字符串");
	if (value.length > MAX_STAGE_DESCRIPTION) throw invalid("阶段说明过长");
	return value.trim();
}

function byStageOrder(a: PlanStage, b: PlanStage): number {
	return a.order - b.order || a.created_at.localeCompare(b.created_at);
}

function assertDraft(plan: StudyPlan): void {
	if (plan.status !== "draft") {
		throw new CourseStoreError("COURSE_CONFLICT", "只有草稿计划可以整体编辑", {
			currentRevision: plan.revision,
		});
	}
}

function assertRevision(plan: StudyPlan, expected: number): void {
	if (plan.revision !== expected) {
		throw new CourseStoreError("COURSE_CONFLICT", "计划已被修改，请重新加载后再试", {
			currentRevision: plan.revision,
		});
	}
}

/**
 * Allowed plan status transitions. `draft → active` is deliberately absent:
 * confirmation is a dedicated operation with its own revision check and
 * active-plan handling, so a generic status patch can never bypass it.
 */
function assertPlanTransition(plan: StudyPlan, next: StudyPlanStatus): void {
	if (plan.origin === "agent_suggested" && plan.status === "draft" && next === "active") {
		throw new CourseStoreError("COURSE_CONFLICT", "AI 生成的学习计划必须经用户确认后才能启用", {
			currentRevision: plan.revision,
		});
	}
	if (plan.status === "draft") {
		if (next === "completed") throw invalid("草稿计划不能直接标记为已完成");
		return;
	}
	if (plan.status === "completed" || plan.status === "archived") {
		throw new CourseStoreError("COURSE_CONFLICT", "已结束的计划不能变更状态", {
			currentRevision: plan.revision,
		});
	}
	// active → completed / archived is allowed.
	if (next === "draft") throw invalid("已启用的计划不能退回草稿");
}

function nextOrder(tasks: readonly LearningTask[]): number {
	return tasks.reduce((max, task) => (Number.isSafeInteger(task.order) ? Math.max(max, task.order + 1) : max), 0);
}

/** Move one task to `target`, shifting the others to keep a dense 0..n-1 order. */
function moveTask(state: CourseStateFile, task: LearningTask, target: number): void {
	const group = sortTasks(state.tasks.filter((candidate) => candidate.plan_id === task.plan_id
		&& candidate.course_id === task.course_id
		&& candidate.task_id !== task.task_id));
	const index = Math.min(Math.max(target, 0), group.length);
	group.splice(index, 0, task);
	group.forEach((candidate, position) => { candidate.order = position; });
}

function shiftTasksFrom(state: CourseStateFile, planId: string, from: number): void {
	for (const task of state.tasks) {
		if (task.plan_id === planId && task.order >= from) task.order += 1;
	}
}

function reindexTasks(state: CourseStateFile, courseId: string, planId: string | null): void {
	const group = sortTasks(state.tasks.filter((task) => task.course_id === courseId
		&& (planId === null ? !task.plan_id : task.plan_id === planId)));
	group.forEach((task, index) => { task.order = index; });
}

function assertStructureLimits(
	stages: ReadonlyArray<{ tasks?: readonly unknown[] }>,
	looseTasks: readonly unknown[],
): void {
	if (stages.length > MAX_PLAN_STAGES) throw invalid("学习阶段数量过多");
	let total = looseTasks.length;
	for (const stage of stages) {
		const count = stage.tasks?.length ?? 0;
		if (count > MAX_STAGE_TASKS) throw invalid("单个阶段的任务数量过多");
		total += count;
	}
	if (total > MAX_PLAN_TASKS) throw invalid("计划任务数量过多");
}

/**
 * Build a validated task record. `existing` is supplied when a draft replace
 * updates a row: identity and progress survive, planning fields are replaced.
 */
function buildTask(
	courseId: string,
	planId: string | null,
	stageId: string | null,
	order: number,
	input: TaskDraft,
	now: string,
	existing?: LearningTask,
): LearningTask {
	const title = normalizeTitle(input.title, "任务标题", MAX_TASK_TITLE);
	// Omitted fields mean "unchanged" when replacing an existing row, not
	// "clear": a draft edit that only renames a task must not silently drop its
	// concepts, sources, estimate or citations.
	const conceptIds = input.conceptIds === undefined
		? [...(existing?.concept_ids ?? [])]
		: idList(input.conceptIds, "概念 ID");
	const sourceIdsProvided = input.sourceIds !== undefined;
	const sourceIds = sourceIdsProvided
		? idList(input.sourceIds, "资料 ID")
		: [...(existing?.source_ids ?? [])];
	const conceptLabels = input.conceptLabels === undefined
		? existing?.concept_labels
		: conceptLabelList(input.conceptLabels, conceptIds);
	let sourceRefs = input.sourceRefs === undefined
		? existing?.source_refs
		: sourceRefList(input.sourceRefs);
	if (sourceRefs && sourceIdsProvided) {
		// A changed source list invalidates refs to removed sources; keeping them
		// would make the task cite material it no longer belongs to.
		const before = new Set(existing?.source_ids ?? []);
		const changed = before.size !== sourceIds.length || sourceIds.some((id) => !before.has(id));
		if (changed) {
			const kept = sourceRefs.filter((ref) => sourceIds.includes(ref.source_id));
			sourceRefs = kept.length > 0 ? kept : undefined;
		}
	}
	const estimatedMinutes = input.estimatedMinutes === undefined
		? existing?.estimated_minutes ?? null
		: optionalMinutes(input.estimatedMinutes, "预计学习时长");
	const difficulty = input.difficulty === undefined
		? existing?.difficulty ?? "standard"
		: normalizeDifficulty(input.difficulty);
	const rationale = input.rationale === undefined
		? existing?.rationale
		: normalizeRationale(input.rationale);
	// E4.6-R2: a draft payload may not assert progress. A new row is always
	// `pending`; an existing row keeps the status it already earned (a status
	// change is not a planning edit). Omitting `status` therefore means
	// "unchanged", never "reset".
	if (input.status !== undefined && input.status !== "pending" && input.status !== existing?.status) {
		throw new CourseStoreError("COURSE_CONFLICT", "草稿编辑不能修改任务进度；进度只能通过学习流程推进");
	}
	const status = existing?.status ?? "pending";
	if (!isTaskStatus(status)) throw invalid("任务状态不合法");
	const completedAt = status === "completed" ? existing?.completed_at ?? now : undefined;
	return {
		task_id: existing?.task_id ?? nextId("task"),
		course_id: courseId,
		plan_id: planId,
		stage_id: stageId,
		title,
		order,
		estimated_minutes: estimatedMinutes,
		difficulty,
		concept_ids: conceptIds,
		...(conceptLabels ? { concept_labels: conceptLabels } : {}),
		source_ids: sourceIds,
		...(sourceRefs && sourceRefs.length > 0 ? { source_refs: sourceRefs } : {}),
		...(rationale ? { rationale } : {}),
		status,
		...(completedAt ? { completed_at: completedAt } : {}),
		created_at: existing?.created_at ?? now,
		updated_at: now,
	};
}

function countsOf(state: CourseStateFile, courseId: string): CourseCounts {
	return {
		goals: state.goal_bindings.filter((binding) => binding.course_id === courseId).length,
		plans: state.plans.filter((plan) => plan.course_id === courseId).length,
		tasks: state.tasks.filter((task) => task.course_id === courseId).length,
		sessions: state.session_bindings.filter((binding) => binding.course_id === courseId).length,
		sources: state.source_bindings.filter(
			(binding) => binding.course_id === courseId && binding.status === "active",
		).length,
	};
}

function sourceRefSignature(refs: readonly TaskSourceRef[] | undefined): string {
	return (refs ?? []).map((ref) => [
		ref.source_id,
		ref.page_path,
		ref.heading_path ?? "",
		ref.page_start ?? "",
		ref.page_end ?? "",
		ref.unit_id ?? "",
	].join("\u0000")).join("\u0001");
}

/** Citations are server output; a draft edit may only round-trip them. */
function assertSameSourceRefs(input: readonly TaskSourceRef[] | undefined, existing: readonly TaskSourceRef[] | undefined): void {
	if (sourceRefSignature(input) !== sourceRefSignature(existing)) {
		throw invalid("来源引用只能沿用服务端已生成的内容，不能新增或修改");
	}
}

/**
 * A whole-draft payload may reference existing rows, but each id may appear
 * once. Duplicate stage/task ids would otherwise write two rows with the same
 * identity and make every later update ambiguous.
 */
function assertUniqueDraftIds(stages: readonly StageDraft[], looseTasks: readonly TaskDraft[]): void {
	const stageIds = new Set<string>();
	for (const stage of stages) {
		if (!stage.stage_id) continue;
		if (stageIds.has(stage.stage_id)) throw invalid("阶段 ID 重复");
		stageIds.add(stage.stage_id);
	}
	const taskIds = new Set<string>();
	for (const task of [...stages.flatMap((stage) => stage.tasks ?? []), ...looseTasks]) {
		if (!task.task_id) continue;
		if (taskIds.has(task.task_id)) throw invalid("任务 ID 重复");
		taskIds.add(task.task_id);
	}
}

function assertUniqueStageIds(stages: ReadonlyArray<{ stage_id?: string | null }>): void {
	const seen = new Set<string>();
	for (const stage of stages) {
		if (!stage.stage_id) continue;
		if (seen.has(stage.stage_id)) throw invalid("阶段 ID 重复");
		seen.add(stage.stage_id);
	}
}

/**
 * A plan may name only a goal that is explicitly bound to the same course.
 * Without this, a plan could silently attach itself to another course's goal
 * and the course view would report a relation that was never established.
 */
function assertGoalBound(state: CourseStateFile, courseId: string, goalId: string): void {
	const bound = state.goal_bindings.some(
		(binding) => binding.course_id === courseId && binding.goal_id === goalId,
	);
	if (!bound) {
		throw new CourseStoreError("COURSE_CONFLICT", "学习目标未与该课程建立关联");
	}
}

function findCourse(state: CourseStateFile, courseId: string): Course {
	const course = state.courses.find((candidate) => candidate.course_id === courseId);
	if (!course) throw new CourseStoreError("COURSE_NOT_FOUND", "课程不存在");
	return course;
}

/**
 * E4.7-R1 — an archived course is read-only for learning progress.
 *
 * Archiving used to be presentation-only: `learning/start` still created a
 * session, advanced a task and opened a B2 record inside a course the learner
 * had put away. Those are exactly the writes that turn history into new
 * evidence, so they are refused inside the same write transaction that would
 * apply them. Planning edits and record cleanup stay allowed — they add no
 * evidence and let the learner prepare before restoring the course.
 */
function assertCourseNotArchived(state: CourseStateFile, courseId: string, action: string): Course {
	const course = findCourse(state, courseId);
	if (course.status === "archived") {
		throw new CourseStoreError("COURSE_ARCHIVED", `课程已归档，不能${action}；请先在设置中恢复课程。`);
	}
	return course;
}

function findPlan(state: CourseStateFile, courseId: string, planId: string): StudyPlan {
	const plan = state.plans.find((candidate) => candidate.plan_id === planId && candidate.course_id === courseId);
	if (!plan) {
		// A plan that exists under another course is not "missing": naming it
		// from the wrong course is a cross-course association attempt.
		if (state.plans.some((candidate) => candidate.plan_id === planId)) {
			throw new CourseStoreError("COURSE_CONFLICT", "学习计划不属于该课程");
		}
		throw new CourseStoreError("COURSE_NOT_FOUND", "学习计划不存在");
	}
	return plan;
}

/**
 * E4.6-R1 — a task that belongs to a plan may only get a learning session once
 * that plan is `active`.
 *
 * A draft is the learner's editing surface: its tasks are a proposal, not work
 * that happened. Binding a session to one would create a real learning record
 * (and a real B2 trail) for something the learner never confirmed, which is
 * exactly the "record before confirmation" defect. `learning/start` already
 * refuses this; the manual-bind path reaches the same store method, so the rule
 * lives here, inside the write transaction, and no entry point can skip it.
 *
 * A task without a plan is free learning and is unaffected.
 */
function assertTaskPlanExecutable(state: CourseStateFile, task: LearningTask): void {
	if (!task.plan_id) return;
	const plan = state.plans.find((candidate) => candidate.plan_id === task.plan_id);
	if (!plan) {
		throw new CourseStoreError("COURSE_TASK_PLAN_MISMATCH", "任务所属的学习计划不存在，不能关联学习会话");
	}
	if (plan.status !== "active") {
		throw new CourseStoreError("COURSE_CONFLICT", "任务所属的计划尚未确认启用，不能开始学习");
	}
}

/**
 * E4.6-R2 — task progress may only move for a task whose plan is executable.
 *
 * `draft` is a proposal the learner has not confirmed. Letting a status patch
 * move one of its tasks to `in_progress`/`completed` would record progress for
 * work that was never confirmed, and the records view would show it. The rule
 * lives in the store so no route (task PATCH, plan draft replace) can bypass it.
 *
 * A task without a plan is free learning: its status may still change.
 * Nothing here writes L1 or B2 — a status change is not learning evidence.
 */
function assertTaskProgressAllowed(state: CourseStateFile, task: LearningTask): void {
	if (!task.plan_id) return;
	const plan = state.plans.find((candidate) => candidate.plan_id === task.plan_id);
	if (!plan) {
		throw new CourseStoreError("COURSE_TASK_PLAN_MISMATCH", "任务所属的学习计划不存在，不能更新任务进度");
	}
	if (plan.status === "draft") {
		throw new CourseStoreError("COURSE_CONFLICT", "草稿计划的任务尚未开始，不能更新进度；请先确认启用计划");
	}
	if (plan.status === "archived") {
		// History is frozen: an archived plan's progress must not be rewritten.
		throw new CourseStoreError("COURSE_CONFLICT", "已归档计划的任务进度不能修改");
	}
}

/**
 * E4.6-R2b — moving a task into a `draft` plan is only allowed for a task that
 * carries no learning yet.
 *
 * A draft is the learner's planning surface; a task in it must be work that has
 * not happened. Moving an `in_progress`/`completed` task — or one that owns a
 * session (which is what makes its progress a real record) — into a draft would
 * put real learning behind an unconfirmed plan: the records view would drop it
 * and the plan would look unstarted while B2 keeps the evidence.
 *
 * Refusing is the only safe answer. Deleting the progress or the session instead
 * would destroy history, and silently downgrading the task to `pending` would
 * hide work the learner actually did. The learner can still move an unstarted
 * task into a draft to plan with it.
 */
function assertDraftMoveAllowed(state: CourseStateFile, task: LearningTask, target: StudyPlan): void {
	if (target.status !== "draft") return;
	if (task.status !== "pending") {
		throw new CourseStoreError("COURSE_CONFLICT", "已有学习进度的任务不能移入未启用的草稿计划");
	}
	const bound = state.session_bindings.find((binding) => binding.task_id === task.task_id);
	if (bound) {
		throw new CourseStoreError("COURSE_CONFLICT", "已绑定学习会话的任务不能移入未启用的草稿计划");
	}
}

/**
 * A task has one default learning session. Checked inside `mutate`, never in a
 * separate read, so concurrent binders cannot both pass it.
 */
function assertTaskHasSingleSession(
	state: CourseStateFile,
	courseId: string,
	taskId: string,
	sessionId: string,
): void {
	const other = state.session_bindings.find(
		(binding) => binding.course_id === courseId
			&& binding.task_id === taskId
			&& binding.session_id !== sessionId,
	);
	if (other) {
		throw new CourseStoreError(
			"COURSE_SESSION_CONFLICT",
			"该学习任务已绑定另一个学习会话，不能新增第二个任务会话",
		);
	}
}

/** Grouped duplicates, oldest session first so a reader can pick deterministically. */
function duplicateTaskBindings(
	state: CourseStateFile,
	courseId: string,
): Array<{ task_id: string; session_ids: string[] }> {
	const groups = new Map<string, CourseSessionBinding[]>();
	for (const binding of state.session_bindings) {
		if (binding.course_id !== courseId || !binding.task_id) continue;
		const list = groups.get(binding.task_id) ?? [];
		list.push(binding);
		groups.set(binding.task_id, list);
	}
	const duplicates: Array<{ task_id: string; session_ids: string[] }> = [];
	for (const [taskId, bindings] of groups) {
		if (bindings.length < 2) continue;
		duplicates.push({
			task_id: taskId,
			session_ids: [...bindings]
				.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.session_id.localeCompare(b.session_id))
				.map((binding) => binding.session_id),
		});
	}
	return duplicates.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

function findTask(state: CourseStateFile, courseId: string, taskId: string): LearningTask {
	const task = state.tasks.find((candidate) => candidate.task_id === taskId && candidate.course_id === courseId);
	if (!task) {
		if (state.tasks.some((candidate) => candidate.task_id === taskId)) {
			throw new CourseStoreError("COURSE_CONFLICT", "学习任务不属于该课程");
		}
		throw new CourseStoreError("COURSE_NOT_FOUND", "学习任务不存在");
	}
	return task;
}
