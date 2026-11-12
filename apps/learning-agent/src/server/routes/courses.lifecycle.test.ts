import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore } from "../../courses/course-store.js";
import type { RuntimePaths } from "../../runtime.js";
import { readJsonStrict } from "../../storage/file-store.js";
import { countFormalEvidence, recordHasFormalEvidence } from "../../learning/record-store.js";
import type { LearningSessionRecord } from "../../memory/learner/types.js";
import { handleCoursesRoutes, type CoursesRouteContext } from "./courses.js";

/**
 * E4.7 HTTP contract for deleting/archiving courses and plans.
 *
 * The handler runs in-process against a real `CourseStore`, a real L2 manifest
 * and a real B2 record directory, so the tests pin the behaviour the UI relies
 * on: a 409 that names every reason, a delete that never touches shared
 * material, and daily/list views that reflect the new state immediately.
 */

const roots: string[] = [];

interface Harness {
	ctx: CoursesRouteContext;
	root: string;
	dataDir: string;
	paths: RuntimePaths;
	store: CourseStore;
	/** Sessions the B2 probe should report as evidence-bearing. */
	evidence: Set<string>;
}

async function makeHarness(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "inno-courses-lifecycle-http-"));
	roots.push(root);
	const dataDir = join(root, "data");
	const paths: RuntimePaths = {
		codeDir: root,
		configDir: join(root, "config"),
		configPath: join(root, "config", "config.json"),
		dataDir,
		learnerDataDir: join(dataDir, "learner"),
		sessionDir: join(dataDir, "sessions"),
		l2DataDir: join(dataDir, "l2"),
		l3DataDir: join(dataDir, "l3"),
		skillsDir: join(root, "skills"),
		workspaceDir: join(root, "workspace"),
		webDistDir: join(root, "web-dist"),
	};
	await mkdir(paths.sessionDir, { recursive: true });
	await mkdir(paths.l2DataDir, { recursive: true });
	await writeFile(
		join(paths.l2DataDir, "manifest.jsonl"),
		`${JSON.stringify({
			id: "l2src_aaaaaaa1",
			title: "Python 教材.pdf",
			status: "indexed",
			sourceType: "pdf",
			passageCount: 12,
			updatedAt: "2026-11-01T00:00:00.000Z",
		})}\n`,
		"utf-8",
	);
	const store = new CourseStore({ dataDir });
	const evidence = new Set<string>();
	const ctx: CoursesRouteContext = {
		courseStore: store,
		paths,
		sessionExists: async (sessionId: string) => existsSync(join(paths.sessionDir, sessionId)),
		learningEvidence: async (sessionIds) => {
			const found: string[] = [];
			for (const sessionId of sessionIds) {
				if (evidence.has(sessionId)) {
					found.push(sessionId);
					continue;
				}
				// A record on disk is the real proof; the set only seeds it.
				const read = await readJsonStrict<LearningSessionRecord>(
					join(dataDir, "learning", `${sessionId}.json`),
				).catch(() => ({ found: false as const }));
				if (read.found && recordHasFormalEvidence(read.value)) found.push(sessionId);
			}
			return found;
		},
		// E4.7-R2: the preview's per-task count uses the same formal-evidence
		// definition as the blocker probe, counted per session.
		learningEvidenceCounts: async (sessionIds) => {
			const counts = new Map<string, number>();
			for (const sessionId of sessionIds) {
				const read = await readJsonStrict<LearningSessionRecord>(
					join(dataDir, "learning", `${sessionId}.json`),
				).catch(() => ({ found: false as const }));
				counts.set(sessionId, read.found ? countFormalEvidence(read.value) : 0);
			}
			return counts;
		},
	};
	return { ctx, root, dataDir, paths, store, evidence };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Captured {
	status: number;
	body: unknown;
}

