import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore, CourseStoreError } from "./course-store.js";
import { startLearning, type LearningStartDeps } from "./learning-start.js";

/**
 * E4.7 — course/plan lifecycle.
 *
 * The invariants under test are destructive-operation invariants, so every
 * refusal also asserts that the state file was not rewritten: a check that
 * throws after a partial mutation would be worse than no check at all.
 */

const roots: string[] = [];

async function makeStore(): Promise<{ store: CourseStore; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-courses-lifecycle-"));
	roots.push(root);
	const dataDir = join(root, "data");
	return { store: new CourseStore({ dataDir }), dataDir };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function revisionOf(dataDir: string): Promise<number> {
	const state = JSON.parse(await readFile(join(dataDir, "courses", "state.json"), "utf-8")) as { revision: number };
	return state.revision;
}

async function expectBlocked(promise: Promise<unknown>, codes: string[]): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(CourseStoreError);
	const error = await promise.then(() => null, (err: unknown) => err as CourseStoreError);
	expect(error?.code).toBe("COURSE_CONFLICT");
	expect(error?.blockers?.map((blocker) => blocker.code)).toEqual(codes);
}

describe("course deletion", () => {
	it("deletes an archived course with no plans and leaves every other course untouched", async () => {
		const { store } = await makeStore();
		const empty = await store.createCourse({ title: "空课程" });
		const other = await store.createCourse({ title: "高等数学" });
		await store.archiveCourse(empty.course_id);

		const outcome = await store.deleteCourse(empty.course_id);
		expect(outcome.course_id).toBe(empty.course_id);
		expect(outcome.removed).toMatchObject({ plans: 0, stages: 0, tasks: 0, sessions: 0 });

		const state = await store.readState();
		expect(state.courses.map((course) => course.course_id)).toEqual([other.course_id]);
		expect(await store.getCourse(empty.course_id)).toBeUndefined();
	});

	it("deletes a course whose only plan is an unconfirmed AI draft", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const other = await store.createCourse({ title: "高等数学" });
		await store.createPlanWithStructure(course.course_id, {
			title: "AI 建议计划",
			origin: "agent_suggested",
			status: "draft",
			stages: [{ title: "基础", tasks: [{ title: "阅读装饰器教材" }, { title: "写一个装饰器" }] }],
		});
		await store.bindGoal(course.course_id, "goal_python");
		await store.bindSource(course.course_id, "l2src_aaaaaaa1");
		await store.setStudySettings(course.course_id, 45);
		await store.archiveCourse(course.course_id);

		const outcome = await store.deleteCourse(course.course_id);
		expect(outcome.removed).toMatchObject({ plans: 1, stages: 1, tasks: 2, goals: 1, sources: 1, sessions: 0 });

		const state = await store.readState();
		expect(state.courses.map((row) => row.course_id)).toEqual([other.course_id]);
		expect(state.plans.filter((plan) => plan.course_id === course.course_id)).toEqual([]);
		expect(state.stages.filter((stage) => stage.course_id === course.course_id)).toEqual([]);
		expect(state.tasks.filter((task) => task.course_id === course.course_id)).toEqual([]);
		expect(state.goal_bindings.filter((binding) => binding.course_id === course.course_id)).toEqual([]);
		expect(state.study_settings.filter((settings) => settings.course_id === course.course_id)).toEqual([]);
		// The material association is gone; the source id is not a row this
		// store ever owned, so deleting a course cannot delete the document.
		expect(state.source_bindings.filter((binding) => binding.course_id === course.course_id)).toEqual([]);
	});

	it("refuses a course that is not archived and points at archiving first", async () => {
		const { store, dataDir } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const before = await revisionOf(dataDir);

		await expectBlocked(store.deleteCourse(course.course_id), ["course_not_archived"]);
		expect(await revisionOf(dataDir)).toBe(before);
		expect(await store.getCourse(course.course_id)).toBeTruthy();
	});

	it("deletes an archived course with a session after its owner cleans it (E4.8d)", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const { tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "Python 计划",
			status: "active",
			stages: [{ title: "基础", tasks: [{ title: "阅读教材" }] }],
		});
		await store.bindSession({
			courseId: course.course_id,
			sessionId: "session_a.jsonl",
			taskId: tasks[0].task_id,
			origin: "task",
		});
		await store.updateTask(course.course_id, tasks[0].task_id, { status: "completed" });
		await store.archiveCourse(course.course_id);

		const preview = await store.inspectCourseDeletion(course.course_id);
		expect(preview).toMatchObject({ archived: true, deletable: true, blockers: [] });
		expect(preview.counts).toMatchObject({ sessions: 1, started_tasks: 1 });

		const cleaned: string[] = [];
		const outcome = await store.deleteCourse(course.course_id, {
			cleanupSessions: async (sessionIds) => {
				cleaned.push(...sessionIds);
				return { cleaned: [...sessionIds], failed: [] };
			},
		});
		expect(cleaned).toEqual(["session_a.jsonl"]);
		expect(outcome).toMatchObject({ sessions_removed: 1, complete: true, removed: { sessions: 1, tasks: 1 } });
		expect((await store.readState()).courses).toEqual([]);
	});

	it("refuses to delete rows while conversations are still bound (no fake cleanup)", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindSession({ courseId: course.course_id, sessionId: "session_a.jsonl", origin: "free_question" });
		await store.archiveCourse(course.course_id);

		// No cleanup callback: the store must refuse instead of dropping the row
		// and leaving the chat file orphaned.
		await expect(store.deleteCourse(course.course_id)).rejects.toMatchObject({ code: "COURSE_IO" });
		expect(await store.getCourse(course.course_id)).toBeTruthy();
		expect((await store.listSessionBindings(course.course_id)).map((binding) => binding.session_id))
			.toEqual(["session_a.jsonl"]);

		// A cleanup that reports a failure also keeps the course.
		await expect(store.deleteCourse(course.course_id, {
			cleanupSessions: async (sessionIds) => ({ cleaned: [], failed: [...sessionIds] }),
		})).rejects.toMatchObject({ code: "COURSE_IO" });
		expect(await store.getCourse(course.course_id)).toBeTruthy();
	});

	it("keeps a course when cleanup did not cover every bound conversation", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindSession({ courseId: course.course_id, sessionId: "session_a.jsonl", origin: "free_question" });
		await store.bindSession({ courseId: course.course_id, sessionId: "session_b.jsonl", origin: "free_question" });
		await store.archiveCourse(course.course_id);

		// The owner claims success for one conversation only. Deleting the course
		// now would orphan the other chat file, so the transaction must refuse.
		await expect(store.deleteCourse(course.course_id, {
			cleanupSessions: async () => ({ cleaned: ["session_a.jsonl"], failed: [] }),
		})).rejects.toBeInstanceOf(CourseStoreError);
		expect(await store.getCourse(course.course_id)).toBeTruthy();
	});

	it("refuses an archived course with an unfinished learning start", async () => {
		const { store, dataDir } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.reserveLearningStart({ courseId: course.course_id, requestId: "learn_req_open" });
		await store.archiveCourse(course.course_id);
		const before = await revisionOf(dataDir);

		await expectBlocked(store.deleteCourse(course.course_id), ["pending_learning_start"]);
		expect(await revisionOf(dataDir)).toBe(before);

		// Once the request is aborted the course can be deleted.
		await store.abortLearningStart("learn_req_open");
		await expect(store.deleteCourse(course.course_id)).resolves.toMatchObject({ course_id: course.course_id });
	});

	it("reports what a delete would remove before anything is deleted", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.createPlanWithStructure(course.course_id, {
			title: "草稿",
			status: "draft",
			stages: [
				{ title: "基础", tasks: [{ title: "任务一" }, { title: "任务二" }] },
				{ title: "进阶", tasks: [{ title: "任务三" }] },
			],
		});
		await store.bindSource(course.course_id, "l2src_aaaaaaa1");
		await store.archiveCourse(course.course_id);

		const report = await store.inspectCourseDeletion(course.course_id);
		expect(report).toMatchObject({
			course_id: course.course_id,
			title: "Python 编程",
			archived: true,
			deletable: true,
			has_material: true,
			blockers: [],
			counts: { plans: 1, stages: 2, tasks: 3, sessions: 0, sources: 1 },
		});
		// A preflight never mutates.
		expect(await store.getCourse(course.course_id)).toBeTruthy();
	});

	it("names each started task with its plan, stage and session binding (E4.7-R2)", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const { plan, tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "Python 计划",
			status: "active",
			stages: [{ title: "基础语法", tasks: [{ title: "阅读装饰器教材" }, { title: "写一个装饰器" }] }],
		});
		await store.updateTask(course.course_id, tasks[0].task_id, { status: "in_progress" });
		await store.updateTask(course.course_id, tasks[1].task_id, { status: "completed" });
		await store.bindSession({
			courseId: course.course_id,
			sessionId: "session_a.jsonl",
			taskId: tasks[0].task_id,
			origin: "task",
		});

		const report = await store.inspectCourseDeletion(course.course_id);
		expect(report.started_task_details).toHaveLength(2);
		const [first, second] = report.started_task_details;
		expect(first).toMatchObject({
			task_id: tasks[0].task_id,
			task_title: "阅读装饰器教材",
			plan_id: plan.plan_id,
			plan_title: "Python 计划",
			stage_title: "基础语法",
			task_status: "in_progress",
			session_bound: true,
			session_ids: ["session_a.jsonl"],
			// A binding is not evidence; only B2 can promote it.
			b2_evidence: false,
			b2_evidence_count: null,
			evidence_state: "session_bound",
		});
		expect(first.stage_id).toBeTruthy();
		expect(second).toMatchObject({
			task_title: "写一个装饰器",
			task_status: "completed",
			session_bound: false,
			session_ids: [],
			evidence_state: "task_progress_only",
		});
		// A completed task carries its completion time, not an evidence claim.
		expect(second.completed_at).toBeTruthy();
		expect(second.b2_evidence).toBe(false);
	});

	it("keeps unstarted tasks out of the detail list", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.createPlanWithStructure(course.course_id, {
			title: "Python 计划",
			status: "active",
			stages: [{ title: "基础", tasks: [{ title: "未开始的任务" }] }],
		});
		const report = await store.inspectCourseDeletion(course.course_id);
		expect(report.started_task_details).toEqual([]);
		expect(report.counts.started_tasks).toBe(0);
	});

	it("reports an unknown course as not found and refuses an unsafe id", async () => {
		const { store } = await makeStore();
		await expect(store.inspectCourseDeletion("course_missing")).rejects.toMatchObject({ code: "COURSE_NOT_FOUND" });
		await expect(store.deleteCourse("../escape")).rejects.toMatchObject({ code: "COURSE_INVALID" });
	});

	it("is idempotent in its failure: a repeated delete reports not found, never a half state", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "空课程" });
		await store.archiveCourse(course.course_id);
		await store.deleteCourse(course.course_id);
		await expect(store.deleteCourse(course.course_id)).rejects.toMatchObject({ code: "COURSE_NOT_FOUND" });
		expect((await store.readState()).courses).toEqual([]);
	});
});

