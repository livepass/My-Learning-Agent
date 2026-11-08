import { EventEmitter } from "./event-emitter.js";
import {
	ApiError,
} from "../api/client.js";
import {
	applyPlanSuggestion as apiApplyPlanSuggestion,
	archiveCourse as apiArchiveCourse,
	bindCourseGoal as apiBindCourseGoal,
	bindCourseSource as apiBindCourseSource,
	confirmPlan as apiConfirmPlan,
	conflictRevision,
	courseErrorCode,
	createCourse as apiCreateCourse,
	createPlan as apiCreatePlan,
	generatePlan as apiGeneratePlan,
	getCourse as apiGetCourse,
	getCourseLearner,
	getCourseSessions,
	getCourseSettings,
	getCourseSource,
	getDailyPlans,
	getPlanDetail,
	getPlanSuggestions,
	getSessionCourseContext,
	getUnclassified,
	listCourseSources,
	listCourses,
	listPlans,
	listTasks,
	putCourseSettings,
	replacePlanDraft as apiReplacePlanDraft,
	reorderPlanTasks as apiReorderPlanTasks,
	retryCourseSource,
	startCourseLearning,
	unbindCourseGoal as apiUnbindCourseGoal,
	unbindCourseSource,
	updateCourse as apiUpdateCourse,
	updateTask as apiUpdateTask,
	uploadCourseSource,
	type CourseDailyPlan,
	type CourseDetail,
	type CourseGoalBinding,
	type CourseLearnerView,
	type CourseSettings,
	type CourseSourceView,
	type CourseStatus,
	type CourseSummary,
	type DailyPlanSnapshot,
	type LearningStartResult,
	type LearningTask,
	type PlanDetail,
	type PlanListItem,
	type PlanStructure,
	type PlanSuggestion,
	type PlanSuggestionsResult,
	type SessionCourseContext,
	type StageDraft,
	type StudyPlan,
	type TaskDraft,
	type TaskStatus,
	type UnclassifiedRecords,
} from "../api/courses.js";

interface CoursesStoreEvents {
	change: void;
}

/** Tone of the last write, so pages can style success / error / conflict apart. */
export type CourseFeedbackTone = "success" | "error" | "conflict";

export interface CourseFeedback {
	tone: CourseFeedbackTone;
	message: string;
}

/** One course-scoped session context plus the stage label resolved for it. */
export interface SessionContextEntry {
	context: SessionCourseContext;
	stageTitle?: string;
	/** Non-blocking notices from `learning/start` (e.g. legacy duplicate sessions). */
	warnings: string[];
}

const STAGE_LABEL_CACHE_LIMIT = 40;

function messageOf(err: unknown): string {
	if (err instanceof ApiError) {
		const data = err.data ?? {};
		const serverMessage = typeof data.message === "string" ? data.message : "";
		if (serverMessage) return serverMessage;
		if (err.status === 404) return "该课程或计划不存在，可能已被删除。";
		if (err.status === 409) return "数据已被更新，请重新加载后再试。";
		if (err.status === 503) return "课程数据暂时不可用，请稍后重试。";
		return err.message;
	}
	return err instanceof Error ? err.message : "请求失败，请重试。";
}

