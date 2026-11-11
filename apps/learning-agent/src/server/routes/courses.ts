import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readManifestAsync } from "../../memory/l2/manifest-store.js";
import { LearnerStoreError, loadProfile } from "../../memory/learner/profile-store.js";
import { loadPrerequisiteEdgesAsync } from "../../memory/learner/prerequisite-store.js";
import { ingestCourseDocument, reingestSource, CourseIngestError } from "../../memory/l2/course-ingest.js";
import { getL2Memory } from "../../memory/l2/l2-memory.js";
import { parseFrontmatter } from "../../memory/l2/wiki-maintainer.js";
import { readTextAsync } from "../../storage/file-store.js";
import { resolveContainedPathAsync } from "../../utils/path-safety.js";
import { listDirectory } from "../../storage/file-store.js";
import type { L2SearchResult } from "../../memory/l2/l2-search.js";
import type { ManifestEntry } from "../../memory/l2/types.js";
import type { KnowledgeState, LearningModelIdentity, LearnerProfile } from "../../memory/learner/types.js";
import type { ModelCompletion } from "../../shared/model-completion.js";
import type { RuntimePaths } from "../../runtime.js";
import {
	CourseStore,
	CourseStoreError,
	type CreatePlanInput,
	type CreatePlanStructureInput,
	type CreateTaskInput,
	type DeletionEvidenceContext,
	type PlanAdjustmentInput,
	type StageDraft,
	type TaskDraft,
} from "../../courses/course-store.js";
import {
	MAX_COURSE_TITLE,
	MAX_DAILY_MINUTES,
	MAX_DESCRIPTION,
	MAX_PLAN_TITLE,
	MAX_RATIONALE,
	MAX_TASK_TITLE,
	MIN_DAILY_MINUTES,
	isCourseStatus,
	isPlanBasis,
	isPlanOrigin,
	isPlanStatus,
	isSafeRecordId,
	isSessionOrigin,
	isTaskDifficulty,
	isTaskStatus,
	type CourseSessionOrigin,
	type CourseStatus,
	type DeletionBlocker,
	type LearningTaskStatus,
	type PlanBasis,
	type StudyPlanOrigin,
	type StudyPlanStatus,
	type TaskDifficulty,
	type TaskSourceRef,
} from "../../courses/types.js";
import { collectCourseMaterial } from "../../courses/course-material.js";
import { generateStudyPlan } from "../../courses/plan-generator.js";
import { buildDailyPlans } from "../../courses/daily-plan.js";
import { buildPlanSuggestions } from "../../courses/plan-adjustments.js";
import { startLearning, type LearningStartOutcome } from "../../courses/learning-start.js";
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
 *   GET    /api/courses/daily                      cross-course daily recommendations
 *   POST   /api/courses
 *   GET    /api/courses/unclassified
 *   GET    /api/courses/bindings/session/:sessionId
 *   GET    /api/courses/:courseId
 *   GET    /api/courses/:courseId/learner    course-scoped L1 view
 *   PATCH  /api/courses/:courseId
 *   POST   /api/courses/:courseId/archive
 *   GET    /api/courses/:courseId/delete-preview  counts + refusal reasons (E4.7)
 *   DELETE /api/courses/:courseId                 permanent, history-free only
 *   GET    /api/courses/:courseId/settings          daily study budget
 *   PUT    /api/courses/:courseId/settings
 *   POST   /api/courses/:courseId/goals           { goal_id }
 *   DELETE /api/courses/:courseId/goals/:goalId
 *   GET    /api/courses/:courseId/plans
 *   POST   /api/courses/:courseId/plans             optional stages/tasks, atomic
 *   GET    /api/courses/:courseId/plans/:planId
 *   PATCH  /api/courses/:courseId/plans/:planId
 *   POST   /api/courses/:courseId/plans/generate    AI draft (E4.3b)
 *   PUT    /api/courses/:courseId/plans/:planId/draft
 *   PUT    /api/courses/:courseId/plans/:planId/stages
 *   POST   /api/courses/:courseId/plans/:planId/confirm
 *   POST   /api/courses/:courseId/plans/:planId/archive   keep history, leave active list
 *   GET    /api/courses/:courseId/plans/:planId/delete-preview
 *   DELETE /api/courses/:courseId/plans/:planId           unstarted plans only
 *   POST   /api/courses/:courseId/plans/:planId/tasks/reorder
 *   GET    /api/courses/:courseId/plans/:planId/suggestions
 *   POST   /api/courses/:courseId/plans/:planId/suggestions/:suggestionId/apply
 *   GET    /api/courses/:courseId/tasks
 *   POST   /api/courses/:courseId/tasks
 *   PATCH  /api/courses/:courseId/tasks/:taskId
 *   DELETE /api/courses/:courseId/tasks/:taskId
 *   POST   /api/courses/:courseId/learning/start  { task_id?, request_id? } (E4.4a)
 *   GET    /api/courses/:courseId/sessions
 *   POST   /api/courses/:courseId/sessions        { session_id, task_id?, origin? }
 *   GET    /api/courses/:courseId/sources
 *   GET    /api/courses/:courseId/source-candidates  indexed sources not yet owned
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
	/**
	 * E4.3: side-channel completion for plan drafting. It never touches chat
	 * history and never enters the prompt queue. Absent = planning still works
	 * manually, but AI drafting reports "not ready".
	 */
	completeModel?: ModelCompletion;
	currentModel?: () => LearningModelIdentity | null;
	/** Course-scoped L2 search, same index and scope as `l2_query`. */
	searchL2?: ((query: string, options?: { sourceIds?: readonly string[] }) => Promise<L2SearchResult[] | null>) | null;
	/**
	 * E4.4a: the Agent-runtime pieces a learning start needs. Injected rather
	 * than imported so this route never owns the session queue directly: the
	 * server keeps one gatekeeper for creation, switching and deletion.
	 * Absent = a deployment/test without a runtime answers 503 instead of
	 * pretending a session exists.
	 */
	learningRuntime?: LearningRuntime;
	/**
	 * E4.7: B2 evidence probe. Given candidate session ids, return the ones that
	 * already hold a finalized attempt, so a delete can name the exact records it
	 * would orphan instead of guessing. Absent = no B2 in this deployment; the
	 * course store's own session/task checks still apply.
	 */
	learningEvidence?: (sessionIds: readonly string[]) => Promise<readonly string[]>;
}