describe("plan deletion", () => {
	async function seedTwoPlans(store: CourseStore) {
		const course = await store.createCourse({ title: "Python 编程" });
		const draft = await store.createPlanWithStructure(course.course_id, {
			title: "草稿计划",
			status: "draft",
			stages: [{ title: "基础", tasks: [{ title: "草稿任务" }] }],
		});
		const active = await store.createPlanWithStructure(course.course_id, {
			title: "启用计划",
			status: "active",
			stages: [{ title: "入门", tasks: [{ title: "启用任务" }] }],
		});
		return { course, draft, active };
	}

	it("deletes a draft plan without touching the other plan", async () => {
		const { store } = await makeStore();
		const { course, draft, active } = await seedTwoPlans(store);

		const outcome = await store.deletePlan(course.course_id, draft.plan.plan_id);
		expect(outcome.removed).toMatchObject({ plans: 1, stages: 1, tasks: 1, sessions: 0 });

		const state = await store.readState();
		expect(state.plans.map((plan) => plan.plan_id)).toEqual([active.plan.plan_id]);
		expect(state.tasks.map((task) => task.task_id)).toEqual([active.tasks[0].task_id]);
		expect(state.stages.map((stage) => stage.stage_id)).toEqual([active.stages[0].stage_id]);
		// The surviving plan's revision is untouched: nothing about it changed.
		expect(state.plans[0].revision).toBe(active.plan.revision);
	});

	it("allows deleting a confirmed plan that has not started", async () => {
		const { store } = await makeStore();
		const { course, draft, active } = await seedTwoPlans(store);
		expect(active.plan.status).toBe("active");

		await expect(store.deletePlan(course.course_id, active.plan.plan_id))
			.resolves.toMatchObject({ plan_id: active.plan.plan_id });
		const state = await store.readState();
		// Only the deleted plan is gone; the draft stays a draft. Deleting the
		// active plan must not promote anything ("不得自动启用其他草稿").
		expect(state.plans.map((plan) => plan.plan_id)).toEqual([draft.plan.plan_id]);
		expect(state.plans[0].status).toBe("draft");
		expect(state.tasks.map((task) => task.task_id)).toEqual([draft.tasks[0].task_id]);
	});

	it("refuses a plan whose task owns a session", async () => {
		const { store, dataDir } = await makeStore();
		const { course, active } = await seedTwoPlans(store);
		await store.bindSession({
			courseId: course.course_id,
			sessionId: "session_a.jsonl",
			taskId: active.tasks[0].task_id,
			origin: "task",
		});
		const before = await revisionOf(dataDir);

		await expectBlocked(store.deletePlan(course.course_id, active.plan.plan_id), ["plan_sessions"]);
		expect(await revisionOf(dataDir)).toBe(before);
		expect(await store.getPlan(course.course_id, active.plan.plan_id)).toBeTruthy();
	});

	it("refuses a plan with a started task and a completed plan", async () => {
		const { store } = await makeStore();
		const { course, active } = await seedTwoPlans(store);
		await store.updateTask(course.course_id, active.tasks[0].task_id, { status: "in_progress" });
		await expectBlocked(store.deletePlan(course.course_id, active.plan.plan_id), ["started_tasks"]);

		const completed = await store.createPlan(course.course_id, {
			title: "已完成的计划",
			status: "active",
		});
		await store.updatePlan(course.course_id, completed.plan_id, { status: "completed" });
		await expectBlocked(store.deletePlan(course.course_id, completed.plan_id), ["plan_completed"]);
	});

	it("refuses a plan with an unfinished learning start for one of its tasks", async () => {
		const { store } = await makeStore();
		const { course, active } = await seedTwoPlans(store);
		await store.reserveLearningStart({
			courseId: course.course_id,
			requestId: "learn_req_plan",
			taskId: active.tasks[0].task_id,
		});
		await expectBlocked(store.deletePlan(course.course_id, active.plan.plan_id), ["pending_learning_start"]);
	});

	it("keeps a plan's learning history readable after archiving it", async () => {
		const { store } = await makeStore();
		const { course, active } = await seedTwoPlans(store);
		await store.bindSession({
			courseId: course.course_id,
			sessionId: "session_a.jsonl",
			taskId: active.tasks[0].task_id,
			origin: "task",
		});
		await store.updateTask(course.course_id, active.tasks[0].task_id, { status: "completed" });

		const archived = await store.archivePlan(course.course_id, active.plan.plan_id);
		expect(archived.status).toBe("archived");
		// Archiving is idempotent and never rewrites history.
		const again = await store.archivePlan(course.course_id, active.plan.plan_id);
		expect(again.revision).toBe(archived.revision);

		const detail = await store.getPlan(course.course_id, active.plan.plan_id);
		expect(detail?.status).toBe("archived");
		expect(await store.listTasks(course.course_id, active.plan.plan_id)).toHaveLength(1);
		expect((await store.listSessionBindings(course.course_id)).map((binding) => binding.session_id))
			.toEqual(["session_a.jsonl"]);
	});

	it("reports plan counts without mutating, and 404s for an unknown plan", async () => {
		const { store } = await makeStore();
		const { course, active } = await seedTwoPlans(store);
		const report = await store.inspectPlanDeletion(course.course_id, active.plan.plan_id);
		expect(report).toMatchObject({
			plan_id: active.plan.plan_id,
			deletable: true,
			counts: { stages: 1, tasks: 1, started_tasks: 0, sessions: 0 },
		});
		// Nothing started → no detail rows, and the payload is still well-formed.
		expect(report.started_task_details).toEqual([]);
		await expect(store.inspectPlanDeletion(course.course_id, "plan_missing"))
			.rejects.toMatchObject({ code: "COURSE_NOT_FOUND" });
	});
});