async function call(
	ctx: CoursesRouteContext,
	method: string,
	url: string,
	body?: unknown,
): Promise<Captured> {
	let status = 0;
	let payload: unknown;
	const res: Record<string, unknown> = {
		destroyed: false,
		writableEnded: false,
		writeHead: (code: number) => { status = code; return res; },
		end: (value?: string) => {
			res.writableEnded = true;
			payload = value ? JSON.parse(value) : undefined;
			return res;
		},
	};
	const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]) as IncomingMessage;
	req.headers = {};
	const handled = await handleCoursesRoutes(req, res as unknown as ServerResponse, method, url, ctx);
	expect(handled, `${method} ${url} must be handled by the courses domain`).toBe(true);
	return { status, body: payload };
}

interface BlockerPayload {
	blockers?: Array<{ code: string; message: string; count?: number }>;
}

interface TaskDetailPayload {
	started_task_details?: Array<{
		task_id: string;
		task_title: string;
		plan_title: string | null;
		stage_title: string | null;
		task_status: string;
		completed_at?: string;
		updated_at: string;
		session_bound: boolean;
		session_ids: string[];
		b2_evidence: boolean;
		b2_evidence_count: number | null;
		evidence_state: string;
	}>;
	mastery_state_count?: number;
}

async function createCourse(ctx: CoursesRouteContext, title: string): Promise<string> {
	const created = await call(ctx, "POST", "/api/courses", { title });
	expect(created.status).toBe(201);
	return (created.body as { course_id: string }).course_id;
}

/** A binding must name a real session file; the route refuses a phantom one. */
async function touchSession(paths: RuntimePaths, sessionId: string): Promise<void> {
	await writeFile(join(paths.sessionDir, sessionId), "", "utf-8");
}

async function createPlan(
	ctx: CoursesRouteContext,
	courseId: string,
	input: { title: string; status?: string; tasks?: number },
): Promise<{ planId: string; taskIds: string[] }> {
	const taskCount = input.tasks ?? 1;
	const created = await call(ctx, "POST", `/api/courses/${courseId}/plans`, {
		title: input.title,
		...(input.status ? { status: input.status } : {}),
		stages: [
			{
				title: "第一阶段",
				tasks: Array.from({ length: taskCount }, (_, index) => ({ title: `任务 ${index + 1}` })),
			},
		],
	});
	expect(created.status).toBe(201);
	const body = created.body as { plan: { plan_id: string }; tasks: Array<{ task_id: string }> };
	return { planId: body.plan.plan_id, taskIds: body.tasks.map((task) => task.task_id) };
}