function newRequestId(): string {
	const cryptoObject = globalThis.crypto as Crypto | undefined;
	if (cryptoObject?.randomUUID) return `learn_${cryptoObject.randomUUID().replace(/-/g, "")}`;
	return `learn_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Course domain state (E4.5a).
 *
 * The server is the only authority for courses, plans, tasks, material status
 * and learning-start results. This store caches what was last read so several
 * pages can render the same facts without each fetching their own copy, and it
 * never derives a course fact (progress, mastery, "which task is current")
 * that the server already computed.
 *
 * Isolation rules:
 *
 * - every course-scoped read carries a ticket and the course id it was issued
 *   for; switching course aborts the in-flight request and a late response for
 *   the previous course is dropped instead of overwriting the new one;
 * - reads and writes have separate tickets, so a slow reload cannot erase a
 *   write that committed after it started;
 * - a failed write is reported through `feedback` and, for a 409, the affected
 *   domain is re-read so the page shows the server's current revision.
 */
class CoursesStoreImpl extends EventEmitter<CoursesStoreEvents> {
	// --- course list ---
	courses: CourseSummary[] = [];
	coursesLoading = false;
	coursesError: string | null = null;
	private _coursesTicket = 0;

	// --- cross-course daily snapshot ---
	daily: DailyPlanSnapshot | null = null;
	dailyLoading = false;
	dailyError: string | null = null;
	private _dailyTicket = 0;
	private _dailyController: AbortController | null = null;

	// --- one course's daily snapshot (works for paused/archived too) ---
	courseDaily: DailyPlanSnapshot | null = null;
	courseDailyLoading = false;
	courseDailyError: string | null = null;
	private _courseDailyTicket = 0;

	// --- selected course ---
	selectedCourseId: string | null = null;

	detail: CourseDetail | null = null;
	detailLoading = false;
	detailError: string | null = null;
	private _detailTicket = 0;

	plans: PlanListItem[] = [];
	plansLoading = false;
	plansError: string | null = null;
	private _plansTicket = 0;

	planDetail: PlanDetail | null = null;
	planDetailLoading = false;
	planDetailError: string | null = null;
	private _planDetailTicket = 0;

	suggestions: PlanSuggestionsResult | null = null;
	suggestionsLoading = false;
	suggestionsError: string | null = null;
	private _suggestionsTicket = 0;

	sources: CourseSourceView[] = [];
	sourcesLoading = false;
	sourcesError: string | null = null;
	private _sourcesTicket = 0;

	unclassified: UnclassifiedRecords | null = null;
	unclassifiedLoading = false;
	unclassifiedError: string | null = null;
	private _unclassifiedTicket = 0;

	courseSessions: Awaited<ReturnType<typeof getCourseSessions>> | null = null;
	courseSessionsLoading = false;
	courseSessionsError: string | null = null;
	private _courseSessionsTicket = 0;

	courseLearner: CourseLearnerView | null = null;
	courseLearnerLoading = false;
	courseLearnerError: string | null = null;
	private _courseLearnerTicket = 0;

	courseSettings: CourseSettings | null = null;

	// --- writes ---
	pendingAction: string | null = null;
	feedback: CourseFeedback | null = null;

	// --- session context (course/task shown on the AI learning page) ---
	sessionContexts: Record<string, SessionContextEntry> = {};
	private _sessionContextTicket = 0;
	private _sessionContextController: AbortController | null = null;
	private _stageLabels = new Map<string, Record<string, string>>();

	private _courseController: AbortController | null = null;

	private notify(): void {
		this.emit("change", undefined);
	}

	/** The course id a course-scoped response must still match to be paintable. */
	private courseScoped(courseId: string): boolean {
		return this.selectedCourseId === courseId;
	}

	clearFeedback(): void {
		if (this.feedback === null) return;
		this.feedback = null;
		this.notify();
	}

	// ------------------------------------------------------------------
	// Reads
	// ------------------------------------------------------------------

	async loadCourses(): Promise<void> {
		const ticket = ++this._coursesTicket;
		this.coursesLoading = true;
		this.coursesError = null;
		this.notify();
		try {
			const courses = await listCourses();
			if (ticket !== this._coursesTicket) return;
			this.courses = courses;
		} catch (err) {
			if (ticket !== this._coursesTicket) return;
			this.courses = [];
			this.coursesError = messageOf(err);
		} finally {
			if (ticket === this._coursesTicket) {
				this.coursesLoading = false;
				this.notify();
			}
		}
	}

	async loadDaily(): Promise<void> {
		const ticket = ++this._dailyTicket;
		this._dailyController?.abort();
		const controller = new AbortController();
		this._dailyController = controller;
		this.dailyLoading = true;
		this.dailyError = null;
		this.notify();
		try {
			const snapshot = await getDailyPlans({ signal: controller.signal });
			if (ticket !== this._dailyTicket) return;
			this.daily = snapshot;
		} catch (err) {
			if (controller.signal.aborted || ticket !== this._dailyTicket) return;
			this.daily = null;
			this.dailyError = messageOf(err);
		} finally {
			if (ticket === this._dailyTicket) {
				this.dailyLoading = false;
				this.notify();
			}
		}
	}

	async loadCourseDaily(courseId: string): Promise<void> {
		const ticket = ++this._courseDailyTicket;
		this.courseDailyLoading = true;
		this.courseDailyError = null;
		this.notify();
		try {
			const snapshot = await getDailyPlans({ courseId });
			if (ticket !== this._courseDailyTicket || !this.courseScoped(courseId)) return;
			this.courseDaily = snapshot;
		} catch (err) {
			if (ticket !== this._courseDailyTicket || !this.courseScoped(courseId)) return;
			this.courseDaily = null;
			this.courseDailyError = messageOf(err);
		} finally {
			if (ticket === this._courseDailyTicket) {
				this.courseDailyLoading = false;
				this.notify();
			}
		}
	}

	/**
	 * Select the course a detail view works on.
	 *
	 * Everything course-scoped is dropped first: showing course A's plans under
	 * course B for one frame is exactly the "old response overwrites the new
	 * course" bug this method exists to prevent.
	 */
	selectCourse(courseId: string | null): void {
		if (this.selectedCourseId === courseId) return;
		this.selectedCourseId = courseId;
		this._courseController?.abort();
		this._courseController = null;
		this._detailTicket += 1;
		this._plansTicket += 1;
		this._planDetailTicket += 1;
		this._suggestionsTicket += 1;
		this._sourcesTicket += 1;
		this._unclassifiedTicket += 1;
		this._courseSessionsTicket += 1;
		this._courseLearnerTicket += 1;
		this._courseDailyTicket += 1;
		this.detail = null;
		this.detailLoading = false;
		this.detailError = null;
		this.plans = [];
		this.plansLoading = false;
		this.plansError = null;
		this.planDetail = null;
		this.planDetailLoading = false;
		this.planDetailError = null;
		this.suggestions = null;
		this.suggestionsLoading = false;
		this.suggestionsError = null;
		this.sources = [];
		this.sourcesLoading = false;
		this.sourcesError = null;
		this.unclassified = null;
		this.unclassifiedLoading = false;
		this.unclassifiedError = null;
		this.courseSessions = null;
		this.courseSessionsLoading = false;
		this.courseSessionsError = null;
		this.courseLearner = null;
		this.courseLearnerLoading = false;
		this.courseLearnerError = null;
		this.courseDaily = null;
		this.courseDailyLoading = false;
		this.courseDailyError = null;
		this.courseSettings = null;
		this.pendingAction = null;
		// A write result belongs to the course that produced it; carrying it over
		// would show "计划已确认" under a course the learner just opened.
		this.feedback = null;
		this.notify();
	}

	/**
	 * Start a course-detail read, cancelling the previous one.
	 *
	 * A course switch must release the old request instead of letting it finish
	 * and paint over the course the user is now looking at.
	 */
	private beginCourseRead(): AbortSignal {
		this._courseController?.abort();
		const controller = new AbortController();
		this._courseController = controller;
		return controller.signal;
	}

	async loadDetail(courseId: string): Promise<void> {
		const ticket = ++this._detailTicket;
		const signal = this.beginCourseRead();
		this.detailLoading = true;
		this.detailError = null;
		this.notify();
		try {
			const detail = await apiGetCourse(courseId, signal);
			if (ticket !== this._detailTicket || !this.courseScoped(courseId)) return;
			this.detail = detail;
			// The snapshot already carries the stage labels; cache them so a
			// session context can name the phase without another round trip.
			this._stageLabels.set(courseId, Object.fromEntries(detail.stages.map((stage) => [stage.stage_id, stage.title])));
			this._trimStageLabels();
		} catch (err) {
			if (signal.aborted || ticket !== this._detailTicket || !this.courseScoped(courseId)) return;
			this.detail = null;
			this.detailError = messageOf(err);
		} finally {
			if (ticket === this._detailTicket) {
				this.detailLoading = false;
				this.notify();
			}
		}
	}

	async loadPlans(courseId: string): Promise<void> {
		const ticket = ++this._plansTicket;
		this.plansLoading = true;
		this.plansError = null;
		this.notify();
		try {
			const plans = await listPlans(courseId);
			if (ticket !== this._plansTicket || !this.courseScoped(courseId)) return;
			this.plans = plans;
		} catch (err) {
			if (ticket !== this._plansTicket || !this.courseScoped(courseId)) return;
			this.plans = [];
			this.plansError = messageOf(err);
		} finally {
			if (ticket === this._plansTicket) {
				this.plansLoading = false;
				this.notify();
			}
		}
	}

	async loadPlanDetail(courseId: string, planId: string): Promise<void> {
		const ticket = ++this._planDetailTicket;
		this.planDetailLoading = true;
		this.planDetailError = null;
		this.notify();
		try {
			const detail = await getPlanDetail(courseId, planId);
			if (ticket !== this._planDetailTicket || !this.courseScoped(courseId)) return;
			this.planDetail = detail;
		} catch (err) {
			if (ticket !== this._planDetailTicket || !this.courseScoped(courseId)) return;
			this.planDetail = null;
			this.planDetailError = messageOf(err);
		} finally {
			if (ticket === this._planDetailTicket) {
				this.planDetailLoading = false;
				this.notify();
			}
		}
	}

	async loadSuggestions(courseId: string, planId: string): Promise<void> {
		const ticket = ++this._suggestionsTicket;
		this.suggestionsLoading = true;
		this.suggestionsError = null;
		this.notify();
		try {
			const result = await getPlanSuggestions(courseId, planId);
			if (ticket !== this._suggestionsTicket || !this.courseScoped(courseId)) return;
			this.suggestions = result;
		} catch (err) {
			if (ticket !== this._suggestionsTicket || !this.courseScoped(courseId)) return;
			this.suggestions = null;
			this.suggestionsError = messageOf(err);
		} finally {
			if (ticket === this._suggestionsTicket) {
				this.suggestionsLoading = false;
				this.notify();
			}
		}
	}

	async loadSources(courseId: string): Promise<void> {
		const ticket = ++this._sourcesTicket;
		this.sourcesLoading = true;
		this.sourcesError = null;
		this.notify();
		try {
			const sources = await listCourseSources(courseId);
			if (ticket !== this._sourcesTicket || !this.courseScoped(courseId)) return;
			this.sources = sources;
		} catch (err) {
			if (ticket !== this._sourcesTicket || !this.courseScoped(courseId)) return;
			this.sources = [];
			this.sourcesError = messageOf(err);
		} finally {
			if (ticket === this._sourcesTicket) {
				this.sourcesLoading = false;
				this.notify();
			}
		}
	}

	async loadSourceDetail(courseId: string, sourceId: string) {
		return getCourseSource(courseId, sourceId);
	}

	async loadUnclassified(): Promise<void> {
		const ticket = ++this._unclassifiedTicket;
		this.unclassifiedLoading = true;
		this.unclassifiedError = null;
		this.notify();
		try {
			const records = await getUnclassified();
			if (ticket !== this._unclassifiedTicket) return;
			this.unclassified = records;
		} catch (err) {
			if (ticket !== this._unclassifiedTicket) return;
			this.unclassified = null;
			this.unclassifiedError = messageOf(err);
		} finally {
			if (ticket === this._unclassifiedTicket) {
				this.unclassifiedLoading = false;
				this.notify();
			}
		}
	}

	async loadCourseSessions(courseId: string): Promise<void> {
		const ticket = ++this._courseSessionsTicket;
		this.courseSessionsLoading = true;
		this.courseSessionsError = null;
		this.notify();
		try {
			const sessions = await getCourseSessions(courseId);
			if (ticket !== this._courseSessionsTicket || !this.courseScoped(courseId)) return;
			this.courseSessions = sessions;
		} catch (err) {
			if (ticket !== this._courseSessionsTicket || !this.courseScoped(courseId)) return;
			this.courseSessions = null;
			this.courseSessionsError = messageOf(err);
		} finally {
			if (ticket === this._courseSessionsTicket) {
				this.courseSessionsLoading = false;
				this.notify();
			}
		}
	}

	async loadCourseLearner(courseId: string): Promise<void> {
		const ticket = ++this._courseLearnerTicket;
		this.courseLearnerLoading = true;
		this.courseLearnerError = null;
		this.notify();
		try {
			const view = await getCourseLearner(courseId);
			if (ticket !== this._courseLearnerTicket || !this.courseScoped(courseId)) return;
			this.courseLearner = view;
		} catch (err) {
			if (ticket !== this._courseLearnerTicket || !this.courseScoped(courseId)) return;
			this.courseLearner = null;
			this.courseLearnerError = messageOf(err);
		} finally {
			if (ticket === this._courseLearnerTicket) {
				this.courseLearnerLoading = false;
				this.notify();
			}
		}
	}

	async loadCourseSettings(courseId: string): Promise<void> {
		try {
			const settings = await getCourseSettings(courseId);
			if (!this.courseScoped(courseId)) return;
			this.courseSettings = settings;
			this.notify();
		} catch {
			// A missing budget is not an error: the server falls back to its own
			// default and the page shows "未设置".
			if (!this.courseScoped(courseId)) return;
			this.courseSettings = null;
			this.notify();
		}
	}

	/**
	 * Read the course/task context of one conversation for the AI learning page.
	 *
	 * Ticket + controller: switching conversation must not let the previous
	 * session's course paint over the new one.
	 */
	async loadSessionContext(sessionId: string): Promise<void> {
		const ticket = ++this._sessionContextTicket;
		this._sessionContextController?.abort();
		const controller = new AbortController();
		this._sessionContextController = controller;
		try {
			const context = await getSessionCourseContext(sessionId, controller.signal);
			if (ticket !== this._sessionContextTicket) return;
			let stageTitle: string | undefined;
			if (!context.unclassified && context.course && context.task?.stage_id) {
				stageTitle = await this.resolveStageTitle(context.course.course_id, context.task.stage_id);
				if (ticket !== this._sessionContextTicket) return;
			}
			const previous = this.sessionContexts[sessionId];
			this.sessionContexts = {
				...this.sessionContexts,
				[sessionId]: { context, ...(stageTitle ? { stageTitle } : {}), warnings: previous?.warnings ?? [] },
			};
			this.notify();
		} catch {
			if (controller.signal.aborted || ticket !== this._sessionContextTicket) return;
			// Unclassified/unavailable context simply means "no course strip".
			const previous = this.sessionContexts[sessionId];
			if (previous) {
				this.sessionContexts = {
					...this.sessionContexts,
					[sessionId]: { ...previous, warnings: previous.warnings },
				};
			}
			this.notify();
		}
	}

	private async resolveStageTitle(courseId: string, stageId: string): Promise<string | undefined> {
		const cached = this._stageLabels.get(courseId);
		if (cached) return cached[stageId];
		try {
			const detail = await apiGetCourse(courseId);
			const labels = Object.fromEntries(detail.stages.map((stage) => [stage.stage_id, stage.title]));
			this._stageLabels.set(courseId, labels);
			this._trimStageLabels();
			return labels[stageId];
		} catch {
			return undefined;
		}
	}

	private _trimStageLabels(): void {
		while (this._stageLabels.size > STAGE_LABEL_CACHE_LIMIT) {
			const oldest = this._stageLabels.keys().next().value;
			if (oldest === undefined) return;
			this._stageLabels.delete(oldest);
		}
	}

	/** Attach the warnings returned by `learning/start` to its session entry. */
	recordStartWarnings(sessionId: string, warnings: string[]): void {
		if (warnings.length === 0) return;
		const entry = this.sessionContexts[sessionId];
		if (!entry) return;
		this.sessionContexts = {
			...this.sessionContexts,
			[sessionId]: { ...entry, warnings },
		};
		this.notify();
	}

	sessionContext(sessionId: string | null): SessionContextEntry | undefined {
		if (!sessionId) return undefined;
		return this.sessionContexts[sessionId];
	}

	// ------------------------------------------------------------------
	// Writes
	// ------------------------------------------------------------------

	private async runWrite<T>(
		action: string,
		fn: () => Promise<T>,
		successMessage?: string,
		onConflict?: () => Promise<void>,
	): Promise<T | null> {
		if (this.pendingAction) return null;
		this.pendingAction = action;
		this.feedback = null;
		this.notify();
		try {
			const result = await fn();
			this.feedback = successMessage ? { tone: "success", message: successMessage } : null;
			return result;
		} catch (err) {
			const conflict = err instanceof ApiError && err.status === 409;
			const revision = conflictRevision(err);
			const code = courseErrorCode(err);
			const base = messageOf(err);
			this.feedback = {
				tone: conflict ? "conflict" : "error",
				message: conflict
					? [base, revision !== undefined ? `当前版本 #${revision}，已重新读取。` : "已重新读取最新数据。", code ? `（${code}）` : ""].join("")
					: base,
			};
			if (conflict && onConflict) await onConflict().catch(() => undefined);
			return null;
		} finally {
			this.pendingAction = null;
			this.notify();
		}
	}

	async createCourse(input: { title: string; description?: string }): Promise<CourseSummary | null> {
		const created = await this.runWrite("create_course", () => apiCreateCourse(input), "课程已创建");
		if (!created) return null;
		await this.loadCourses();
		return this.courses.find((course) => course.course_id === created.course_id) ?? null;
	}

	async updateCourse(
		courseId: string,
		patch: { title?: string; description?: string; status?: CourseStatus },
	): Promise<boolean> {
		const updated = await this.runWrite("update_course", () => apiUpdateCourse(courseId, patch), "课程已更新");
		if (!updated) return false;
		await Promise.all([
			this.loadCourses(),
			this.courseScoped(courseId) ? this.loadDetail(courseId) : Promise.resolve(),
			this.loadDaily(),
		]);
		return true;
	}

	async archiveCourse(courseId: string): Promise<boolean> {
		const archived = await this.runWrite("archive_course", () => apiArchiveCourse(courseId), "课程已归档");
		if (!archived) return false;
		await Promise.all([this.loadCourses(), this.loadDaily()]);
		return true;
	}

	async bindGoal(courseId: string, goalId: string): Promise<boolean> {
		const binding = await this.runWrite("bind_goal", () => apiBindCourseGoal(courseId, goalId), "学习目标已关联到课程");
		if (!binding) return false;
		await Promise.all([
			this.courseScoped(courseId) ? this.loadCourseLearner(courseId) : Promise.resolve(),
			this.loadDetailIfCurrent(courseId),
		]);
		return true;
	}

	async unbindGoal(courseId: string, goalId: string): Promise<boolean> {
		const done = await this.runWrite("unbind_goal", async () => {
			await apiUnbindCourseGoal(courseId, goalId);
			return true;
		}, "已解除该课程与学习目标的关联");
		if (!done) return false;
		await Promise.all([
			this.courseScoped(courseId) ? this.loadCourseLearner(courseId) : Promise.resolve(),
			this.loadDetailIfCurrent(courseId),
		]);
		return true;
	}

	private loadDetailIfCurrent(courseId: string): Promise<void> {
		return this.courseScoped(courseId) ? this.loadDetail(courseId) : Promise.resolve();
	}

	async saveSettings(courseId: string, dailyMinutes: number): Promise<boolean> {
		const settings = await this.runWrite("save_settings", () => putCourseSettings(courseId, dailyMinutes), "每日学习时间已保存");
		if (!settings) return false;
		if (this.courseScoped(courseId)) {
			this.courseSettings = settings;
			this.notify();
		}
		await Promise.all([this.loadDaily(), this.loadCourseDaily(courseId)]);
		return true;
	}

	async createPlan(
		courseId: string,
		input: {
			title: string;
			description?: string;
			goal_id?: string | null;
			target_date?: string | null;
			daily_minutes?: number | null;
			stages?: StageDraft[];
			tasks?: TaskDraft[];
		},
	): Promise<PlanStructure | StudyPlan | null> {
		const created = await this.runWrite("create_plan", () => apiCreatePlan(courseId, input), "学习计划已创建");
		if (!created) return null;
		await this.refreshPlanDomains(courseId);
		return created;
	}

	async generatePlan(
		courseId: string,
		input: { basis: "course_material" | "model_knowledge"; daily_minutes?: number; target_date?: string; foundation?: string },
	): Promise<PlanDetail | null> {
		const key = `generate_plan:${courseId}`;
		const requestId = this._requestIds.get(key) ?? newRequestId();
		this._requestIds.set(key, requestId);
		const result = await this.runWrite(
			"generate_plan",
			() => apiGeneratePlan(courseId, { ...input, request_id: requestId }),
			"AI 已生成计划草稿，确认后才会启用",
		);
		if (!result) return null;
		this._requestIds.delete(key);
		await this.refreshPlanDomains(courseId);
		return result;
	}

	async saveDraft(
		courseId: string,
		planId: string,
		input: {
			expected_revision: number;
			title?: string;
			description?: string;
			target_date?: string | null;
			daily_minutes?: number | null;
			stages: StageDraft[];
			tasks?: TaskDraft[];
		},
	): Promise<PlanStructure | null> {
		const saved = await this.runWrite(
			"save_draft",
			() => apiReplacePlanDraft(courseId, planId, input),
			"计划草稿已保存",
			async () => {
				await this.loadPlans(courseId);
				await this.loadPlanDetail(courseId, planId);
			},
		);
		if (!saved) return null;
		await this.refreshPlanDomains(courseId, planId);
		return saved;
	}

	async confirmPlan(courseId: string, planId: string, expectedRevision: number, replaceActive: boolean): Promise<boolean> {
		const confirmed = await this.runWrite(
			"confirm_plan",
			() => apiConfirmPlan(courseId, planId, { expected_revision: expectedRevision, replace_active: replaceActive }),
			"计划已确认启用",
			async () => {
				await this.loadPlans(courseId);
				await this.loadPlanDetail(courseId, planId);
			},
		);
		if (!confirmed) return false;
		await this.refreshPlanDomains(courseId, planId);
		await Promise.all([this.loadDaily(), this.loadCourseDaily(courseId)]);
		return true;
	}

	async reorderTasks(courseId: string, planId: string, expectedRevision: number, taskIds: string[]): Promise<boolean> {
		const result = await this.runWrite(
			"reorder_tasks",
			() => apiReorderPlanTasks(courseId, planId, { expected_revision: expectedRevision, task_ids: taskIds }),
			"任务顺序已调整",
			async () => {
				await this.loadPlanDetail(courseId, planId);
			},
		);
		if (!result) return false;
		await this.refreshPlanDomains(courseId, planId);
		return true;
	}

	async applySuggestion(courseId: string, planId: string, suggestion: PlanSuggestion, expectedRevision: number): Promise<boolean> {
		const applied = await this.runWrite(
			"apply_suggestion",
			() => apiApplyPlanSuggestion(courseId, planId, suggestion.suggestion_id, {
				type: suggestion.type,
				expected_revision: expectedRevision,
			}),
			"已应用该调整建议",
			async () => {
				await this.loadPlanDetail(courseId, planId);
				await this.loadSuggestions(courseId, planId);
			},
		);
		if (!applied) return false;
		await this.refreshPlanDomains(courseId, planId);
		await this.loadSuggestions(courseId, planId);
		return true;
	}

	async updateTaskStatus(courseId: string, taskId: string, status: TaskStatus): Promise<LearningTask | null> {
		const updated = await this.runWrite(
			"update_task",
			() => apiUpdateTask(courseId, taskId, { status }),
			status === "completed" ? "任务已标记完成" : "任务状态已更新",
		);
		if (!updated) return null;
		await Promise.all([
			this.loadDetailIfCurrent(courseId),
			this.courseScoped(courseId) ? this.loadCourseSessions(courseId) : Promise.resolve(),
			this.loadDaily(),
			this.loadCourseDaily(courseId),
		]);
		return updated;
	}

	async uploadSource(courseId: string, input: { fileName: string; mimeType?: string; dataBase64: string; title?: string }): Promise<boolean> {
		const uploaded = await this.runWrite(
			"upload_source",
			() => uploadCourseSource(courseId, input),
			"资料已上传并加入课程知识库",
		);
		if (!uploaded) return false;
		await this.loadSources(courseId);
		await this.loadDetailIfCurrent(courseId);
		return true;
	}

	async retrySource(courseId: string, sourceId: string): Promise<boolean> {
		const retried = await this.runWrite(
			"retry_source",
			() => retryCourseSource(courseId, sourceId),
			"已重新解析该资料",
		);
		if (!retried) return false;
		await this.loadSources(courseId);
		return true;
	}

	async bindSource(courseId: string, sourceId: string): Promise<boolean> {
		const binding = await this.runWrite("bind_source", () => apiBindCourseSource(courseId, sourceId), "资料已关联到课程");
		if (!binding) return false;
		await Promise.all([this.loadSources(courseId), this.loadUnclassified(), this.loadDetailIfCurrent(courseId)]);
		return true;
	}

	async unbindSource(courseId: string, sourceId: string): Promise<boolean> {
		const done = await this.runWrite("unbind_source", async () => {
			await unbindCourseSource(courseId, sourceId);
			return true;
		}, "已解除资料与课程的关联（历史记录保留）");
		if (!done) return false;
		await Promise.all([this.loadSources(courseId), this.loadUnclassified(), this.loadDetailIfCurrent(courseId)]);
		return true;
	}

	private _requestIds = new Map<string, string>();

	/**
	 * Start or resume the AI session for one course task.
	 *
	 * The request id is stable per (course, task) until the call succeeds, so a
	 * double click or a retried request converges on one session. A failure
	 * returns `null` and creates nothing on the client: the caller must not
	 * navigate to a session that the server never bound.
	 */
	async startLearning(courseId: string, taskId: string | null): Promise<LearningStartResult | null> {
		const key = `${courseId}:${taskId ?? "free"}`;
		const requestId = this._requestIds.get(key) ?? newRequestId();
		this._requestIds.set(key, requestId);
		if (this.pendingAction) return null;
		this.pendingAction = "start_learning";
		this.feedback = null;
		this.notify();
		try {
			const result = await startCourseLearning(courseId, { task_id: taskId, request_id: requestId });
			this._requestIds.delete(key);
			this.feedback = null;
			return result;
		} catch (err) {
			this.feedback = { tone: "error", message: messageOf(err) };
			return null;
		} finally {
			this.pendingAction = null;
			this.notify();
		}
	}

	/** Re-read every plan-related list after a plan write. */
	private async refreshPlanDomains(courseId: string, planId?: string): Promise<void> {
		await Promise.all([
			this.loadPlans(courseId),
			planId ? this.loadPlanDetail(courseId, planId) : Promise.resolve(),
			this.loadDetailIfCurrent(courseId),
		]);
	}

	/** Reset everything (tests and a full reload). */
	reset(): void {
		this._coursesTicket += 1;
		this._dailyTicket += 1;
		this._courseDailyTicket += 1;
		this._detailTicket += 1;
		this._plansTicket += 1;
		this._planDetailTicket += 1;
		this._suggestionsTicket += 1;
		this._sourcesTicket += 1;
		this._unclassifiedTicket += 1;
		this._courseSessionsTicket += 1;
		this._courseLearnerTicket += 1;
		this._sessionContextTicket += 1;
		this._dailyController?.abort();
		this._courseController?.abort();
		this._sessionContextController?.abort();
		this._dailyController = null;
		this._courseController = null;
		this._sessionContextController = null;
		this._requestIds.clear();
		this._stageLabels.clear();
		this.courses = [];
		this.coursesLoading = false;
		this.coursesError = null;
		this.daily = null;
		this.dailyLoading = false;
		this.dailyError = null;
		this.courseDaily = null;
		this.courseDailyLoading = false;
		this.courseDailyError = null;
		this.selectedCourseId = null;
		this.detail = null;
		this.detailLoading = false;
		this.detailError = null;
		this.plans = [];
		this.plansLoading = false;
		this.plansError = null;
		this.planDetail = null;
		this.planDetailLoading = false;
		this.planDetailError = null;
		this.suggestions = null;
		this.suggestionsLoading = false;
		this.suggestionsError = null;
		this.sources = [];
		this.sourcesLoading = false;
		this.sourcesError = null;
		this.unclassified = null;
		this.unclassifiedLoading = false;
		this.unclassifiedError = null;
		this.courseSessions = null;
		this.courseSessionsLoading = false;
		this.courseSessionsError = null;
		this.courseLearner = null;
		this.courseLearnerLoading = false;
		this.courseLearnerError = null;
		this.courseSettings = null;
		this.sessionContexts = {};
		this.pendingAction = null;
		this.feedback = null;
		this.notify();
	}
}