describe("concurrency", () => {
	it("never leaves a session binding behind when a delete races a learning start", async () => {
		const { store, dataDir } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const { tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "Python 计划",
			status: "active",
			stages: [{ title: "基础", tasks: [{ title: "阅读教材" }] }],
		});
		const sessions = new Set<string>();
		const deps: LearningStartDeps = {
			courseStore: store,
			sessionExists: async (sessionId) => sessions.has(sessionId),
			sessionState: () => null,
			createSession: async () => {
				sessions.add("session_new.jsonl");
				return { sessionId: "session_new.jsonl", previousSessionId: "session_prev.jsonl" };
			},
			discardSession: async (sessionId) => {
				sessions.delete(sessionId);
				return { discarded: true };
			},
			activateSession: async () => "ok",
			initializeLearningRecord: async () => ({ created: true, checkpoint: null }),
		};

		const [deleted, started] = await Promise.allSettled([
			store.deleteCourse(course.course_id),
			startLearning(deps, { courseId: course.course_id, taskId: tasks[0].task_id, requestId: "learn_req_race" }),
		]);

		const state = await store.readState();
		const courseIds = new Set(state.courses.map((row) => row.course_id));
		// Invariant 1: no binding may name a course that no longer exists.
		for (const binding of state.session_bindings) expect(courseIds.has(binding.course_id)).toBe(true);
		// Invariant 2: exactly one side won; the other was refused, not half-applied.
		const deleteWon = deleted.status === "fulfilled";
		const startWon = started.status === "fulfilled" && started.value.status === "ready";
		expect(deleteWon !== startWon).toBe(true);
		if (deleteWon) {
			expect(state.session_bindings).toEqual([]);
			expect(state.learning_starts).toEqual([]);
			expect(sessions.size).toBe(0);
		} else {
			expect(courseIds.has(course.course_id)).toBe(true);
			expect(state.session_bindings).toHaveLength(1);
		}
		// Either way the revision moved only for the committed winner.
		expect(await revisionOf(dataDir)).toBeGreaterThan(0);
	});
});