export interface LearningRuntime {
	createSession: (
		req: HttpReq,
		res: ServerResponse,
	) => Promise<{ sessionId: string; previousSessionId: string } | null>;
	activateSession: (
		sessionId: string,
		req: HttpReq,
		res: ServerResponse,
	) => Promise<"ok" | "busy" | "unavailable">;
	discardSession: (
		sessionId: string,
		previousSessionId: string,
		req: HttpReq,
		res: ServerResponse,
	) => Promise<{ discarded: boolean; reason?: string }>;
	sessionState: (sessionId: string) => "deleting" | "deleted" | null;
	initializeLearningRecord: (
		sessionId: string,
		goalId: string | null,
	) => Promise<{ created: boolean; checkpoint: { revision: number; status: string; step: string } | null }>;
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
	json(res, status, {
		error: err.code.toLowerCase(),
		message: err.message,
		category: "courses",
		...(err.currentRevision !== undefined ? { revision: err.currentRevision } : {}),
		// E4.7: a refused delete names every concrete reason, so the client can
		// offer archiving instead of a generic "操作失败".
		...(err.blockers !== undefined ? { blockers: err.blockers } : {}),
	});
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

/**
 * E4.7 — evidence a course delete would orphan, owned outside `CourseStore`.
 *
 * Two owners are asked and neither is a heuristic:
 *
 * - L1: a knowledge state carries `course_id` only when its first evidence was
 *   recorded in a course-bound session, so a non-empty set is real mastery data;
 * - B2: a session bound to the record already holds a finalized attempt. A
 *   record whose binding is gone is deliberately not guessed into a course:
 *   it stays where it is and is never deleted by this endpoint.
 *
 * The probe runs inside the store's write transaction. An unreadable owner is
 * reported as 503 rather than treated as "no evidence": a delete that cannot be
 * proven safe must not proceed.
 */
function deletionEvidenceProbe(ctx: CoursesRouteContext) {
	return async (context: DeletionEvidenceContext): Promise<DeletionBlocker[]> => {
		const blockers: DeletionBlocker[] = [];
		if (context.target === "course") {
			let profile: LearnerProfile | null = null;
			try {
				profile = await loadProfile(ctx.paths.learnerDataDir);
			} catch (err) {
				// A fresh install has no L1 file yet: that is "no mastery data",
				// not "unknown". Anything else (corrupt/unavailable) means the
				// probe cannot prove the delete is safe, so it fails closed.
				if (!(err instanceof LearnerStoreError && err.code === "PROFILE_MISSING")) {
					throw new CourseStoreError("COURSE_IO", "学习档案暂时不可用，无法确认删除是否安全，请稍后重试");
				}
			}
			const states = (profile?.knowledge_states ?? []).filter((state) => state.course_id === context.courseId);
			if (states.length > 0) {
				blockers.push({
					code: "mastery_states",
					count: states.length,
					message: `该课程在学习档案中已有 ${states.length} 个知识点掌握状态，只能归档。`,
				});
			}
		}
		if (ctx.learningEvidence && context.sessionIds.length > 0) {
			let withEvidence: readonly string[];
			try {
				withEvidence = await ctx.learningEvidence(context.sessionIds);
			} catch {
				throw new CourseStoreError("COURSE_IO", "学习记录暂时不可读，无法确认删除是否安全，请稍后重试");
			}
			if (withEvidence.length > 0) {
				const subject = context.target === "plan" ? "该计划" : "该课程";
				blockers.push({
					code: "learning_evidence",
					count: withEvidence.length,
					message: `${subject}已有 ${withEvidence.length} 个会话产生正式学习证据（B2），只能归档。`,
				});
			}
		}
		return blockers;
	};
}

function courseInvalid(message: string): CourseStoreError {
	return new CourseStoreError("COURSE_INVALID", message);
}

/** Parse the optional stage/task payload of a manual plan or a draft replace. */
function parsePlanStructure(body: Record<string, unknown>): { stages: StageDraft[]; tasks: TaskDraft[] } {
	const rawStages = body.stages;
	const rawTasks = body.tasks;
	if (rawStages !== undefined && !Array.isArray(rawStages)) throw courseInvalid("stages 必须是数组");
	if (rawTasks !== undefined && !Array.isArray(rawTasks)) throw courseInvalid("tasks 必须是数组");
	const stages: StageDraft[] = (rawStages ?? []).map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw courseInvalid("阶段必须是对象");
		const stage = value as Record<string, unknown>;
		if (!Array.isArray(stage.tasks) && stage.tasks !== undefined) throw courseInvalid("阶段任务必须是数组");
		return {
			stage_id: stage.stage_id as string | null | undefined,
			title: stage.title as string,
			description: stage.description as string | undefined,
			tasks: ((stage.tasks ?? []) as unknown[]).map(parseTaskDraft),
		};
	});
	return { stages, tasks: ((rawTasks ?? []) as unknown[]).map(parseTaskDraft) };
}

function parseTaskDraft(value: unknown): TaskDraft {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw courseInvalid("任务必须是对象");
	const record = value as Record<string, unknown>;
	if (typeof record.title !== "string") throw courseInvalid("任务标题必须是字符串");
	if (record.status !== undefined && !isTaskStatus(record.status)) throw courseInvalid("任务状态不合法");
	if (record.difficulty !== undefined && !isTaskDifficulty(record.difficulty)) throw courseInvalid("任务难度不合法");
	return {
		task_id: record.task_id as string | null | undefined,
		title: record.title,
		conceptIds: record.concept_ids as string[] | undefined,
		conceptLabels: record.concept_labels as string[] | undefined,
		sourceIds: record.source_ids as string[] | undefined,
		sourceRefs: record.source_refs as TaskDraft["sourceRefs"],
		estimatedMinutes: record.estimated_minutes as number | null | undefined,
		difficulty: record.difficulty as TaskDifficulty | undefined,
		rationale: record.rationale as string | undefined,
		status: record.status as LearningTaskStatus | undefined,
	};
}

function parseExpectedRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw courseInvalid("缺少计划版本 expected_revision");
	return value;
}

function optionalRevision(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	return parseExpectedRevision(value);
}

function optionalMinutes(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw courseInvalid("每日学习时间必须是整数分钟");
	if (value < MIN_DAILY_MINUTES || value > MAX_DAILY_MINUTES) throw courseInvalid("每日学习时间超出允许范围");
	return value;
}

/** Course-scoped L1 view. Reads only; never writes or copies B2 evidence. */
async function readLearnerScope(paths: RuntimePaths, courseId: string): Promise<{
	profile: LearnerProfile;
	states: KnowledgeState[];
	misconceptions: LearnerProfile["misconceptions"];
}> {
	const profile = await loadProfile(paths.learnerDataDir);
	const states = profile.knowledge_states.filter((state) => state.course_id === courseId);
	const conceptIds = new Set(states.map((state) => state.concept_id));
	return {
		profile,
		states,
		misconceptions: profile.misconceptions.filter((item) => conceptIds.has(item.concept_id)),
	};
}

