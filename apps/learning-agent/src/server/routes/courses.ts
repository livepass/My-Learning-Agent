import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { readManifestAsync } from "../../memory/l2/manifest-store.js";
import { loadProfile } from "../../memory/learner/profile-store.js";
import { ingestCourseDocument, reingestSource, CourseIngestError } from "../../memory/l2/course-ingest.js";
import { getL2Memory } from "../../memory/l2/l2-memory.js";
import { parseFrontmatter } from "../../memory/l2/wiki-maintainer.js";
import { readTextAsync } from "../../storage/file-store.js";
import { resolveContainedPathAsync } from "../../utils/path-safety.js";
import { listDirectory } from "../../storage/file-store.js";
import type { ManifestEntry } from "../../memory/l2/types.js";
import type { RuntimePaths } from "../../runtime.js";
import { CourseStore, CourseStoreError, type CreatePlanInput, type CreateTaskInput } from "../../courses/course-store.js";
import {
	MAX_COURSE_TITLE,
	MAX_DESCRIPTION,
	MAX_PLAN_TITLE,
	MAX_TASK_TITLE,
	isCourseStatus,
	isPlanOrigin,
	isPlanStatus,
	isSafeRecordId,
	isSessionOrigin,
	isTaskStatus,
	type CourseSessionOrigin,
	type CourseStatus,
	type LearningTaskStatus,
	type StudyPlanOrigin,
	type StudyPlanStatus,
} from "../../courses/types.js";
import { json, matchRoute, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";

/**
 * /api/courses/* route domain (E4.1).
 *
 * Every handler delegates persistence to the single `CourseStore` instance the
 * server owns; this module never touches a file. Ownership is always explicit:
 * a session or source is attached through this API (or through the store), and
 * anything without a binding is reported as 「未归类」 instead of being guessed
 * from a title or a conversation.
 *
 * Endpoints:
 *   GET    /api/courses
 *   POST   /api/courses
 *   GET    /api/courses/unclassified
 *   GET    /api/courses/bindings/session/:sessionId
 *   GET    /api/courses/:courseId
 *   GET    /api/courses/:courseId/learner    course-scoped L1 view
 *   PATCH  /api/courses/:courseId
 *   POST   /api/courses/:courseId/archive
 *   POST   /api/courses/:courseId/goals           { goal_id }
 *   DELETE /api/courses/:courseId/goals/:goalId
 *   GET    /api/courses/:courseId/plans
 *   POST   /api/courses/:courseId/plans
 *   PATCH  /api/courses/:courseId/plans/:planId
 *   GET    /api/courses/:courseId/tasks
 *   POST   /api/courses/:courseId/tasks
 *   PATCH  /api/courses/:courseId/tasks/:taskId
 *   GET    /api/courses/:courseId/sessions
 *   POST   /api/courses/:courseId/sessions        { session_id, task_id?, origin? }
 *   GET    /api/courses/:courseId/sources
 *   POST   /api/courses/:courseId/sources         { source_id }
 *   DELETE /api/courses/:courseId/sources/:sourceId
 */

export interface CoursesRouteContext {
	courseStore: CourseStore;
	paths: RuntimePaths;
	/** L2 capability switch: uploads/searches are refused when explicitly false. */
	l2Enabled?: boolean;
	/** Resolves true when the session file exists; a binding must not name a phantom session. */
	sessionExists: (sessionId: string) => Promise<boolean>;
}

/** Public error: a stable code and category, never a path or user content. */
function sendCourseError(res: ServerResponse, err: unknown): boolean {
	if (!(err instanceof CourseStoreError)) return false;
	const status = err.code === "COURSE_INVALID"
		? 400
		: err.code === "COURSE_NOT_FOUND"
			? 404
			: err.code === "COURSE_CONFLICT" || err.code === "COURSE_SESSION_CONFLICT" || err.code === "COURSE_TASK_PLAN_MISMATCH"
				? 409
				: 503;
	json(res, status, { error: err.code.toLowerCase(), category: "courses" });
	return true;
}

function bodyRecord(body: unknown): Record<string, unknown> {
	return typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
}

/** Reject an over-long free-text field before it reaches the store. */
function guardLength(body: Record<string, unknown>, field: string, max: number): void {
	const value = body[field];
	if (typeof value === "string" && value.length > max) {
		throw new CourseStoreError("COURSE_INVALID", "文本过长");
	}
}

function badRequest(res: ServerResponse): true {
	json(res, 400, { error: "course_invalid", category: "courses" });
	return true;
}

async function readSessionIds(paths: RuntimePaths): Promise<string[]> {
	const files = await listDirectory(paths.sessionDir);
	return files.filter((file) => file.endsWith(".jsonl"));
}

async function readSourceIds(ctx: CoursesRouteContext): Promise<string[]> {
	// The manifest is the only record of ingested sources; reading it does not
	// require L2 search to be enabled. A missing manifest means "no sources".
	const entries = await readManifestAsync(ctx.paths.l2DataDir);
	return entries.map((entry) => entry.id);
}

/** Public, path-free summary of a manifest entry for the course source list. */
function sourceSummary(entry: ManifestEntry | undefined) {
	if (!entry) return null;
	return {
		title: entry.title,
		status: entry.status,
		source_type: entry.sourceType,
		passage_count: entry.passageCount ?? entry.passagePages?.length ?? 0,
		...(entry.pageCount !== undefined ? { page_count: entry.pageCount } : {}),
		...(entry.error ? { error: entry.error } : {}),
		updated_at: entry.updatedAt,
		...(entry.indexedAt ? { indexed_at: entry.indexedAt } : {}),
	};
}

/** Section index for the source detail view: locators only, no full text. */
async function readSourceSections(l2DataDir: string, entry: ManifestEntry | undefined) {
	if (!entry?.passagePages?.length) return [];
	const sections: Array<{
		path: string; ordinal: number; heading_path?: string; page_start?: number; page_end?: number;
	}> = [];
	for (const path of entry.passagePages.slice(0, 500)) {
		const abs = await resolveContainedPathAsync(l2DataDir, path);
		if (!abs) continue;
		const content = await readTextAsync(abs);
		const passage = parseFrontmatter(content).frontmatter?.passage;
		if (!passage) continue;
		sections.push({
			path,
			ordinal: passage.ordinal,
			...(passage.heading_path ? { heading_path: passage.heading_path } : {}),
			...(passage.page_start !== undefined ? { page_start: passage.page_start } : {}),
			...(passage.page_end !== undefined ? { page_end: passage.page_end } : {}),
		});
	}
	return sections.sort((a, b) => a.ordinal - b.ordinal);
}

function sendIngestError(res: ServerResponse, err: unknown): boolean {
	if (!(err instanceof CourseIngestError)) return false;
	const status = err.code === "unsupported_format" || err.code === "empty_document"
		? 400
		: err.code === "file_too_large"
			? 413
			: err.code === "source_not_found" || err.code === "not_retryable"
				? 404
				: err.code === "index_failed"
					? 503
					: 422;
	json(res, status, {
		error: err.code,
		message: err.message,
		retryable: err.retryable,
		...(err.sourceId ? { source_id: err.sourceId } : {}),
		category: "l2",
	});
	return true;
}

export async function handleCoursesRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: CoursesRouteContext,
): Promise<boolean> {
	const { courseStore, paths } = ctx;

	try {
		// --- List courses (with relation counts) ---
		if (method === "GET" && url === "/api/courses") {
			const courses = await courseStore.listCourses();
			const withCounts = await Promise.all(courses.map(async (course) => ({
				...course,
				counts: await courseStore.counts(course.course_id),
			})));
			json(res, 200, { courses: withCounts });
			return true;
		}

		// --- Create course ---
		if (method === "POST" && url === "/api/courses") {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_COURSE_TITLE);
			guardLength(body, "description", MAX_DESCRIPTION);
			if (body.status !== undefined && !isCourseStatus(body.status)) return badRequest(res);
			const course = await courseStore.createCourse({
				title: body.title as string,
				description: body.description as string | undefined,
				status: body.status as CourseStatus | undefined,
			});
			json(res, 201, course);
			return true;
		}

		// --- Records without course ownership (explicit 「未归类」) ---
		if (method === "GET" && url === "/api/courses/unclassified") {
			const state = await courseStore.readState();
			const boundSessions = new Set(state.session_bindings.map((binding) => binding.session_id));
			const boundSources = new Set(state.source_bindings.map((binding) => binding.source_id));
			const [sessions, sources] = await Promise.all([readSessionIds(paths), readSourceIds(ctx)]);
			json(res, 200, {
				sessions: sessions.filter((id) => !boundSessions.has(id)),
				sources: sources.filter((id) => !boundSources.has(id)),
			});
			return true;
		}

		// --- Course of one session (a legacy session is explicitly unclassified) ---
		const sessionBindingMatch = matchRoute("GET", method, url, "/api/courses/bindings/session/:sessionId");
		if (sessionBindingMatch) {
			const sessionId = sessionBindingMatch.sessionId;
			// One read: binding, course, task and scope sets come from the same
			// snapshot, so a concurrent write cannot split the response.
			const context = await courseStore.getSessionContext(sessionId);
			if (!context) {
				json(res, 200, {
					session_id: sessionId,
					unclassified: true,
					binding: null,
					course: null,
					task: null,
					source_ids: [],
					goal_ids: [],
				});
				return true;
			}
			json(res, 200, {
				session_id: sessionId,
				unclassified: false,
				binding: context.binding,
				course: context.course,
				// E4.1a: the resolved context the memory layers use. Additive:
				// existing clients only read `binding` / `course` / `unclassified`.
				task: context.task,
				source_ids: context.sourceIds,
				goal_ids: context.goalIds,
			});
			return true;
		}

		// --- Course-scoped view of the L1 learner profile (E4.1a) ---
		const learnerViewMatch = matchRoute("GET", method, url, "/api/courses/:courseId/learner");
		if (learnerViewMatch) {
			const snapshot = await courseStore.snapshot(learnerViewMatch.courseId);
			if (!snapshot) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			// L1 is read through its owner (`loadProfile`); this route never writes
			// and never copies B2 evidence into the profile.
			let profile;
			try {
				profile = await loadProfile(paths.learnerDataDir);
			} catch {
				json(res, 503, { error: "learner_unavailable", category: "learner" });
				return true;
			}
			const state = await courseStore.readState();
			const boundGoalIds = new Set(state.goal_bindings.map((binding) => binding.goal_id));
			const courseGoalIds = new Set(snapshot.goals.map((binding) => binding.goal_id));
			json(res, 200, {
				course: snapshot.course,
				// Goals are bound explicitly; a goal may serve several courses.
				goals: profile.goals.filter((goal) => courseGoalIds.has(goal.goal_id)),
				// Knowledge states are course-scoped only when their first evidence
				// was recorded in a course-bound session. Pre-E4.1a states stay out
				// of every course view instead of being guessed into one.
				knowledge_states: profile.knowledge_states.filter((knowledge) => knowledge.course_id === snapshot.course.course_id),
				// Shared across courses: teaching preferences are properties of the
				// learner, not of one subject.
				preferences: profile.preferences,
				unclassified: {
					knowledge_states: profile.knowledge_states.filter((knowledge) => !knowledge.course_id).length,
					goals: profile.goals.filter((goal) => !boundGoalIds.has(goal.goal_id)).length,
				},
			});
			return true;
		}

		// --- Course detail with its explicit relations ---
		const courseMatch = matchRoute("GET", method, url, "/api/courses/:courseId");
		if (courseMatch) {
			// One state snapshot: counts and lists come from the same read, so a
			// concurrent write cannot make them disagree within one response.
			const snapshot = await courseStore.snapshot(courseMatch.courseId);
			if (!snapshot) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			json(res, 200, snapshot);
			return true;
		}

		// --- Update course ---
		const coursePatchMatch = matchRoute("PATCH", method, url, "/api/courses/:courseId");
		if (coursePatchMatch) {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_COURSE_TITLE);
			guardLength(body, "description", MAX_DESCRIPTION);
			if (body.status !== undefined && !isCourseStatus(body.status)) return badRequest(res);
			const course = await courseStore.updateCourse(coursePatchMatch.courseId, {
				title: body.title as string | undefined,
				description: body.description as string | undefined,
				status: body.status as CourseStatus | undefined,
			});
			json(res, 200, course);
			return true;
		}

		// --- Archive course (history is retained, never deleted) ---
		const archiveMatch = matchRoute("POST", method, url, "/api/courses/:courseId/archive");
		if (archiveMatch) {
			const course = await courseStore.archiveCourse(archiveMatch.courseId);
			json(res, 200, course);
			return true;
		}

		// --- Goal bindings ---
		const goalBindMatch = matchRoute("POST", method, url, "/api/courses/:courseId/goals");
		if (goalBindMatch) {
			const body = bodyRecord(await readBody(req));
			if (!isSafeRecordId(body.goal_id)) return badRequest(res);
			const result = await courseStore.bindGoal(goalBindMatch.courseId, body.goal_id);
			json(res, result.created ? 201 : 200, result.binding);
			return true;
		}

		const goalUnbindMatch = matchRoute("DELETE", method, url, "/api/courses/:courseId/goals/:goalId");
		if (goalUnbindMatch) {
			const removed = await courseStore.unbindGoal(goalUnbindMatch.courseId, goalUnbindMatch.goalId);
			if (!removed) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			json(res, 200, { removed: true });
			return true;
		}

		// --- Plans ---
		const plansListMatch = matchRoute("GET", method, url, "/api/courses/:courseId/plans");
		if (plansListMatch) {
			const plans = await courseStore.listPlans(plansListMatch.courseId);
			json(res, 200, { plans });
			return true;
		}

		const plansCreateMatch = matchRoute("POST", method, url, "/api/courses/:courseId/plans");
		if (plansCreateMatch) {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_PLAN_TITLE);
			guardLength(body, "description", MAX_DESCRIPTION);
			if (body.status !== undefined && !isPlanStatus(body.status)) return badRequest(res);
			if (body.origin !== undefined && !isPlanOrigin(body.origin)) return badRequest(res);
			const plan = await courseStore.createPlan(plansCreateMatch.courseId, {
				title: body.title as string,
				description: body.description as string | undefined,
				goalId: body.goal_id === undefined ? undefined : body.goal_id as string | null,
				status: body.status as StudyPlanStatus | undefined,
				origin: body.origin as StudyPlanOrigin | undefined,
			} satisfies CreatePlanInput);
			json(res, 201, plan);
			return true;
		}

		const planPatchMatch = matchRoute("PATCH", method, url, "/api/courses/:courseId/plans/:planId");
		if (planPatchMatch) {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_PLAN_TITLE);
			guardLength(body, "description", MAX_DESCRIPTION);
			if (body.status !== undefined && !isPlanStatus(body.status)) return badRequest(res);
			const plan = await courseStore.updatePlan(planPatchMatch.courseId, planPatchMatch.planId, {
				title: body.title as string | undefined,
				description: body.description as string | undefined,
				status: body.status as StudyPlanStatus | undefined,
				goalId: body.goal_id === undefined ? undefined : body.goal_id as string | null,
			});
			json(res, 200, plan);
			return true;
		}

		// --- Tasks ---
		const tasksListMatch = matchRoute("GET", method, url, "/api/courses/:courseId/tasks");
		if (tasksListMatch) {
			const rawPlanId = new URL(url, "http://localhost").searchParams.get("plan_id");
			if (rawPlanId !== null && !isSafeRecordId(rawPlanId)) return badRequest(res);
			const tasks = await courseStore.listTasks(tasksListMatch.courseId, rawPlanId ?? undefined);
			json(res, 200, { tasks });
			return true;
		}

		const tasksCreateMatch = matchRoute("POST", method, url, "/api/courses/:courseId/tasks");
		if (tasksCreateMatch) {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_TASK_TITLE);
			if (body.status !== undefined && !isTaskStatus(body.status)) return badRequest(res);
			const task = await courseStore.createTask(tasksCreateMatch.courseId, {
				title: body.title as string,
				planId: body.plan_id === undefined ? undefined : body.plan_id as string | null,
				conceptIds: body.concept_ids as string[] | undefined,
				sourceIds: body.source_ids as string[] | undefined,
				status: body.status as LearningTaskStatus | undefined,
			} satisfies CreateTaskInput);
			json(res, 201, task);
			return true;
		}

		const taskPatchMatch = matchRoute("PATCH", method, url, "/api/courses/:courseId/tasks/:taskId");
		if (taskPatchMatch) {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_TASK_TITLE);
			if (body.status !== undefined && !isTaskStatus(body.status)) return badRequest(res);
			const task = await courseStore.updateTask(taskPatchMatch.courseId, taskPatchMatch.taskId, {
				title: body.title as string | undefined,
				status: body.status as LearningTaskStatus | undefined,
				planId: body.plan_id === undefined ? undefined : body.plan_id as string | null,
				conceptIds: body.concept_ids as string[] | undefined,
				sourceIds: body.source_ids as string[] | undefined,
			});
			json(res, 200, task);
			return true;
		}

		// --- Session bindings ---
		const sessionsListMatch = matchRoute("GET", method, url, "/api/courses/:courseId/sessions");
		if (sessionsListMatch) {
			const sessions = await courseStore.listSessionBindings(sessionsListMatch.courseId);
			json(res, 200, { sessions });
			return true;
		}

		const sessionsBindMatch = matchRoute("POST", method, url, "/api/courses/:courseId/sessions");
		if (sessionsBindMatch) {
			const body = bodyRecord(await readBody(req));
			if (!isSafeRecordId(body.session_id)) return badRequest(res);
			// A binding names an existing session; the server checks the session
			// file instead of trusting the caller's claim.
			if (!await ctx.sessionExists(body.session_id)) {
				json(res, 404, { error: "session_not_found", category: "courses" });
				return true;
			}
			if (body.origin !== undefined && !isSessionOrigin(body.origin)) return badRequest(res);
			const result = await courseStore.bindSession({
				courseId: sessionsBindMatch.courseId,
				sessionId: body.session_id,
				taskId: body.task_id === undefined ? undefined : body.task_id as string | null,
				origin: body.origin as CourseSessionOrigin | undefined,
			});
			json(res, result.created ? 201 : 200, result.binding);
			return true;
		}

		// --- Source bindings ---
		const sourcesListMatch = matchRoute("GET", method, url, "/api/courses/:courseId/sources");
		if (sourcesListMatch) {
			// Active by default (the course's usable material). A management view
			// can ask for history with `?include_detached=true`, where the status
			// field distinguishes a detached binding from a missing one.
			const includeDetached = new URL(url, "http://localhost").searchParams.get("include_detached") === "true";
			const bindings = await courseStore.listSourceBindings(sourcesListMatch.courseId, { includeDetached });
			// E4.2e: the binding is ownership; the manifest is processing status.
			// Both are returned together so "已关联" can never imply "已索引".
			const manifest = await readManifestAsync(paths.l2DataDir);
			const byId = new Map(manifest.map((entry) => [entry.id, entry]));
			json(res, 200, {
				sources: bindings.map((binding) => ({
					...binding,
					source: sourceSummary(byId.get(binding.source_id)),
				})),
			});
			return true;
		}

		// --- Upload a document into this course's knowledge base (E4.2b) ---
		const sourceUploadMatch = matchRoute("POST", method, url, "/api/courses/:courseId/sources/upload");
		if (sourceUploadMatch) {
			if (ctx.l2Enabled === false) {
				json(res, 403, { error: "capability_disabled", capability: "memoryL2" });
				return true;
			}
			const course = await courseStore.getCourse(sourceUploadMatch.courseId);
			if (!course) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			let body: Record<string, unknown>;
			try {
				body = bodyRecord(await readBody(req, { maxBytes: UPLOAD_MAX_BODY_BYTES }));
			} catch {
				json(res, 413, { error: "file_too_large", message: "上传内容超过允许的大小" });
				return true;
			}
			const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
			const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
			if (!fileName || !dataBase64) {
				json(res, 400, { error: "missing_file", message: "缺少 fileName 或 dataBase64" });
				return true;
			}
			let bytes: Buffer;
			try {
				bytes = Buffer.from(dataBase64, "base64");
			} catch {
				json(res, 400, { error: "invalid_file", message: "文件内容无法解码" });
				return true;
			}
			if (bytes.byteLength === 0) {
				json(res, 400, { error: "empty_document", message: "文件内容为空" });
				return true;
			}
			let ingested;
			try {
				ingested = await ingestCourseDocument({
					l2DataDir: paths.l2DataDir,
					fileName,
					mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
					data: bytes,
					title: typeof body.title === "string" ? body.title : undefined,
				});
			} catch (err) {
				if (sendIngestError(res, err)) return true;
				throw err;
			}
			// Indexing succeeded first; ownership is a separate explicit step. A
			// binding failure must not be reported as a successful upload.
			try {
				const bound = await courseStore.bindSource(course.course_id, ingested.sourceId);
				json(res, 201, {
					course_id: course.course_id,
					binding_id: bound.binding.binding_id,
					source_id: ingested.sourceId,
					title: ingested.title,
					status: ingested.status,
					duplicate: ingested.duplicate,
					passage_count: ingested.passageCount,
					...(ingested.pageCount !== undefined ? { page_count: ingested.pageCount } : {}),
					source_type: ingested.sourceType,
				});
			} catch (err) {
				if (err instanceof CourseStoreError) {
					json(res, 500, {
						error: "course_binding_failed",
						message: "资料已索引，但加入课程失败；可稍后重新关联同一来源。",
						source_id: ingested.sourceId,
						status: ingested.status,
						retryable: true,
						category: "courses",
					});
					return true;
				}
				throw err;
			}
			return true;
		}

		// --- Source detail: binding + processing state + section locators ---
		const sourceDetailMatch = matchRoute("GET", method, url, "/api/courses/:courseId/sources/:sourceId");
		if (sourceDetailMatch) {
			const binding = await courseStore.getSourceBinding(sourceDetailMatch.courseId, sourceDetailMatch.sourceId);
			if (!binding) {
				json(res, 404, { error: "source_not_found", category: "courses" });
				return true;
			}
			const manifest = await readManifestAsync(paths.l2DataDir);
			const entry = manifest.find((candidate) => candidate.id === sourceDetailMatch.sourceId);
			json(res, 200, {
				course_id: sourceDetailMatch.courseId,
				binding,
				source: sourceSummary(entry),
				sections: await readSourceSections(paths.l2DataDir, entry),
			});
			return true;
		}

		// --- Retry a failed ingest (idempotent; indexed sources are a no-op) ---
		const sourceRetryMatch = matchRoute("POST", method, url, "/api/courses/:courseId/sources/:sourceId/retry");
		if (sourceRetryMatch) {
			if (ctx.l2Enabled === false) {
				json(res, 403, { error: "capability_disabled", capability: "memoryL2" });
				return true;
			}
			const binding = await courseStore.getSourceBinding(sourceRetryMatch.courseId, sourceRetryMatch.sourceId);
			if (!binding) {
				json(res, 404, { error: "source_not_found", category: "courses" });
				return true;
			}
			try {
				const retried = await reingestSource(paths.l2DataDir, sourceRetryMatch.sourceId);
				json(res, 200, {
					source_id: retried.sourceId,
					status: retried.status,
					duplicate: retried.duplicate,
					passage_count: retried.passageCount,
					...(retried.pageCount !== undefined ? { page_count: retried.pageCount } : {}),
				});
			} catch (err) {
				if (sendIngestError(res, err)) return true;
				throw err;
			}
			return true;
		}

		// --- Course-scoped retrieval (E4.2e): same SQL scope as l2_query/C1 ---
		const searchMatch = matchRoute("GET", method, url, "/api/courses/:courseId/search");
		if (searchMatch) {
			const query = (new URL(url, "http://localhost").searchParams.get("q") ?? "").trim();
			const rawLimit = Number(new URL(url, "http://localhost").searchParams.get("limit") ?? "8");
			if (!query || query.length > 200) {
				json(res, 400, { error: "invalid_query", message: "请提供 1–200 字的检索词" });
				return true;
			}
			const course = await courseStore.getCourse(searchMatch.courseId);
			if (!course) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			const bindings = await courseStore.listSourceBindings(course.course_id);
			if (bindings.length === 0) {
				json(res, 200, { course_id: course.course_id, query, status: "no_material", results: [] });
				return true;
			}
			if (ctx.l2Enabled === false) {
				json(res, 200, { course_id: course.course_id, query, status: "l2_disabled", results: [] });
				return true;
			}
			const sourceIds = bindings.map((binding) => binding.source_id);
			const hits = await getL2Memory(paths.l2DataDir).search(
				query,
				Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 8,
				{ sourceIds },
			);
			if (hits === null) {
				json(res, 503, { error: "l2_unavailable", message: "检索索引暂不可用", category: "l2" });
				return true;
			}
			const results = [];
			for (const hit of hits) {
				const abs = await resolveContainedPathAsync(paths.l2DataDir, hit.path);
				const content = abs ? await readTextAsync(abs) : "";
				const parsed = content ? parseFrontmatter(content) : { frontmatter: null, body: "" };
				results.push({
					path: hit.path,
					title: hit.title,
					type: hit.type,
					source_ids: hit.sourceIds,
					score: hit.score,
					via: hit.via,
					...(parsed.frontmatter?.passage ? { locator: parsed.frontmatter.passage } : {}),
					excerpt: parsed.body.trim().slice(0, 500),
				});
			}
			json(res, 200, { course_id: course.course_id, query, status: results.length > 0 ? "ok" : "empty", results });
			return true;
		}

		const sourcesBindMatch = matchRoute("POST", method, url, "/api/courses/:courseId/sources");
		if (sourcesBindMatch) {
			const body = bodyRecord(await readBody(req));
			if (!isSafeRecordId(body.source_id)) return badRequest(res);
			// Explicit attachment only: an ingested document is course material
			// because the learner (or the agent, on their behalf) said so, not
			// because it happens to exist in the shared L2 store.
			const known = await readSourceIds(ctx);
			if (!known.includes(body.source_id)) {
				json(res, 404, { error: "source_not_found", category: "courses" });
				return true;
			}
			const result = await courseStore.bindSource(sourcesBindMatch.courseId, body.source_id);
			json(res, result.created ? 201 : 200, result.binding);
			return true;
		}

		const sourceUnbindMatch = matchRoute("DELETE", method, url, "/api/courses/:courseId/sources/:sourceId");
		if (sourceUnbindMatch) {
			const removed = await courseStore.unbindSource(sourceUnbindMatch.courseId, sourceUnbindMatch.sourceId);
			if (!removed) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			json(res, 200, { removed: true });
			return true;
		}

		return false;
	} catch (err) {
		if (sendCourseError(res, err)) return true;
		throw err;
	}
}