describe("E4.7-R1 — stale reservations and archived courses", () => {
	async function makeClockStore(startIso: string) {
		const root = await mkdtemp(join(tmpdir(), "inno-courses-r1-"));
		roots.push(root);
		let now = new Date(startIso);
		const store = new CourseStore({ dataDir: join(root, "data"), now: () => now });
		return { store, advance: (iso: string) => { now = new Date(iso); } };
	}

	it("ignores a sessionless start older than the in-flight window and cleans it up", async () => {
		const { store, advance } = await makeClockStore("2026-11-11T10:00:00.000Z");
		const course = await store.createCourse({ title: "空课程" });
		await store.reserveLearningStart({ courseId: course.course_id, requestId: "learn_stale" });
		await store.archiveCourse(course.course_id);

		// Right away the reservation still counts: it may be genuinely in flight.
		expect((await store.inspectCourseDeletion(course.course_id)).deletable).toBe(false);

		// Twenty minutes later a `creating` row with no session cannot be work in
		// flight any more — this is the leak E4.7-R1 removed from learning/start.
		advance("2026-11-11T10:20:00.000Z");
		const preview = await store.inspectCourseDeletion(course.course_id);
		expect(preview.deletable).toBe(true);
		await expect(store.deleteCourse(course.course_id)).resolves.toMatchObject({ course_id: course.course_id });
		expect((await store.readState()).learning_starts).toEqual([]);
	});

	it("keeps blocking when the reservation already names a session", async () => {
		const { store, advance } = await makeClockStore("2026-11-11T10:00:00.000Z");
		const course = await store.createCourse({ title: "Python 编程" });
		await store.reserveLearningStart({ courseId: course.course_id, requestId: "learn_live" });
		await store.attachLearningStartSession("learn_live", "session_live.jsonl");
		await store.archiveCourse(course.course_id);

		advance("2026-11-12T10:00:00.000Z");
		await expectBlocked(store.deleteCourse(course.course_id), ["pending_learning_start"]);
	});

	it("freezes learning progress in an archived course but still allows planning and cleanup", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const { plan, tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "启用计划",
			status: "active",
			stages: [{ title: "基础", tasks: [{ title: "阅读教材" }] }],
		});
		const draft = await store.createPlan(course.course_id, { title: "草稿计划", status: "draft" });
		await store.archiveCourse(course.course_id);

		await expect(store.reserveLearningStart({ courseId: course.course_id, requestId: "req_r1" }))
			.rejects.toMatchObject({ code: "COURSE_ARCHIVED" });
		await expect(store.bindSession({ courseId: course.course_id, sessionId: "session_x.jsonl" }))
			.rejects.toMatchObject({ code: "COURSE_ARCHIVED" });
		await expect(store.updateTask(course.course_id, tasks[0].task_id, { status: "in_progress" }))
			.rejects.toMatchObject({ code: "COURSE_ARCHIVED" });
		await expect(store.confirmPlan(course.course_id, draft.plan_id, { expectedRevision: draft.revision }))
			.rejects.toMatchObject({ code: "COURSE_ARCHIVED" });

		// Read-only history stays available, and cleanup is still possible.
		expect(await store.listTasks(course.course_id)).toHaveLength(1);
		expect((await store.getPlan(course.course_id, plan.plan_id))?.status).toBe("active");
		expect((await store.archivePlan(course.course_id, draft.plan_id)).status).toBe("archived");
		await expect(store.deletePlan(course.course_id, draft.plan_id)).resolves.toMatchObject({ plan_id: draft.plan_id });

		// Restoring is a formal step (archived → paused), and resuming is a second
		// explicit one (paused → in_progress); only then are the writes open again.
		await store.restoreCourse(course.course_id);
		await store.resumeCourse(course.course_id);
		await expect(store.reserveLearningStart({ courseId: course.course_id, requestId: "req_after_restore" }))
			.resolves.toMatchObject({ created: true });
	});
});