/** Intent-only fingerprint for request-id replay vs conflict. */
function planRequestFingerprint(input: {
	courseId: string;
	goalIds: readonly string[];
	dailyMinutes: number;
	targetDate?: string;
	foundation?: string;
	basis: PlanBasis;
}): string {
	const canonical = JSON.stringify({
		course: input.courseId,
		goals: [...input.goalIds].sort(),
		minutes: input.dailyMinutes,
		target: input.targetDate ?? null,
		foundation: input.foundation ?? null,
		basis: input.basis,
	});
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function planFingerprint(input: {
	courseId: string;
	courseVersion: string;
	goalIds: readonly string[];
	goalTitles: readonly string[];
	dailyMinutes: number;
	targetDate?: string;
	foundation?: string;
	basis: PlanBasis;
	sourceIds: readonly string[];
	materialVersion: string;
	unitPaths: readonly string[];
	profileVersion: number;
}): string {
	const canonical = JSON.stringify({
		course: input.courseId,
		course_version: input.courseVersion,
		goals: [...input.goalIds].sort(),
		goal_titles: [...input.goalTitles],
		minutes: input.dailyMinutes,
		target: input.targetDate ?? null,
		foundation: input.foundation ?? null,
		basis: input.basis,
		sources: [...input.sourceIds].sort(),
		material: input.materialVersion,
		units: [...input.unitPaths].sort(),
		profile: input.profileVersion,
	});
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

interface CourseSourceIndex {
	active: Set<string>;
	entries: Map<string, ManifestEntry>;
}

/** Read the course's active source bindings and the manifest once per request. */
async function courseSourceIndex(ctx: CoursesRouteContext, courseId: string): Promise<CourseSourceIndex> {
	const [bindings, manifest] = await Promise.all([
		ctx.courseStore.listSourceBindings(courseId),
		readManifestAsync(ctx.paths.l2DataDir),
	]);
	return {
		active: new Set(bindings.map((binding) => binding.source_id)),
		entries: new Map(manifest.map((entry) => [entry.id, entry])),
	};
}

/**
 * A task may cite only material that is actively bound to its course and fully
 * indexed. This is the same scope E4.2 retrieval uses; a source id from another
 * course is a scope violation, not a free-form tag.
 */
function assertTaskSources(index: CourseSourceIndex, sourceIds: readonly string[] | undefined): void {
	if (!sourceIds || sourceIds.length === 0) return;
	for (const sourceId of sourceIds) {
		if (!index.active.has(sourceId)) {
			throw new CourseStoreError("COURSE_CONFLICT", "任务来源未关联到该课程");
		}
		const entry = index.entries.get(sourceId);
		if (!entry || entry.status !== "indexed") {
			throw new CourseStoreError("COURSE_CONFLICT", "任务来源尚未完成索引");
		}
	}
}

function sourceRefKey(ref: TaskSourceRef): string {
	return [
		ref.source_id,
		ref.page_path,
		ref.heading_path ?? "",
		ref.page_start ?? "",
		ref.page_end ?? "",
		ref.unit_id ?? "",
	].join("\u0000");
}

/** Exact round-trip only: a client may not invent or edit a citation. */
function sameSourceRefs(value: unknown, existing: readonly TaskSourceRef[] | undefined): boolean {
	if (!Array.isArray(value)) return false;
	if (value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) return false;
	const left = value.map((item) => sourceRefKey(item as TaskSourceRef)).join("\u0001");
	const right = (existing ?? []).map(sourceRefKey).join("\u0001");
	return left === right;
}

function rejectClientSourceRefs(refs: unknown): void {
	if (refs !== undefined) {
		throw new CourseStoreError("COURSE_INVALID", "来源引用只能由服务端根据课程教材生成，不能自定义");
	}
}

/**
 * Manual plans/tasks may name sources, but never citations. `source_refs` is
 * server output (plan generation or an applied adjustment); accepting a client
 * copy would let a learner fabricate "verified" chapter/page metadata.
 */
async function validateClientTaskSources(
	ctx: CoursesRouteContext,
	courseId: string,
	tasks: readonly TaskDraft[],
): Promise<void> {
	for (const task of tasks) rejectClientSourceRefs(task.sourceRefs);
	const withSources = tasks.filter((task) => (task.sourceIds?.length ?? 0) > 0);
	if (withSources.length === 0) return;
	const index = await courseSourceIndex(ctx, courseId);
	for (const task of withSources) assertTaskSources(index, task.sourceIds);
}

/**
 * Preload explicit prerequisite edges for every concept the plan touches.
 * Request paths must not walk the wiki synchronously, and one scan per concept
 * is enough for a single recommendation pass.
 */
async function prerequisiteEdgesFor(
	l2DataDir: string,
	conceptIds: readonly string[],
	allowedSourceIds: readonly string[],
): Promise<Map<string, Awaited<ReturnType<typeof loadPrerequisiteEdgesAsync>>>> {
	const unique = [...new Set(conceptIds)].filter((id) => isSafeRecordId(id));
	const entries = await Promise.all(unique.map(async (conceptId) => [
		conceptId,
		await loadPrerequisiteEdgesAsync(l2DataDir, conceptId, { allowedSourceIds }),
	] as const));
	return new Map(entries);
}

function sendPlanGenerationError(res: ServerResponse, code: string, message: string, status: number): true {
	json(res, status, { error: code, message, category: "courses" });
	return true;
}

/**
 * In-process single flight for plan drafting.
 *
 * The store's idempotency check still runs at commit time, but without this a
 * double click starts two paid model calls. The key is the content fingerprint,
 * so the same request_id and the same intent share one call; a reused
 * request_id with different content is rejected before reaching this map.
 */
const planGenerationFlights = new Map<string, Promise<unknown>>();

async function singleFlightPlanGeneration<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = planGenerationFlights.get(key);
	if (existing) return existing as Promise<T>;
	let run: Promise<T>;
	run = fn().finally(() => {
		if (planGenerationFlights.get(key) === run) planGenerationFlights.delete(key);
	});
	planGenerationFlights.set(key, run);
	return run;
}

/** Replay response for an existing plan, including its stored provenance. */
function sendExistingPlan(
	res: ServerResponse,
	found: { plan: NonNullable<Awaited<ReturnType<CourseStore["getPlan"]>>>; stages: unknown[]; tasks: unknown[]; matched: string },
): true {
	const plan = found.plan;
	const generation = plan.generation;
	json(res, 200, publicPlanDetail(plan, found.stages, found.tasks, {
		duplicate: true,
		matched: found.matched,
		...(generation ? {
			basis: generation.basis,
			generation: {
				model: generation.model,
				material_note: generation.material_note,
				assumptions: generation.assumptions,
				uncertainties: generation.uncertainties,
				provided_units: generation.provided_units,
				units: generation.units,
				source_ids: generation.source_ids,
			},
		} : {}),
		status: plan.status,
		requires_confirmation: plan.status === "draft",
	}));
	return true;
}

/** Public payload of a generated plan: provenance and text, no hidden prompt. */
function publicPlanDetail(
	plan: unknown,
	stages: unknown,
	tasks: unknown,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { plan, stages, tasks, ...extra };
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
		// --- Daily recommendations across courses (E4.3d) ---
		// Registered before `/api/courses/:courseId`: otherwise "daily" would be
		// read as a course id and the route would 404 on a real course lookup.
		if (method === "GET" && url.split("?")[0] === "/api/courses/daily") {
			const params = new URL(url, "http://localhost").searchParams;
			const rawMinutes = params.get("minutes");
			const requestedCourse = params.get("course_id");
			if (requestedCourse !== null && !isSafeRecordId(requestedCourse)) return badRequest(res);
			const minutes = rawMinutes === null
				? undefined
				: optionalMinutes(Number(rawMinutes));
			if (rawMinutes !== null && (minutes === undefined || !Number.isFinite(Number(rawMinutes)))) {
				return badRequest(res);
			}
			const rawAsOf = params.get("as_of");
			const asOf = rawAsOf ? new Date(rawAsOf) : new Date();
			if (!Number.isFinite(asOf.getTime())) return badRequest(res);
			let profile: LearnerProfile;
			try {
				profile = await loadProfile(paths.learnerDataDir);
			} catch {
				json(res, 503, { error: "learner_unavailable", category: "learner" });
				return true;
			}
			const courses = await courseStore.listCourses();
			const selected = requestedCourse
				? courses.filter((course) => course.course_id === requestedCourse)
				// A paused/completed/archived course is not part of today's plan
				// unless the caller explicitly asks for it by id.
				: courses.filter((course) => course.status === "in_progress");
			if (requestedCourse && selected.length === 0) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			const state = await courseStore.readState();
			const inputs = selected.map((course) => {
				const courseStates = profile.knowledge_states.filter((knowledge) => knowledge.course_id === course.course_id);
				const conceptIds = new Set(courseStates.map((knowledge) => knowledge.concept_id));
				return {
					course,
					plans: state.plans.filter((plan) => plan.course_id === course.course_id),
					stages: state.stages.filter((stage) => stage.course_id === course.course_id),
					tasks: state.tasks.filter((task) => task.course_id === course.course_id),
					settings: state.study_settings.find((settings) => settings.course_id === course.course_id),
					knowledge_states: courseStates,
					misconceptions: profile.misconceptions.filter((item) => conceptIds.has(item.concept_id)),
				};
			});
			const snapshot = buildDailyPlans(inputs, { asOf, ...(minutes !== undefined ? { minutes } : {}) });
			json(res, 200, snapshot);
			return true;
		}

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

		// --- E4.7 delete preflight: counts + every reason deletion is refused ---
		// A separate read so the confirmation dialog can show exactly what would
		// disappear before anything is removed.
		const courseDeletePreviewMatch = matchRoute("GET", method, url, "/api/courses/:courseId/delete-preview");
		if (courseDeletePreviewMatch) {
			const report = await courseStore.inspectCourseDeletion(courseDeletePreviewMatch.courseId, {
				externalBlockers: deletionEvidenceProbe(ctx),
			});
			json(res, 200, report);
			return true;
		}

		// --- E4.7 permanent course delete (refused when real history exists) ---
		const courseDeleteMatch = matchRoute("DELETE", method, url, "/api/courses/:courseId");
		if (courseDeleteMatch) {
			const outcome = await courseStore.deleteCourse(courseDeleteMatch.courseId, {
				externalBlockers: deletionEvidenceProbe(ctx),
			});
			json(res, 200, { deleted: true, ...outcome });
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

		// --- Per-course daily budget (E4.3a) ---
		const settingsMatch = matchRoute("GET", method, url, "/api/courses/:courseId/settings");
		if (settingsMatch) {
			const course = await courseStore.getCourse(settingsMatch.courseId);
			if (!course) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			const settings = await courseStore.getStudySettings(settingsMatch.courseId);
			json(res, 200, {
				course_id: settingsMatch.courseId,
				daily_minutes: settings?.daily_minutes ?? null,
				updated_at: settings?.updated_at ?? null,
			});
			return true;
		}

		const settingsPutMatch = matchRoute("PUT", method, url, "/api/courses/:courseId/settings");
		if (settingsPutMatch) {
			const body = bodyRecord(await readBody(req));
			const settings = await courseStore.setStudySettings(
				settingsPutMatch.courseId,
				body.daily_minutes as number,
			);
			json(res, 200, settings);
			return true;
		}

		// --- Plan detail: phases + tasks + generation provenance (E4.3c) ---
		const planDetailMatch = matchRoute("GET", method, url, "/api/courses/:courseId/plans/:planId");
		if (planDetailMatch) {
			const plan = await courseStore.getPlan(planDetailMatch.courseId, planDetailMatch.planId);
			if (!plan) {
				json(res, 404, { error: "plan_not_found", category: "courses" });
				return true;
			}
			const [stages, tasks] = await Promise.all([
				courseStore.listStages(planDetailMatch.courseId, plan.plan_id),
				courseStore.listTasks(planDetailMatch.courseId, plan.plan_id),
			]);
			json(res, 200, publicPlanDetail(plan, stages, tasks, {
				// Explicit separation: a finished task never implies mastery.
				progress: {
					total: tasks.length,
					completed: tasks.filter((task) => task.status === "completed").length,
					knowledge_effect: "none",
				},
			}));
			return true;
		}

		// --- E4.7 plan lifecycle: preflight, archive, permanent delete ---
		// Registered before the generic detail read so `delete-preview` can never
		// be mistaken for a plan id (the segment counts differ, but keeping the
		// lifecycle block together documents the ordering).
		const planDeletePreviewMatch = matchRoute(
			"GET",
			method,
			url,
			"/api/courses/:courseId/plans/:planId/delete-preview",
		);
		if (planDeletePreviewMatch) {
			const report = await courseStore.inspectPlanDeletion(
				planDeletePreviewMatch.courseId,
				planDeletePreviewMatch.planId,
				{ externalBlockers: deletionEvidenceProbe(ctx) },
			);
			json(res, 200, report);
			return true;
		}

		const planArchiveMatch = matchRoute("POST", method, url, "/api/courses/:courseId/plans/:planId/archive");
		if (planArchiveMatch) {
			const plan = await courseStore.archivePlan(planArchiveMatch.courseId, planArchiveMatch.planId);
			json(res, 200, plan);
			return true;
		}

		const planDeleteMatch = matchRoute("DELETE", method, url, "/api/courses/:courseId/plans/:planId");
		if (planDeleteMatch) {
			const outcome = await courseStore.deletePlan(planDeleteMatch.courseId, planDeleteMatch.planId, {
				externalBlockers: deletionEvidenceProbe(ctx),
			});
			json(res, 200, { deleted: true, ...outcome });
			return true;
		}

		// --- AI plan draft (E4.3b) ---
		const planGenerateMatch = matchRoute("POST", method, url, "/api/courses/:courseId/plans/generate");
		if (planGenerateMatch) {
			const course = await courseStore.getCourse(planGenerateMatch.courseId);
			if (!course) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			const body = bodyRecord(await readBody(req));
			if (!isSafeRecordId(body.request_id)) {
				json(res, 400, { error: "request_id_required", message: "缺少 request_id", category: "courses" });
				return true;
			}
			const requestId = body.request_id;
			const basis: PlanBasis = body.basis === undefined ? "course_material" : body.basis as PlanBasis;
			if (!isPlanBasis(basis)) return badRequest(res);
			const dailyMinutes = optionalMinutes(body.daily_minutes) ?? (await courseStore.getStudySettings(course.course_id))?.daily_minutes ?? 30;
			if (body.target_date !== undefined && body.target_date !== null) {
				if (typeof body.target_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.target_date)) return badRequest(res);
			}
			if (body.foundation !== undefined && (typeof body.foundation !== "string" || body.foundation.length > 500)) {
				return badRequest(res);
			}
			const requestedGoalIds = body.goal_ids;
			if (requestedGoalIds !== undefined
				&& (!Array.isArray(requestedGoalIds) || requestedGoalIds.length > 10
					|| requestedGoalIds.some((id) => !isSafeRecordId(id)))) {
				return badRequest(res);
			}

			// Goals are read through the explicit course binding; a goal from
			// another course is a scope error, not an extra hint.
			let profile: LearnerProfile;
			try {
				profile = await loadProfile(paths.learnerDataDir);
			} catch {
				json(res, 503, { error: "learner_unavailable", category: "learner" });
				return true;
			}
			const boundGoalIds = (await courseStore.listGoalBindings(course.course_id)).map((binding) => binding.goal_id);
			const selectedGoalIds = (requestedGoalIds as string[] | undefined) ?? boundGoalIds;
			if (selectedGoalIds.some((id) => !boundGoalIds.includes(id))) {
				json(res, 409, { error: "goal_not_bound", message: "所选学习目标未与该课程建立关联", category: "courses" });
				return true;
			}
			const goalTitles = selectedGoalIds
				.map((id) => profile.goals.find((goal) => goal.goal_id === id)?.title)
				.filter((title): title is string => Boolean(title));
			const courseStates = profile.knowledge_states.filter((state) => state.course_id === course.course_id);
			const conceptIds = new Set(courseStates.map((state) => state.concept_id));
			const misconceptions = profile.misconceptions.filter((item) => conceptIds.has(item.concept_id));

			const bindings = await courseStore.listSourceBindings(course.course_id);
			const sourceIds = bindings.map((binding) => binding.source_id);

			// E4.4: a request-id replay is decided before reading any material.
			// Otherwise unbinding the last source (or L2 being briefly down)
			// would turn a successful request into 409/503 and could tempt a
			// retry into generating a fresh plan from nothing.
			const requestFingerprint = planRequestFingerprint({
				courseId: course.course_id,
				goalIds: selectedGoalIds,
				dailyMinutes,
				...(typeof body.target_date === "string" ? { targetDate: body.target_date } : {}),
				...(typeof body.foundation === "string" ? { foundation: body.foundation.trim() } : {}),
				basis,
			});
			const requestReplay = await courseStore.lookupGeneratedPlan(course.course_id, requestId, "", {
				matchFingerprint: false,
				requestFingerprint,
			});
			if (requestReplay.status === "conflict") {
				json(res, 409, {
					error: "request_conflict",
					message: "该请求 ID 已用于不同的计划生成请求",
					category: "courses",
					revision: requestReplay.plan.revision,
				});
				return true;
			}
			if (requestReplay.status === "found") {
				return sendExistingPlan(res, requestReplay);
			}
			if (basis === "course_material" && ctx.l2Enabled === false) {
				return sendPlanGenerationError(res, "l2_disabled", "知识库能力已关闭，无法按教材生成计划；可改为基于模型一般知识规划。", 409);
			}
			const material = basis === "course_material"
				? await collectCourseMaterial({
					l2DataDir: paths.l2DataDir,
					courseTitle: course.title,
					goalTitles,
					...(typeof body.foundation === "string" ? { focus: body.foundation } : {}),
					sourceIds,
					search: ctx.searchL2 ?? null,
				})
				: {
					status: "no_material" as const,
					units: [],
					toc: [],
					sources: [],
					considered_passages: 0,
					truncated: false,
					retrieval: "unsupported" as const,
					partial: false,
					material_version: "",
				};
			if (basis === "course_material" && material.status === "no_material") {
				return sendPlanGenerationError(res, "no_course_material", "这门课程还没有可用的教材：请先上传资料，或明确选择「基于模型一般知识」规划。", 409);
			}
			if (basis === "course_material" && material.status === "unavailable") {
				return sendPlanGenerationError(res, "material_unavailable", "课程资料暂时无法读取，请稍后重试。", 503);
			}
			const fingerprint = planFingerprint({
				courseId: course.course_id,
				courseVersion: course.updated_at,
				goalIds: selectedGoalIds,
				goalTitles,
				dailyMinutes,
				...(typeof body.target_date === "string" ? { targetDate: body.target_date } : {}),
				...(typeof body.foundation === "string" ? { foundation: body.foundation.trim() } : {}),
				basis,
				sourceIds,
				materialVersion: material.material_version,
				unitPaths: material.units.map((unit) => `${unit.page_path}#${unit.ordinal}`),
				profileVersion: profile.version,
			});

			// Idempotency before any model call: a replay must work even when the
			// provider is down, and a reused request id with another intent must
			// fail rather than return the wrong plan.
			const lookup = await courseStore.lookupGeneratedPlan(course.course_id, requestId, fingerprint, {
				matchFingerprint: body.force !== true,
				requestFingerprint,
			});
			if (lookup.status === "conflict") {
				json(res, 409, {
					error: "request_conflict",
					message: "该请求 ID 已用于不同的计划生成请求",
					category: "courses",
					revision: lookup.plan.revision,
				});
				return true;
			}
			if (lookup.status === "found") {
				return sendExistingPlan(res, lookup);
			}
			// Only a genuinely new draft needs a model. A replay above must work
			// even when the provider was removed or is temporarily unreachable.
			if (!ctx.completeModel) {
				return sendPlanGenerationError(res, "model_not_ready", "模型尚未就绪，请先完成模型配置。", 503);
			}

			const generated = await singleFlightPlanGeneration(
				`${course.course_id}\u0000${fingerprint}`,
				() => generateStudyPlan({ complete: ctx.completeModel! }, {
					courseId: course.course_id,
					courseTitle: course.title,
					courseDescription: course.description,
					goalTitles,
					goalIds: selectedGoalIds,
					dailyMinutes,
					...(typeof body.target_date === "string" ? { targetDate: body.target_date } : {}),
					...(typeof body.foundation === "string" ? { foundation: body.foundation.trim() } : {}),
					basis,
					requestId,
					fingerprint,
					requestFingerprint,
					material,
					learner: { states: courseStates, misconceptions, preferences: profile.preferences },
				}),
			);
			if (!generated.ok) {
				const status = generated.code === "model_not_ready" ? 503
					: generated.code === "model_timeout" || generated.code === "model_aborted" ? 503
						: generated.code === "model_error" || generated.code === "empty_output" ? 502
							: generated.code === "invalid_output" ? 422 : 409;
				return sendPlanGenerationError(res, generated.code, generated.message, status);
			}

			const saved = await courseStore.saveGeneratedPlanDraft(course.course_id, {
				title: generated.plan.title,
				description: generated.plan.description,
				goalId: selectedGoalIds.length === 1 ? selectedGoalIds[0] : null,
				targetDate: typeof body.target_date === "string" ? body.target_date : null,
				dailyMinutes,
				generation: generated.generation,
				stages: generated.plan.stages.map((stage) => ({
					title: stage.title,
					description: stage.description,
					tasks: stage.tasks.map((task) => ({
						title: task.title,
						conceptIds: [task.concept_id],
						conceptLabels: [task.concept],
						sourceIds: [...new Set(task.sourceRefs.map((ref) => ref.source_id))],
						sourceRefs: task.sourceRefs,
						estimatedMinutes: task.minutes,
						difficulty: task.difficulty,
						rationale: task.rationale,
					})),
				})),
			}, { force: body.force === true });

			json(res, saved.created ? 201 : 200, publicPlanDetail(saved.plan, saved.stages, saved.tasks, {
				duplicate: !saved.created,
				basis: generated.generation.basis,
				// What the plan is grounded in, and what it is not.
				generation: {
					model: generated.generation.model,
					material_note: generated.generation.material_note,
					assumptions: generated.generation.assumptions,
					uncertainties: generated.generation.uncertainties,
					provided_units: generated.generation.provided_units,
					units: generated.generation.units,
					source_ids: generated.generation.source_ids,
				},
				status: saved.plan.status,
				requires_confirmation: saved.plan.status === "draft",
			}));
			return true;
		}

		// --- Confirm a draft (E4.3c): the only draft → active path ---
		const planConfirmMatch = matchRoute("POST", method, url, "/api/courses/:courseId/plans/:planId/confirm");
		if (planConfirmMatch) {
			const body = bodyRecord(await readBody(req));
			const confirmed = await courseStore.confirmPlan(planConfirmMatch.courseId, planConfirmMatch.planId, {
				expectedRevision: parseExpectedRevision(body.expected_revision),
				replaceActive: body.replace_active === true,
			});
			json(res, 200, confirmed);
			return true;
		}

		// --- Replace a draft's phases and tasks atomically (E4.3c) ---
		const planDraftMatch = matchRoute("PUT", method, url, "/api/courses/:courseId/plans/:planId/draft");
		if (planDraftMatch) {
			const body = bodyRecord(await readBody(req));
			const structure = parsePlanStructure(body);
			const draftTasks = [...structure.stages.flatMap((stage) => stage.tasks ?? []), ...structure.tasks];
			const existingTasks = await courseStore.listTasks(planDraftMatch.courseId, planDraftMatch.planId);
			const existingById = new Map(existingTasks.map((task) => [task.task_id, task]));
			let sourceIndex: CourseSourceIndex | undefined;
			for (const task of draftTasks) {
				if (task.sourceRefs !== undefined) {
					const existing = task.task_id ? existingById.get(task.task_id) : undefined;
					if (!existing || !sameSourceRefs(task.sourceRefs, existing.source_refs)) {
						throw courseInvalid("来源引用只能沿用服务端已生成的内容，不能新增或修改");
					}
				}
				if (task.sourceIds && task.sourceIds.length > 0) {
					sourceIndex ??= await courseSourceIndex(ctx, planDraftMatch.courseId);
					assertTaskSources(sourceIndex, task.sourceIds);
				}
			}
			const saved = await courseStore.replacePlanDraft(planDraftMatch.courseId, planDraftMatch.planId, {
				expectedRevision: parseExpectedRevision(body.expected_revision),
				...(body.title !== undefined ? { title: body.title as string } : {}),
				...(body.description !== undefined ? { description: body.description as string } : {}),
				...(body.goal_id !== undefined ? { goalId: body.goal_id as string | null } : {}),
				...(body.target_date !== undefined ? { targetDate: body.target_date as string | null } : {}),
				...(body.daily_minutes !== undefined ? { dailyMinutes: body.daily_minutes as number | null } : {}),
				stages: structure.stages,
				tasks: structure.tasks,
			});
			json(res, 200, saved);
			return true;
		}

		// --- Replace stage titles/order without touching tasks (E4.3a) ---
		const planStagesMatch = matchRoute("PUT", method, url, "/api/courses/:courseId/plans/:planId/stages");
		if (planStagesMatch) {
			const body = bodyRecord(await readBody(req));
			if (!Array.isArray(body.stages)) return badRequest(res);
			const stages = (body.stages as unknown[]).map((value) => {
				if (!value || typeof value !== "object" || Array.isArray(value)) throw courseInvalid("阶段必须是对象");
				const record = value as Record<string, unknown>;
				if (typeof record.title !== "string") throw courseInvalid("阶段标题必须是字符串");
				return {
					stage_id: record.stage_id as string | null | undefined,
					title: record.title,
					description: record.description as string | undefined,
				};
			});
			const saved = await courseStore.replacePlanStages(planStagesMatch.courseId, planStagesMatch.planId, {
				expectedRevision: parseExpectedRevision(body.expected_revision),
				stages,
			});
			json(res, 200, saved);
			return true;
		}

		// --- Suggestions and explicit application (E4.3e) ---
		const planSuggestionsMatch = matchRoute("GET", method, url, "/api/courses/:courseId/plans/:planId/suggestions");
		if (planSuggestionsMatch) {
			const plan = await courseStore.getPlan(planSuggestionsMatch.courseId, planSuggestionsMatch.planId);
			if (!plan) {
				json(res, 404, { error: "plan_not_found", category: "courses" });
				return true;
			}
			let scoped;
			try {
				scoped = await readLearnerScope(paths, plan.course_id);
			} catch {
				json(res, 503, { error: "learner_unavailable", category: "learner" });
				return true;
			}
			const [stages, tasks] = await Promise.all([
				courseStore.listStages(plan.course_id, plan.plan_id),
				courseStore.listTasks(plan.course_id, plan.plan_id),
			]);
			const activeSources = (await courseStore.listSourceBindings(plan.course_id)).map((binding) => binding.source_id);
			const edges = await prerequisiteEdgesFor(paths.l2DataDir, tasks.flatMap((task) => task.concept_ids), activeSources);
			const suggestions = buildPlanSuggestions({
				plan,
				stages,
				tasks,
				knowledge_states: scoped.states,
				misconceptions: scoped.misconceptions,
				edgesFor: (conceptId) => edges.get(conceptId) ?? [],
				asOf: new Date(),
				dailyMinutes: plan.daily_minutes ?? (await courseStore.getStudySettings(plan.course_id))?.daily_minutes,
			});
			json(res, 200, {
				plan_id: plan.plan_id,
				revision: plan.revision,
				suggestions,
				note: "这些只是建议：应用前不会修改计划，也不会改变任务状态或 L1 掌握度。",
			});
			return true;
		}

		const planApplyMatch = matchRoute(
			"POST", method, url, "/api/courses/:courseId/plans/:planId/suggestions/:suggestionId/apply",
		);
		if (planApplyMatch) {
			const body = bodyRecord(await readBody(req));
			if (!isSafeRecordId(planApplyMatch.suggestionId)) return badRequest(res);
			if (typeof body.type !== "string") return badRequest(res);
			const plan = await courseStore.getPlan(planApplyMatch.courseId, planApplyMatch.planId);
			if (!plan) {
				json(res, 404, { error: "plan_not_found", category: "courses" });
				return true;
			}
			// Recompute at the current revision and require the suggestion to
			// still exist. A suggestion computed against an older plan cannot be
			// replayed onto an edited one.
			let scoped;
			try {
				scoped = await readLearnerScope(paths, plan.course_id);
			} catch {
				json(res, 503, { error: "learner_unavailable", category: "learner" });
				return true;
			}
			const [stages, tasks] = await Promise.all([
				courseStore.listStages(plan.course_id, plan.plan_id),
				courseStore.listTasks(plan.course_id, plan.plan_id),
			]);
			const activeSources = (await courseStore.listSourceBindings(plan.course_id)).map((binding) => binding.source_id);
			const edges = await prerequisiteEdgesFor(paths.l2DataDir, tasks.flatMap((task) => task.concept_ids), activeSources);
			const current = buildPlanSuggestions({
				plan,
				stages,
				tasks,
				knowledge_states: scoped.states,
				misconceptions: scoped.misconceptions,
				edgesFor: (conceptId) => edges.get(conceptId) ?? [],
				asOf: new Date(),
				dailyMinutes: plan.daily_minutes ?? (await courseStore.getStudySettings(plan.course_id))?.daily_minutes,
			});
			const suggestion = current.find((item) => item.suggestion_id === planApplyMatch.suggestionId);
			if (!suggestion) {
				json(res, 409, {
					error: "suggestion_stale",
					message: "这条建议已不适用于当前计划，请重新获取建议。",
					category: "courses",
					revision: plan.revision,
				});
				return true;
			}
			const applied = await courseStore.applyPlanAdjustment(plan.course_id, plan.plan_id, {
				expectedRevision: parseExpectedRevision(body.expected_revision),
				suggestionId: suggestion.suggestion_id,
				type: suggestion.type,
				...(suggestion.task_id ? { taskId: suggestion.task_id } : {}),
				...(suggestion.before_task_id ? { beforeTaskId: suggestion.before_task_id } : {}),
				...(suggestion.concept_id ? { conceptId: suggestion.concept_id } : {}),
				...(suggestion.concept_label ? { conceptLabel: suggestion.concept_label } : {}),
				reasonCode: suggestion.reason_code,
				evidence: suggestion.evidence,
				...(suggestion.difficulty ? { difficulty: suggestion.difficulty } : {}),
			} satisfies PlanAdjustmentInput);
			json(res, 200, { ...applied, applied_suggestion: suggestion });
			return true;
		}


		// --- Plans ---
		const plansListMatch = matchRoute("GET", method, url, "/api/courses/:courseId/plans");
		if (plansListMatch) {
			const [plans, stages, tasks] = await Promise.all([
				courseStore.listPlans(plansListMatch.courseId),
				courseStore.listStages(plansListMatch.courseId),
				courseStore.listTasks(plansListMatch.courseId),
			]);
			json(res, 200, {
				plans: plans.map((plan) => ({
					...plan,
					// List view keeps provenance metadata but not the adopted
					// excerpts; the detail endpoint is the place that carries text.
					...(plan.generation ? {
						generation: {
							basis: plan.generation.basis,
							model: plan.generation.model,
							generated_at: plan.generation.generated_at,
							material_note: plan.generation.material_note,
							provided_units: plan.generation.provided_units,
							source_ids: plan.generation.source_ids,
							units: plan.generation.units.map(({ excerpt: _excerpt, ...unit }) => unit),
						},
					} : {}),
					stage_count: stages.filter((stage) => stage.plan_id === plan.plan_id).length,
					task_count: tasks.filter((task) => task.plan_id === plan.plan_id).length,
					completed_task_count: tasks.filter((task) => task.plan_id === plan.plan_id
						&& task.status === "completed").length,
					// E4.7: a plan whose tasks left `pending` already holds learning
					// history, so the list view can offer archive instead of delete
					// without a second request.
					started_task_count: tasks.filter((task) => task.plan_id === plan.plan_id
						&& (task.status !== "pending" || Boolean(task.completed_at))).length,
				})),
			});
			return true;
		}

		const plansCreateMatch = matchRoute("POST", method, url, "/api/courses/:courseId/plans");
		if (plansCreateMatch) {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_PLAN_TITLE);
			guardLength(body, "description", MAX_DESCRIPTION);
			if (body.status !== undefined && !isPlanStatus(body.status)) return badRequest(res);
			if (body.origin !== undefined && !isPlanOrigin(body.origin)) return badRequest(res);
			const structure = parsePlanStructure(body);
			await validateClientTaskSources(ctx, plansCreateMatch.courseId, [
				...structure.stages.flatMap((stage) => stage.tasks ?? []),
				...structure.tasks,
			]);
			if (structure.stages.length === 0 && structure.tasks.length === 0) {
				const plan = await courseStore.createPlan(plansCreateMatch.courseId, {
					title: body.title as string,
					description: body.description as string | undefined,
					goalId: body.goal_id === undefined ? undefined : body.goal_id as string | null,
					status: body.status as StudyPlanStatus | undefined,
					origin: body.origin as StudyPlanOrigin | undefined,
					targetDate: body.target_date as string | null | undefined,
					dailyMinutes: body.daily_minutes as number | null | undefined,
				} satisfies CreatePlanInput);
				json(res, 201, plan);
				return true;
			}
			// Plan + phases + tasks in one store write; a failure leaves nothing.
			const created = await courseStore.createPlanWithStructure(plansCreateMatch.courseId, {
				title: body.title as string,
				description: body.description as string | undefined,
				goalId: body.goal_id === undefined ? undefined : body.goal_id as string | null,
				status: body.status as StudyPlanStatus | undefined,
				origin: body.origin as StudyPlanOrigin | undefined,
				targetDate: body.target_date as string | null | undefined,
				dailyMinutes: body.daily_minutes as number | null | undefined,
				stages: structure.stages,
				tasks: structure.tasks,
			} satisfies CreatePlanStructureInput);
			json(res, 201, created);
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
				targetDate: body.target_date as string | null | undefined,
				dailyMinutes: body.daily_minutes as number | null | undefined,
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
			guardLength(body, "rationale", MAX_RATIONALE);
			if (body.status !== undefined && !isTaskStatus(body.status)) return badRequest(res);
			if (body.difficulty !== undefined && !isTaskDifficulty(body.difficulty)) return badRequest(res);
			rejectClientSourceRefs(body.source_refs);
			const sourceIds = body.source_ids as string[] | undefined;
			if (sourceIds && sourceIds.length > 0) {
				assertTaskSources(await courseSourceIndex(ctx, tasksCreateMatch.courseId), sourceIds);
			}
			const task = await courseStore.createTask(tasksCreateMatch.courseId, {
				title: body.title as string,
				planId: body.plan_id === undefined ? undefined : body.plan_id as string | null,
				stageId: body.stage_id === undefined ? undefined : body.stage_id as string | null,
				conceptIds: body.concept_ids as string[] | undefined,
				conceptLabels: body.concept_labels as string[] | undefined,
				sourceIds,
				estimatedMinutes: body.estimated_minutes as number | null | undefined,
				difficulty: body.difficulty as TaskDifficulty | undefined,
				rationale: body.rationale as string | undefined,
				status: body.status as LearningTaskStatus | undefined,
			} satisfies CreateTaskInput);
			json(res, 201, task);
			return true;
		}

		// Ordering is its own operation: a partial PATCH per task would let two
		// clients interleave into an ambiguous sequence.
		const tasksReorderMatch = matchRoute("POST", method, url, "/api/courses/:courseId/plans/:planId/tasks/reorder");
		if (tasksReorderMatch) {
			const body = bodyRecord(await readBody(req));
			if (!Array.isArray(body.task_ids)) return badRequest(res);
			const tasks = await courseStore.reorderTasks(tasksReorderMatch.courseId, tasksReorderMatch.planId, {
				expectedRevision: parseExpectedRevision(body.expected_revision),
				taskIds: body.task_ids as string[],
			});
			json(res, 200, { tasks });
			return true;
		}

		const taskPatchMatch = matchRoute("PATCH", method, url, "/api/courses/:courseId/tasks/:taskId");
		if (taskPatchMatch) {
			const body = bodyRecord(await readBody(req));
			guardLength(body, "title", MAX_TASK_TITLE);
			guardLength(body, "rationale", MAX_RATIONALE);
			if (body.status !== undefined && !isTaskStatus(body.status)) return badRequest(res);
			if (body.difficulty !== undefined && !isTaskDifficulty(body.difficulty)) return badRequest(res);
			const existing = await courseStore.getTask(taskPatchMatch.courseId, taskPatchMatch.taskId);
			if (!existing) {
				json(res, 404, { error: "task_not_found", category: "courses" });
				return true;
			}
			if (body.source_refs !== undefined && !sameSourceRefs(body.source_refs, existing.source_refs)) {
				throw courseInvalid("来源引用只能沿用服务端已生成的内容，不能新增或修改");
			}
			const sourceIds = body.source_ids as string[] | undefined;
			if (sourceIds && sourceIds.length > 0) {
				assertTaskSources(await courseSourceIndex(ctx, taskPatchMatch.courseId), sourceIds);
			}
			const task = await courseStore.updateTask(taskPatchMatch.courseId, taskPatchMatch.taskId, {
				title: body.title as string | undefined,
				status: body.status as LearningTaskStatus | undefined,
				planId: body.plan_id === undefined ? undefined : body.plan_id as string | null,
				stageId: body.stage_id === undefined ? undefined : body.stage_id as string | null,
				conceptIds: body.concept_ids as string[] | undefined,
				conceptLabels: body.concept_labels as string[] | undefined,
				sourceIds,
				estimatedMinutes: body.estimated_minutes as number | null | undefined,
				difficulty: body.difficulty as TaskDifficulty | undefined,
				rationale: body.rationale as string | undefined,
				order: body.order as number | undefined,
				expectedPlanRevision: optionalRevision(body.expected_revision),
				expectedTargetRevision: optionalRevision(body.expected_target_revision),
			});
			json(res, 200, task);
			return true;
		}

		const taskDeleteMatch = matchRoute("DELETE", method, url, "/api/courses/:courseId/tasks/:taskId");
		if (taskDeleteMatch) {
			const removed = await courseStore.deleteTask(taskDeleteMatch.courseId, taskDeleteMatch.taskId);
			if (!removed) {
				json(res, 404, { error: "task_not_found", category: "courses" });
				return true;
			}
			json(res, 200, { removed: true });
			return true;
		}

		// --- E4.4a: start or resume the AI session for a course task ---
		const learningStartMatch = matchRoute("POST", method, url, "/api/courses/:courseId/learning/start");
		if (learningStartMatch) {
			const runtime = ctx.learningRuntime;
			if (!runtime) {
				json(res, 503, {
					error: "learning_unavailable",
					message: "Agent 运行时尚未就绪，无法创建学习会话。",
					category: "courses",
				});
				return true;
			}
			const body = bodyRecord(await readBody(req));
			const rawTaskId = body.task_id;
			if (rawTaskId !== undefined && rawTaskId !== null && !isSafeRecordId(rawTaskId)) return badRequest(res);
			// A missing id would make a retry indistinguishable from a new
			// conversation, so the server supplies one and echoes it back.
			const requestId = body.request_id === undefined
				? `start_${randomUUID().slice(0, 12)}`
				: body.request_id;
			if (!isSafeRecordId(requestId)) return badRequest(res);

			const outcome: LearningStartOutcome = await startLearning({
				courseStore,
				sessionExists: ctx.sessionExists,
				sessionState: runtime.sessionState,
				createSession: () => runtime.createSession(req, res),
				activateSession: (sessionId) => runtime.activateSession(sessionId, req, res),
				discardSession: (sessionId, previousSessionId) =>
					runtime.discardSession(sessionId, previousSessionId, req, res),
				initializeLearningRecord: runtime.initializeLearningRecord,
			}, {
				courseId: learningStartMatch.courseId,
				taskId: rawTaskId === undefined || rawTaskId === null ? null : rawTaskId as string,
				requestId,
			});

			if (outcome.status === "error") {
				json(res, outcome.httpStatus, {
					error: outcome.code,
					message: outcome.message,
					category: "courses",
					request_id: requestId,
					...(outcome.rolledBack !== undefined ? { rolled_back: outcome.rolledBack } : {}),
					...(outcome.sessionId ? { session_id: outcome.sessionId } : {}),
					retryable: outcome.httpStatus >= 500 || outcome.code === "session_busy",
				});
				return true;
			}
			json(res, outcome.created ? 201 : 200, {
				request_id: requestId,
				// The client must not navigate until the binding exists; this
				// response is only produced after it does.
				session: {
					session_id: outcome.sessionId,
					active: true,
					created: outcome.created,
					resumed: outcome.resumed,
				},
				course: {
					course_id: outcome.course.course_id,
					title: outcome.course.title,
					status: outcome.course.status,
				},
				task: outcome.task,
				goal_id: outcome.goalId,
				learning: outcome.learning,
				context_ready: true,
				warnings: outcome.warnings,
			});
			return true;
		}

		// --- Session bindings ---
		const sessionsListMatch = matchRoute("GET", method, url, "/api/courses/:courseId/sessions");
		if (sessionsListMatch) {
			const sessions = await courseStore.listSessionBindings(sessionsListMatch.courseId);
			// E4.4-R1: legacy files may hold two sessions for one task. Report
			// them instead of hiding or silently repairing the inconsistency.
			const duplicates = await courseStore.listDuplicateTaskBindings(sessionsListMatch.courseId);
			json(res, 200, {
				sessions,
				...(duplicates.length > 0
					? {
						duplicate_task_bindings: duplicates.map((entry) => ({
							task_id: entry.task_id,
							session_ids: entry.session_ids,
							note: "历史遗留：同一任务存在多个会话。系统保留全部会话与学习记录，本次不自动清理。",
						})),
					}
					: {}),
			});
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

		/**
		 * Sources this course may attach (E4.6a).
		 *
		 * 「关联已有资料」 previously offered only unclassified sources, so a
		 * document already bound to course A could not be added to course B even
		 * though `bindSource` supports one source in many courses. The candidate
		 * list is therefore every *indexed* manifest entry the course does not
		 * already own, each with the courses that currently hold it, so the page
		 * can say "also in 高等数学" before the learner clicks.
		 *
		 * Read-only: nothing is copied, and the existing binding of another course
		 * is untouched.
		 */
		const sourceCandidatesMatch = matchRoute("GET", method, url, "/api/courses/:courseId/source-candidates");
		if (sourceCandidatesMatch) {
			const course = await courseStore.getCourse(sourceCandidatesMatch.courseId);
			if (!course) {
				json(res, 404, { error: "course_not_found", category: "courses" });
				return true;
			}
			const state = await courseStore.readState();
			const courseTitles = new Map(state.courses.map((entry) => [entry.course_id, entry.title]));
			const owners = new Map<string, Array<{ course_id: string; title: string }>>();
			for (const binding of state.source_bindings) {
				if (binding.status !== "active") continue;
				const title = courseTitles.get(binding.course_id);
				if (!title) continue;
				const list = owners.get(binding.source_id) ?? [];
				list.push({ course_id: binding.course_id, title });
				owners.set(binding.source_id, list);
			}
			const manifest = await readManifestAsync(paths.l2DataDir);
			const sources = manifest
				.filter((entry) => entry.status === "indexed")
				.map((entry) => {
					const boundTo = owners.get(entry.id) ?? [];
					return {
						source_id: entry.id,
						title: entry.title,
						source_type: entry.sourceType,
						status: entry.status,
						passage_count: entry.passageCount ?? entry.passagePages?.length ?? 0,
						...(entry.pageCount !== undefined ? { page_count: entry.pageCount } : {}),
						...(entry.indexedAt ? { indexed_at: entry.indexedAt } : {}),
						bound_to_current: boundTo.some((owner) => owner.course_id === course.course_id),
						courses: boundTo,
					};
				})
				.filter((entry) => !entry.bound_to_current)
				.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
			json(res, 200, { course_id: course.course_id, sources });
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