describe("course delete over HTTP", () => {
	it("deletes an empty course and the homepage list reflects it", async () => {
		const { ctx } = await makeHarness();
		const courseId = await createCourse(ctx, "空课程");
		await createCourse(ctx, "高等数学");

		const listed = await call(ctx, "GET", "/api/courses");
		expect((listed.body as { courses: Array<{ course_id: string }> }).courses).toHaveLength(2);

		const deleted = await call(ctx, "DELETE", `/api/courses/${courseId}`);
		expect(deleted.status).toBe(200);
		expect(deleted.body).toMatchObject({ deleted: true, course_id: courseId });

		const after = await call(ctx, "GET", "/api/courses");
		const rows = (after.body as { courses: Array<{ course_id: string }> }).courses;
		expect(rows.map((row) => row.course_id)).not.toContain(courseId);
		expect(rows).toHaveLength(1);

		// Gone means gone: the detail read reports 404, not an empty shell.
		expect((await call(ctx, "GET", `/api/courses/${courseId}`)).status).toBe(404);
	});

	it("deletes a course whose only plan is an AI draft, keeping the shared material", async () => {
		const { ctx, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		await call(ctx, "POST", `/api/courses/${courseId}/plans/generate`).catch(() => undefined);
		// A generated plan needs a model; create the equivalent draft shape directly.
		await call(ctx, "POST", `/api/courses/${courseId}/plans`, {
			title: "AI 建议计划",
			origin: "agent_suggested",
			status: "draft",
			stages: [{ title: "基础", tasks: [{ title: "阅读装饰器教材" }] }],
		});
		const bound = await call(ctx, "POST", `/api/courses/${courseId}/sources`, { source_id: "l2src_aaaaaaa1" });
		expect(bound.status).toBe(201);

		const deleted = await call(ctx, "DELETE", `/api/courses/${courseId}`);
		expect(deleted.status).toBe(200);
		expect(deleted.body).toMatchObject({ removed: { plans: 1, stages: 1, tasks: 1, sources: 1 } });

		// The document itself is shared state: still in the manifest, now unowned.
		const manifest = await readFile(join(paths.l2DataDir, "manifest.jsonl"), "utf-8");
		expect(manifest).toContain("l2src_aaaaaaa1");
		const unclassified = await call(ctx, "GET", "/api/courses/unclassified");
		expect((unclassified.body as { sources: string[] }).sources).toContain("l2src_aaaaaaa1");
	});

	it("returns every concrete reason instead of one generic conflict", async () => {
		const { ctx, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const plan = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await call(ctx, "PATCH", `/api/courses/${courseId}/tasks/${plan.taskIds[0]}`, { status: "in_progress" });
		await touchSession(paths, "session_a.jsonl");
		const bound = await call(ctx, "POST", `/api/courses/${courseId}/sessions`, {
			session_id: "session_a.jsonl",
			task_id: plan.taskIds[0],
			origin: "task",
		});
		expect(bound.status).toBe(201);

		const deleted = await call(ctx, "DELETE", `/api/courses/${courseId}`);
		expect(deleted.status).toBe(409);
		expect((deleted.body as { error: string }).error).toBe("course_conflict");
		const codes = (deleted.body as BlockerPayload).blockers?.map((blocker) => blocker.code) ?? [];
		expect(codes).toContain("course_sessions");
		expect(codes).toContain("started_tasks");
		// Each reason carries a readable message the dialog can print as-is.
		for (const blocker of (deleted.body as BlockerPayload).blockers ?? []) {
			expect(blocker.message.length).toBeGreaterThan(0);
		}
		// Nothing was removed.
		expect((await call(ctx, "GET", `/api/courses/${courseId}`)).status).toBe(200);
	});

	it("refuses a course whose session already holds formal B2 evidence", async () => {
		const { ctx, store, dataDir } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const plan = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await store.bindSession({
			courseId,
			sessionId: "session_b2.jsonl",
			taskId: plan.taskIds[0],
			origin: "task",
		});
		// A finalized attempt is evidence; the record is on disk, not a mock.
		await mkdir(join(dataDir, "learning"), { recursive: true });
		await writeFile(
			join(dataDir, "learning", "session_b2.jsonl.json"),
			JSON.stringify({
				schema_version: 1,
				checkpoint: {},
				questions: [],
				exposures: [],
				attempts: [{ progress: { stage: "evidence_recorded" } }],
			}),
			"utf-8",
		);

		const preview = await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`);
		expect(preview.status).toBe(200);
		const report = preview.body as { deletable: boolean } & BlockerPayload;
		expect(report.deletable).toBe(false);
		expect(report.blockers?.map((blocker) => blocker.code)).toEqual(["course_sessions", "learning_evidence"]);

		const deleted = await call(ctx, "DELETE", `/api/courses/${courseId}`);
		expect(deleted.status).toBe(409);
		expect((deleted.body as BlockerPayload).blockers?.map((blocker) => blocker.code))
			.toEqual(["course_sessions", "learning_evidence"]);
		// The B2 record is untouched by a refused delete.
		expect(existsSync(join(dataDir, "learning", "session_b2.jsonl.json"))).toBe(true);
	});

	it("names each blocking task and classifies evidence without guessing (E4.7-R2)", async () => {
		const { ctx, store, paths, dataDir } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const plan = await createPlan(ctx, courseId, { title: "启用计划", status: "active", tasks: 2 });
		// Task 1: in progress with a bound conversation that holds no B2 attempt.
		await call(ctx, "PATCH", `/api/courses/${courseId}/tasks/${plan.taskIds[0]}`, { status: "in_progress" });
		await touchSession(paths, "session_a.jsonl");
		expect((await call(ctx, "POST", `/api/courses/${courseId}/sessions`, {
			session_id: "session_a.jsonl",
			task_id: plan.taskIds[0],
			origin: "task",
		})).status).toBe(201);
		// Task 2: completed by status alone — no conversation, no formal evidence.
		await call(ctx, "PATCH", `/api/courses/${courseId}/tasks/${plan.taskIds[1]}`, { status: "completed" });

		const preview = await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`);
		expect(preview.status).toBe(200);
		const details = (preview.body as TaskDetailPayload).started_task_details ?? [];
		expect(details).toHaveLength(2);

		const [bound, statusOnly] = details;
		expect(bound).toMatchObject({
			task_id: plan.taskIds[0],
			task_title: "任务 1",
			plan_title: "启用计划",
			stage_title: "第一阶段",
			task_status: "in_progress",
			session_bound: true,
			session_ids: ["session_a.jsonl"],
			b2_evidence: false,
			b2_evidence_count: 0,
			evidence_state: "session_bound",
		});
		expect(statusOnly).toMatchObject({
			task_id: plan.taskIds[1],
			task_title: "任务 2",
			task_status: "completed",
			session_bound: false,
			session_ids: [],
			b2_evidence: false,
			evidence_state: "task_progress_only",
		});
		// A completed checkbox is not evidence, and the report never claims mastery.
		expect(statusOnly.completed_at).toBeTruthy();
		expect((preview.body as TaskDetailPayload).mastery_state_count).toBe(0);

		// Now B2 records a formal attempt for the bound conversation: the detail
		// must switch to `b2_evidence` with a real count.
		await mkdir(join(dataDir, "learning"), { recursive: true });
		await writeFile(
			join(dataDir, "learning", "session_a.jsonl.json"),
			JSON.stringify({
				schema_version: 1,
				checkpoint: {},
				questions: [],
				exposures: [],
				attempts: [
					{ progress: { stage: "evaluated" } },
					{ progress: { stage: "evidence_recorded" } },
					{ progress: { stage: "completed" } },
				],
			}),
			"utf-8",
		);
		const withEvidence = await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`);
		const updated = ((withEvidence.body as TaskDetailPayload).started_task_details ?? [])[0];
		expect(updated).toMatchObject({
			b2_evidence: true,
			b2_evidence_count: 2,
			evidence_state: "b2_evidence",
		});
		// The preview is a read: no course state was touched.
		expect(await store.getCourse(courseId)).toBeTruthy();
	});

	it("reports course-scoped L1 mastery separately from task status", async () => {
		const { ctx, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const other = await createCourse(ctx, "高等数学");
		await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`);
		// Write one course-scoped state and one unclassified state directly: the
		// profile store is the L1 owner and this test is about the report.
		const profilePath = join(paths.learnerDataDir, "profile.json");
		const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
			knowledge_states: Array<Record<string, unknown>>;
		};
		profile.knowledge_states = [
			{ concept_id: "c1", concept_name: "装饰器", domain: "python", course_id: courseId, mastery: 0.4 },
			{ concept_id: "c2", concept_name: "极限", domain: "math", course_id: other, mastery: 0.5 },
		];
		await writeFile(profilePath, JSON.stringify(profile), "utf-8");

		const preview = await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`);
		expect(preview.status).toBe(200);
		expect((preview.body as TaskDetailPayload).mastery_state_count).toBe(1);
		// Mastery alone blocks the delete, and the two courses never mix.
		expect((preview.body as BlockerPayload).blockers?.map((blocker) => blocker.code)).toContain("mastery_states");
	});

	it("is safe to repeat: the second delete reports 404 without touching other courses", async () => {
		const { ctx } = await makeHarness();
		const courseId = await createCourse(ctx, "空课程");
		const other = await createCourse(ctx, "高等数学");
		expect((await call(ctx, "DELETE", `/api/courses/${courseId}`)).status).toBe(200);
		expect((await call(ctx, "DELETE", `/api/courses/${courseId}`)).status).toBe(404);
		expect((await call(ctx, "GET", `/api/courses/${other}`)).status).toBe(200);
	});

	it("keeps L1/L2/L3/B2 files identical when a history-free course is deleted", async () => {
		const { ctx, dataDir, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "空课程");
		await touchSession(paths, "session_other.jsonl");
		// Warm the L1 store first: this test is about the delete, not about the
		// bootstrap files any course page read would create.
		expect((await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`)).status).toBe(200);

		const snapshot = async () => ({
			profile: await readFile(join(paths.learnerDataDir, "profile.json"), "utf-8"),
			learner_files: (await readdir(paths.learnerDataDir))
				.filter((name) => !name.startsWith(".writer.lock"))
				.sort(),
			manifest: await readFile(join(paths.l2DataDir, "manifest.jsonl"), "utf-8"),
			l3: (await readdir(paths.l3DataDir).catch(() => [])).sort(),
			sessions: (await readdir(paths.sessionDir)).sort(),
			learning: (await readdir(join(dataDir, "learning")).catch(() => [])).sort(),
		});
		const before = await snapshot();

		expect((await call(ctx, "DELETE", `/api/courses/${courseId}`)).status).toBe(200);

		expect(await snapshot()).toEqual(before);
	});
});