describe("E4.7-R1 final — resuming a paused course", () => {
	it("moves paused to in_progress and creates no session, binding or record", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.updateCourse(course.course_id, { status: "paused" });

		const resumed = await store.resumeCourse(course.course_id);
		expect(resumed.status).toBe("in_progress");

		const state = await store.readState();
		expect(state.session_bindings).toEqual([]);
		expect(state.learning_starts).toEqual([]);
		// 继续课程 must not start studying: the task is untouched.
		expect(await store.listTasks(course.course_id)).toEqual([]);
		// Idempotent, and still no side effects.
		expect((await store.resumeCourse(course.course_id)).status).toBe("in_progress");
	});

	it("refuses to resume an archived course and points at restore", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.archiveCourse(course.course_id);

		await expect(store.resumeCourse(course.course_id)).rejects.toMatchObject({
			code: "COURSE_ARCHIVED",
		});
		expect((await store.getCourse(course.course_id))?.status).toBe("archived");
	});

	it("refuses a generic status patch that would leave the archive", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.archiveCourse(course.course_id);
		const before = await revisionOf(store["dataDir"] as unknown as string).catch(() => null);

		// PATCH must not become a back door around POST /restore.
		await expect(store.updateCourse(course.course_id, { status: "in_progress" }))
			.rejects.toMatchObject({ code: "COURSE_ARCHIVED" });
		await expect(store.updateCourse(course.course_id, { status: "paused" }))
			.rejects.toMatchObject({ code: "COURSE_ARCHIVED" });
		expect((await store.getCourse(course.course_id))?.status).toBe("archived");
		expect(before === null || typeof before === "number").toBe(true);

		// The formal restore is still the one way out, and lands on paused.
		expect((await store.restoreCourse(course.course_id)).status).toBe("paused");
	});
});