export const coursesStore = new CoursesStoreImpl();

/** Helpers shared by the course pages (pure, no store state). */
export function courseStatusLabel(status: CourseStatus): string {
	switch (status) {
		case "in_progress": return "进行中";
		case "paused": return "已暂停";
		case "completed": return "已完成";
		case "archived": return "已归档";
	}
}

export function planStatusLabel(status: StudyPlan["status"]): string {
	switch (status) {
		case "draft": return "草稿";
		case "active": return "启用中";
		case "completed": return "已完成";
		case "archived": return "已归档";
	}
}

export function taskStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending": return "未开始";
		case "in_progress": return "进行中";
		case "completed": return "已完成";
	}
}

export function difficultyLabel(difficulty: LearningTask["difficulty"]): string {
	switch (difficulty) {
		case "basic": return "基础";
		case "standard": return "标准";
		case "challenge": return "挑战";
	}
}

export function sourceStatusLabel(status: string | undefined): string {
	switch (status) {
		case "indexed": return "已索引";
		case "extracted": return "已解析，待索引";
		case "pending": return "处理中";
		case "error": return "解析失败";
		default: return "状态未知";
	}
}

export type { CourseDailyPlan, CourseDetail, CourseGoalBinding, CourseSourceView, DailyPlanSnapshot, LearningTask, PlanListItem, StudyPlan };