describe("plan delete over HTTP", () => {
	it("deletes a draft plan without touching the other plan", async () => {
		const { ctx } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const draft = await createPlan(ctx, courseId, { title: "草稿计划", status: "draft" });
		const active = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });

		const deleted = await call(ctx, "DELETE", `/api/courses/${courseId}/plans/${draft.planId}`);
		expect(deleted.status).toBe(200);
		expect(deleted.body).toMatchObject({ removed: { plans: 1, stages: 1, tasks: 1 } });

		const plans = await call(ctx, "GET", `/api/courses/${courseId}/plans`);
		const rows = (plans.body as { plans: Array<{ plan_id: string; revision: number; status: string }> }).plans;
		expect(rows.map((row) => row.plan_id)).toEqual([active.planId]);
		expect(rows[0].status).toBe("active");
		// The surviving plan was not rewritten by someone else's delete.
		expect(rows[0].revision).toBe(1);
	});

	it("allows deleting a confirmed plan that never started and refreshes today's tasks", async () => {
		const { ctx } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const active = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });

		const before = await call(ctx, "GET", `/api/courses/daily?course_id=${courseId}`);
		expect(before.body).toMatchObject({
			courses: [{ course_id: courseId, status: "ok", plan: { plan_id: active.planId } }],
		});

		expect((await call(ctx, "DELETE", `/api/courses/${courseId}/plans/${active.planId}`)).status).toBe(200);

		const after = await call(ctx, "GET", `/api/courses/daily?course_id=${courseId}`);
		expect(after.body).toMatchObject({
			courses: [{ course_id: courseId, status: "no_active_plan", plan: null, items: [] }],
		});
		const crossCourse = await call(ctx, "GET", "/api/courses/daily");
		expect((crossCourse.body as { courses: Array<{ course_id: string }> }).courses).toHaveLength(1);
		expect((crossCourse.body as { total_planned_minutes: number }).total_planned_minutes).toBe(0);
	});

	it("refuses a plan whose task owns a session", async () => {
		const { ctx, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const active = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await touchSession(paths, "session_a.jsonl");
		const bound = await call(ctx, "POST", `/api/courses/${courseId}/sessions`, {
			session_id: "session_a.jsonl",
			task_id: active.taskIds[0],
			origin: "task",
		});
		expect(bound.status).toBe(201);

		const preview = await call(ctx, "GET", `/api/courses/${courseId}/plans/${active.planId}/delete-preview`);
		expect(preview.status).toBe(200);
		expect(preview.body).toMatchObject({
			deletable: false,
			blockers: [{ code: "plan_sessions", count: 1 }],
		});

		const deleted = await call(ctx, "DELETE", `/api/courses/${courseId}/plans/${active.planId}`);
		expect(deleted.status).toBe(409);
		expect((deleted.body as BlockerPayload).blockers?.map((blocker) => blocker.code)).toEqual(["plan_sessions"]);
		expect((await call(ctx, "GET", `/api/courses/${courseId}/plans/${active.planId}`)).status).toBe(200);
	});

	it("archives a plan with real records and keeps them readable", async () => {
		const { ctx, store, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const active = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await touchSession(paths, "session_a.jsonl");
		const bound = await call(ctx, "POST", `/api/courses/${courseId}/sessions`, {
			session_id: "session_a.jsonl",
			task_id: active.taskIds[0],
			origin: "task",
		});
		expect(bound.status).toBe(201);
		await call(ctx, "PATCH", `/api/courses/${courseId}/tasks/${active.taskIds[0]}`, { status: "completed" });

		const archived = await call(ctx, "POST", `/api/courses/${courseId}/plans/${active.planId}/archive`);
		expect(archived.status).toBe(200);
		expect(archived.body).toMatchObject({ status: "archived" });
		// Idempotent, and it does not delete or unbind anything.
		expect((await call(ctx, "POST", `/api/courses/${courseId}/plans/${active.planId}/archive`)).status).toBe(200);

		const detail = await call(ctx, "GET", `/api/courses/${courseId}/plans/${active.planId}`);
		expect(detail.status).toBe(200);
		expect(((detail.body as { tasks: unknown[] }).tasks)).toHaveLength(1);
		expect((detail.body as { tasks: Array<{ status: string }> }).tasks[0].status).toBe("completed");

		const sessions = await call(ctx, "GET", `/api/courses/${courseId}/sessions`);
		expect((sessions.body as { sessions: unknown[] }).sessions).toHaveLength(1);
		expect((await store.listSessionBindings(courseId)).length).toBe(1);

		// Archiving is not a delete: the plan still exists and refuses deletion.
		expect((await call(ctx, "DELETE", `/api/courses/${courseId}/plans/${active.planId}`)).status).toBe(409);
	});

	it("returns 404 for an unknown plan and 400 for an unsafe id", async () => {
		const { ctx } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		expect((await call(ctx, "DELETE", `/api/courses/${courseId}/plans/plan_missing`)).status).toBe(404);
		expect((await call(ctx, "POST", `/api/courses/${courseId}/plans/../archive`)).status).toBe(400);
	});
});