describe("E4.7-R2a — blocking session details", () => {
	it("lists pending-task and course-level sessions that started_task_details misses", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const { tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "启用计划",
			status: "active",
			stages: [{ title: "基础", tasks: [{ title: "还没有开始的任务" }] }],
		});
		// The task is still pending, but it already owns a conversation.
		await store.bindSession({
			courseId: course.course_id,
			sessionId: "session_pending.jsonl",
			taskId: tasks[0].task_id,
			origin: "task",
		});
		// A course-level conversation with no task at all.
		await store.bindSession({
			courseId: course.course_id,
			sessionId: "session_free.jsonl",
			origin: "manual",
		});

		await store.archiveCourse(course.course_id);
		const report = await store.inspectCourseDeletion(course.course_id);

		// E4.8d: an archived course with conversations is deletable; the sessions
		// are listed as the risk the confirmation must state.
		expect(report.deletable).toBe(true);
		expect(report.blockers).toEqual([]);
		// No task has started, so the task list cannot explain the refusal.
		expect(report.started_task_details).toEqual([]);
		expect(report.session_details).toHaveLength(2);
		const bySession = new Map(report.session_details.map((detail) => [detail.session_id, detail]));
		expect(bySession.get("session_pending.jsonl")).toMatchObject({
			task_id: tasks[0].task_id,
			task_title: "还没有开始的任务",
			task_status: "pending",
			plan_title: "启用计划",
			stage_title: "基础",
			// Resolved by the route from the two other owners.
			archived: null,
			b2_evidence_count: null,
		});
		expect(bySession.get("session_free.jsonl")).toMatchObject({
			task_id: null,
			task_title: null,
			task_status: null,
		});
	});
});
