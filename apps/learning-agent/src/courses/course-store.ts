import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { logger } from "../logger.js";
import { FileStoreError, readJsonStrict, writeJsonDurable } from "../storage/file-store.js";
import { WriterLockError, acquireWriterLock, type WriterLockHandle } from "../storage/writer-lock.js";
import {
	MAX_COURSE_TITLE,
	MAX_DESCRIPTION,
	MAX_ID_LIST,
	MAX_PLAN_TITLE,
	MAX_TASK_TITLE,
	isCourseStatus,
	isPlanOrigin,
	isPlanStatus,
	isSafeRecordId,
	isSessionOrigin,
	isSourceBindingStatus,
	isTaskStatus,
	type Course,
	type CourseCounts,
	type CourseGoalBinding,
	type CourseSessionBinding,
	type CourseSessionOrigin,
	type CourseSourceBinding,
	type CourseStatus,
	type LearningTask,
	type LearningTaskStatus,
	type StudyPlan,
	type StudyPlanOrigin,
	type StudyPlanStatus,
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
	| "COURSE_WRITER_LOCK"
	| "COURSE_LOCK_LOST"
	| "COURSE_CLOSED";

export class CourseStoreError extends Error {
	readonly code: CourseStoreErrorCode;

	constructor(code: CourseStoreErrorCode, message: string) {
		super(message);
		this.name = "CourseStoreError";
		this.code = code;
	}
}

export interface CourseStateFile {
	schema_version: 1;
	/** Monotonic per-file write counter; diagnostics and optimistic guards. */
	revision: number;
	courses: Course[];
	goal_bindings: CourseGoalBinding[];
	plans: StudyPlan[];
	tasks: LearningTask[];
	session_bindings: CourseSessionBinding[];
	source_bindings: CourseSourceBinding[];
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
}

export interface UpdatePlanInput {
	title?: string;
	description?: string;
	status?: StudyPlanStatus;
	goalId?: string | null;
}

export interface CreateTaskInput {
	title: string;
	planId?: string | null;
	conceptIds?: string[];
	sourceIds?: string[];
	status?: LearningTaskStatus;
}

export interface UpdateTaskInput {
	title?: string;
	status?: LearningTaskStatus;
	planId?: string | null;
	conceptIds?: string[];
	sourceIds?: string[];
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
		tasks: [],
		session_bindings: [],
		source_bindings: [],
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
	}));
	state.tasks = state.tasks.map((task) => ({
		...task,
		plan_id: task.plan_id ?? null,
		concept_ids: Array.isArray(task.concept_ids) ? task.concept_ids : [],
		source_ids: Array.isArray(task.source_ids) ? task.source_ids : [],
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
	return state;
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
			tasks: state.tasks
				.filter((task) => task.course_id === courseId)
				.sort((a, b) => a.created_at.localeCompare(b.created_at)),
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

	async listTasks(courseId: string, planId?: string | null): Promise<LearningTask[]> {
		const state = await this.readState();
		return state.tasks
			.filter((task) => task.course_id === courseId && (planId === undefined || task.plan_id === planId))
			.sort((a, b) => a.created_at.localeCompare(b.created_at));
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

	/** Binding for a session, or `undefined` for a legacy/unclassified session. */
	async getSessionBinding(sessionId: string): Promise<CourseSessionBinding | undefined> {
		if (!isSafeRecordId(sessionId)) return undefined;
		const state = await this.readState();
		return state.session_bindings.find((binding) => binding.session_id === sessionId);
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
			findCourse(state, input.courseId);
			if (taskId) findTask(state, input.courseId, taskId);
			const existing = state.session_bindings.find((binding) => binding.session_id === input.sessionId);
			if (existing) {
				if (existing.course_id !== input.courseId) {
					throw new CourseStoreError("COURSE_SESSION_CONFLICT", "该会话已属于另一门课程，不能改绑");
				}
				if (taskId && !existing.task_id) {
					existing.task_id = taskId;
					return { binding: existing, created: false };
				}
				if (taskId && existing.task_id !== taskId) {
					throw new CourseStoreError("COURSE_SESSION_CONFLICT", "该会话已绑定另一个学习任务，不能改绑");
				}
				return { binding: existing, created: false };
			}
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
	// Plans
	// ------------------------------------------------------------------

	/**
	 * Create a plan. An agent-suggested plan is forced to `draft`: it becomes
	 * usable only after the learner confirms it (E4.3), never automatically.
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
		const now = this.now().toISOString();
		const plan: StudyPlan = {
			plan_id: nextId("plan"),
			course_id: courseId,
			title,
			description,
			goal_id: goalId,
			status,
			origin,
			created_at: now,
			updated_at: now,
		};
		return this.mutate((state) => {
			findCourse(state, courseId);
			state.plans.push(plan);
			return plan;
		});
	}

	async updatePlan(courseId: string, planId: string, patch: UpdatePlanInput): Promise<StudyPlan> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(planId)) throw invalid("计划 ID 不合法");
		const title = patch.title === undefined ? undefined : normalizeTitle(patch.title, "计划标题", MAX_PLAN_TITLE);
		const description = patch.description === undefined ? undefined : normalizeDescription(patch.description);
		if (patch.status !== undefined && !isPlanStatus(patch.status)) throw invalid("计划状态不合法");
		const goalId = patch.goalId === undefined ? undefined : optionalId(patch.goalId, "学习目标 ID");
		return this.mutate((state) => {
			const plan = findPlan(state, courseId, planId);
			if (title !== undefined) plan.title = title;
			if (description !== undefined) plan.description = description;
			if (patch.status !== undefined) plan.status = patch.status;
			if (goalId !== undefined) plan.goal_id = goalId;
			plan.updated_at = this.now().toISOString();
			return { ...plan };
		});
	}

	// ------------------------------------------------------------------
	// Tasks
	// ------------------------------------------------------------------

	async createTask(courseId: string, input: CreateTaskInput): Promise<LearningTask> {
		if (!isSafeRecordId(courseId)) throw invalid("课程 ID 不合法");
		const title = normalizeTitle(input.title, "任务标题", MAX_TASK_TITLE);
		const planId = optionalId(input.planId, "学习计划 ID");
		const conceptIds = idList(input.conceptIds, "概念 ID");
		const sourceIds = idList(input.sourceIds, "资料 ID");
		const status = input.status === undefined ? "pending" : input.status;
		if (!isTaskStatus(status)) throw invalid("任务状态不合法");
		const now = this.now().toISOString();
		const task: LearningTask = {
			task_id: nextId("task"),
			course_id: courseId,
			plan_id: planId,
			title,
			concept_ids: conceptIds,
			source_ids: sourceIds,
			status,
			created_at: now,
			updated_at: now,
		};
		return this.mutate((state) => {
			findCourse(state, courseId);
			// A task's plan must belong to the same course; a cross-course plan id
			// would make progress reporting attach a task to the wrong curriculum.
			if (planId) findPlan(state, courseId, planId);
			state.tasks.push(task);
			return task;
		});
	}

	async updateTask(courseId: string, taskId: string, patch: UpdateTaskInput): Promise<LearningTask> {
		if (!isSafeRecordId(courseId) || !isSafeRecordId(taskId)) throw invalid("任务 ID 不合法");
		const title = patch.title === undefined ? undefined : normalizeTitle(patch.title, "任务标题", MAX_TASK_TITLE);
		if (patch.status !== undefined && !isTaskStatus(patch.status)) throw invalid("任务状态不合法");
		const planId = patch.planId === undefined ? undefined : optionalId(patch.planId, "学习计划 ID");
		const conceptIds = patch.conceptIds === undefined ? undefined : idList(patch.conceptIds, "概念 ID");
		const sourceIds = patch.sourceIds === undefined ? undefined : idList(patch.sourceIds, "资料 ID");
		return this.mutate((state) => {
			const task = findTask(state, courseId, taskId);
			if (planId !== undefined) {
				if (planId) findPlan(state, courseId, planId);
				task.plan_id = planId;
			}
			if (title !== undefined) task.title = title;
			if (patch.status !== undefined) task.status = patch.status;
			if (conceptIds !== undefined) task.concept_ids = conceptIds;
			if (sourceIds !== undefined) task.source_ids = sourceIds;
			task.updated_at = this.now().toISOString();
			return { ...task };
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

function findCourse(state: CourseStateFile, courseId: string): Course {
	const course = state.courses.find((candidate) => candidate.course_id === courseId);
	if (!course) throw new CourseStoreError("COURSE_NOT_FOUND", "课程不存在");
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