describe("archive vs delete for a course with history", () => {
	it("archives a course, keeps the records viewable, and never allows a delete", async () => {
		const { ctx, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const active = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await touchSession(paths, "session_a.jsonl");
		const bound = await call(ctx, "POST", `/api/courses/${courseId}/sessions`, {
			session_id: "session_a.jsonl",
			task_id: active.taskIds[0],
			origin: "task",
		});
		expect(bound.status).toBe(201);
		await call(ctx, "PATCH", `/api/courses/${courseId}/tasks/${active.taskIds[0]}`, { status: "completed" });

		const archived = await call(ctx, "POST", `/api/courses/${courseId}/archive`);
		expect(archived.status).toBe(200);
		expect(archived.body).toMatchObject({ status: "archived" });

		const detail = await call(ctx, "GET", `/api/courses/${courseId}`);
		const snapshot = detail.body as {
			counts: { sessions: number; tasks: number };
			tasks: Array<{ status: string }>;
		};
		expect(snapshot.counts.sessions).toBe(1);
		expect(snapshot.tasks[0].status).toBe("completed");
		expect((await call(ctx, "DELETE", `/api/courses/${courseId}`)).status).toBe(409);
	});
});

describe("E4.7-R1 — archived courses are read-only for learning progress", () => {
	it("refuses learning/start, manual binding and task progress without creating anything", async () => {
		const { ctx, paths } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const plan = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await touchSession(paths, "session_manual.jsonl");
		let createSessionCalls = 0;
		ctx.learningRuntime = {
			createSession: async () => {
				createSessionCalls += 1;
				return { sessionId: "session_should_not_exist.jsonl", previousSessionId: "" };
			},
			activateSession: async () => "ok",
			discardSession: async () => ({ discarded: true }),
			sessionState: () => null,
			initializeLearningRecord: async () => ({ created: true, checkpoint: null }),
		};
		expect((await call(ctx, "POST", `/api/courses/${courseId}/archive`)).status).toBe(200);

		const started = await call(ctx, "POST", `/api/courses/${courseId}/learning/start`, {
			task_id: plan.taskIds[0],
			request_id: "req_archived_course",
		});
		expect(started.status).toBe(409);
		expect(started.body).toMatchObject({ error: "course_archived" });
		expect(createSessionCalls).toBe(0);

		const bound = await call(ctx, "POST", `/api/courses/${courseId}/sessions`, {
			session_id: "session_manual.jsonl",
			task_id: plan.taskIds[0],
			origin: "manual",
		});
		expect(bound.status).toBe(409);
		expect(bound.body).toMatchObject({ error: "course_archived" });

		const patched = await call(ctx, "PATCH", `/api/courses/${courseId}/tasks/${plan.taskIds[0]}`, {
			status: "in_progress",
		});
		expect(patched.status).toBe(409);
		expect(patched.body).toMatchObject({ error: "course_archived" });

		// Nothing advanced: the task is still pending and no session was bound.
		const detail = await call(ctx, "GET", `/api/courses/${courseId}`);
		expect((detail.body as { tasks: Array<{ status: string }> }).tasks[0].status).toBe("pending");
		expect((detail.body as { sessions: unknown[] }).sessions).toHaveLength(0);
		expect(existsSync(join(paths.sessionDir, "session_should_not_exist.jsonl"))).toBe(false);
	});
});

describe("E4.7-R1 final — paused resume and archive gates", () => {
	it("resumes a restored course through its own endpoint, without a session", async () => {
		const { ctx } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const plan = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await call(ctx, "PATCH", `/api/courses/${courseId}`, { status: "paused" });

		const resumed = await call(ctx, "POST", `/api/courses/${courseId}/resume`);
		expect(resumed.status).toBe(200);
		expect(resumed.body).toMatchObject({ course_id: courseId, status: "in_progress" });

		const detail = await call(ctx, "GET", `/api/courses/${courseId}`);
		expect((detail.body as { sessions: unknown[] }).sessions).toHaveLength(0);
		const task = (detail.body as { tasks: Array<{ task_id: string; status: string }> })
			.tasks.find((row) => row.task_id === plan.taskIds[0]);
		expect(task?.status).toBe("pending");
	});

	it("refuses to start learning while the course is paused", async () => {
		const { ctx } = await makeHarness();
		let created = 0;
		// A live runtime so the refusal is the course state, not a missing agent.
		ctx.learningRuntime = {
			createSession: async () => {
				created += 1;
				return { sessionId: "session_paused.jsonl", previousSessionId: "" };
			},
			activateSession: async () => "ok",
			discardSession: async () => ({ discarded: true }),
			sessionState: () => null,
			initializeLearningRecord: async () => ({ created: true, checkpoint: null }),
		};
		const courseId = await createCourse(ctx, "Python 编程");
		const plan = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await call(ctx, "PATCH", `/api/courses/${courseId}`, { status: "paused" });

		const started = await call(ctx, "POST", `/api/courses/${courseId}/learning/start`, {
			task_id: plan.taskIds[0],
			request_id: "req_paused_probe",
		});
		expect(started.status).toBe(409);
		expect(started.body).toMatchObject({ error: "course_paused" });
		expect(created).toBe(0);
	});

	it("does not let a status patch bypass the restore flow", async () => {
		const { ctx } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		expect((await call(ctx, "POST", `/api/courses/${courseId}/archive`)).status).toBe(200);

		for (const status of ["in_progress", "paused", "completed"]) {
			const patched = await call(ctx, "PATCH", `/api/courses/${courseId}`, { status });
			expect(patched.status).toBe(409);
			expect(patched.body).toMatchObject({ error: "course_archived" });
		}
		// Resume also refuses an archived course; restore is the only way out.
		const resumed = await call(ctx, "POST", `/api/courses/${courseId}/resume`);
		expect(resumed.status).toBe(409);
		expect(resumed.body).toMatchObject({ error: "course_archived" });

		const restored = await call(ctx, "POST", `/api/courses/${courseId}/restore`);
		expect(restored.body).toMatchObject({ status: "paused" });
	});
});

describe("E4.7-R2a — B2 read failures stay fail-closed", () => {
	it("returns 503 for the preview and the delete, and removes nothing", async () => {
		const { ctx, store } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		await store.bindSession({ courseId, sessionId: "session_b2_broken.jsonl" });
		const before = JSON.parse(await readFile(join(ctx.paths.dataDir, "courses", "state.json"), "utf-8")) as {
			courses: Array<{ course_id: string }>;
		};
		// A corrupt record reaches the route as a probe failure. It must not be
		// read as "no evidence": the server cannot prove the delete is safe.
		ctx.learningEvidence = async () => {
			throw new Error("B2 record is corrupt");
		};

		const preview = await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`);
		expect(preview.status).toBe(503);
		expect(preview.body).toMatchObject({ error: "course_io" });

		const deleted = await call(ctx, "DELETE", `/api/courses/${courseId}`);
		expect(deleted.status).toBe(503);
		expect(deleted.body).toMatchObject({ error: "course_io" });

		const after = JSON.parse(await readFile(join(ctx.paths.dataDir, "courses", "state.json"), "utf-8")) as {
			courses: Array<{ course_id: string }>;
		};
		expect(after.courses.map((course) => course.course_id))
			.toEqual(before.courses.map((course) => course.course_id));
		expect(await store.getCourse(courseId)).toBeTruthy();
	});
});

describe("E4.7-R2a — course preview names every blocking conversation", () => {
	it("annotates pending-task and course-level sessions with archive state and B2 counts", async () => {
		const { ctx, store, paths, dataDir } = await makeHarness();
		const courseId = await createCourse(ctx, "Python 编程");
		const plan = await createPlan(ctx, courseId, { title: "启用计划", status: "active" });
		await touchSession(paths, "session_pending.jsonl");
		await touchSession(paths, "session_free.jsonl");
		await store.bindSession({
			courseId,
			sessionId: "session_pending.jsonl",
			taskId: plan.taskIds[0],
			origin: "task",
		});
		await store.bindSession({ courseId, sessionId: "session_free.jsonl", origin: "manual" });
		// S2 was manually archived; S1 holds one formal B2 attempt.
		await writeFile(
			join(paths.sessionDir, "archives.json"),
			JSON.stringify({ "session_free.jsonl": true }),
			"utf-8",
		);
		await mkdir(join(dataDir, "learning"), { recursive: true });
		await writeFile(
			join(dataDir, "learning", "session_pending.jsonl.json"),
			JSON.stringify({
				schema_version: 1,
				checkpoint: {},
				questions: [],
				exposures: [],
				attempts: [{ progress: { stage: "evidence_recorded" } }],
			}),
			"utf-8",
		);

		const preview = await call(ctx, "GET", `/api/courses/${courseId}/delete-preview`);
		expect(preview.status).toBe(200);
		const details = (preview.body as {
			session_details: Array<{
				session_id: string;
				task_title: string | null;
				archived: boolean | null;
				b2_evidence: boolean;
				b2_evidence_count: number | null;
			}>;
		}).session_details;
		const bySession = new Map(details.map((detail) => [detail.session_id, detail]));
		expect(bySession.get("session_pending.jsonl")).toMatchObject({
			task_title: "任务 1",
			archived: false,
			b2_evidence: true,
			b2_evidence_count: 1,
		});
		expect(bySession.get("session_free.jsonl")).toMatchObject({
			task_title: null,
			archived: true,
			b2_evidence: false,
			b2_evidence_count: 0,
		});
	});
});
