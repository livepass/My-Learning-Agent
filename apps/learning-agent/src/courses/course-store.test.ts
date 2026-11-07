import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore, CourseStoreError } from "./course-store.js";

/**
 * E4.1 course store contracts.
 *
 * These pin the invariants the routes rely on: one file owns every relation,
 * ids are generated server-side, bindings are idempotent and immutable where
 * re-association would rewrite history, and a legacy/absent file is an empty
 * state rather than an error.
 */

const roots: string[] = [];

async function makeStore(): Promise<{ store: CourseStore; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-courses-"));
	roots.push(root);
	const dataDir = join(root, "data");
	const store = new CourseStore({ dataDir });
	return { store, dataDir };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(CourseStoreError);
	await expect(promise).rejects.toMatchObject({ code });
}

describe("course entity", () => {
	it("creates, reads, updates and archives a course with server-owned timestamps", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程", description: "从语法到项目" });
		expect(course.course_id).toMatch(/^course_[0-9a-f]{8}$/);
		expect(course.status).toBe("in_progress");
		expect(course.created_at).toBe(course.updated_at);
		expect(await store.getCourse(course.course_id)).toEqual(course);
		expect(await store.listCourses()).toEqual([course]);

		const updated = await store.updateCourse(course.course_id, { title: "Python 编程入门", status: "paused" });
		expect(updated.title).toBe("Python 编程入门");
		expect(updated.status).toBe("paused");
		expect(updated.created_at).toBe(course.created_at);

		const archived = await store.archiveCourse(course.course_id);
		expect(archived.status).toBe("archived");
		// Archiving keeps the record readable; nothing is deleted.
		expect(await store.getCourse(course.course_id)).toMatchObject({ title: "Python 编程入门", status: "archived" });
	});

	it("rejects an empty title, an over-long title and an unknown status", async () => {
		const { store } = await makeStore();
		await expectCode(store.createCourse({ title: "   " }), "COURSE_INVALID");
		await expectCode(store.createCourse({ title: "x".repeat(121) }), "COURSE_INVALID");
		await expectCode(
			store.createCourse({ title: "ok", status: "deleted" as never }),
			"COURSE_INVALID",
		);
	});

	it("reports an unknown course as COURSE_NOT_FOUND and refuses an unsafe id", async () => {
		const { store } = await makeStore();
		await expectCode(store.updateCourse("course_missing", { title: "x" }), "COURSE_NOT_FOUND");
		await expectCode(store.updateCourse("../escape", { title: "x" }), "COURSE_INVALID");
		expect(await store.getCourse("../escape")).toBeUndefined();
	});
});

describe("legacy data", () => {
	it("treats a missing state file as an empty course list, not an error", async () => {
		const { store } = await makeStore();
		expect(await store.listCourses()).toEqual([]);
		expect(await store.readState()).toMatchObject({ schema_version: 1, revision: 0, courses: [] });
	});

	it("refuses to treat a corrupt file as empty (that would erase courses on the next write)", async () => {
		const { store, dataDir } = await makeStore();
		await store.createCourse({ title: "高等数学" });
		const file = join(dataDir, "courses", "state.json");
		await writeFile(file, "{not-json", "utf-8");
		await expectCode(store.listCourses(), "COURSE_CORRUPT");
		await expectCode(store.createCourse({ title: "另一门" }), "COURSE_CORRUPT");
	});

	it("refuses a structurally unsupported state file", async () => {
		const { store, dataDir } = await makeStore();
		const file = join(dataDir, "courses", "state.json");
		await store.createCourse({ title: "临时" });
		await writeFile(file, JSON.stringify({ schema_version: 2, courses: [] }), "utf-8");
		await expectCode(store.listCourses(), "COURSE_CORRUPT");
	});

	it("reads records written before optional fields existed", async () => {
		const { store, dataDir } = await makeStore();
		const file = join(dataDir, "courses", "state.json");
		await mkdir(join(dataDir, "courses"), { recursive: true });
		// A future/older writer may omit description, plan_id, task_id and lists.
		await writeFile(file, JSON.stringify({
			schema_version: 1,
			revision: 3,
			courses: [{ course_id: "course_legacy01", title: "旧课程", status: "in_progress", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
			goal_bindings: [],
			plans: [{ plan_id: "plan_legacy01", course_id: "course_legacy01", title: "旧计划", status: "active", origin: "user", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
			tasks: [{ task_id: "task_legacy01", course_id: "course_legacy01", title: "旧任务", status: "pending", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
			session_bindings: [],
			// E4.1a added `status` / `updated_at` to source bindings. A pre-E4.1a
			// record had neither; it was an active association by construction.
			source_bindings: [{
				binding_id: "binding_legacy01",
				course_id: "course_legacy01",
				source_id: "l2src_legacy",
				created_at: "2026-01-01T00:00:00.000Z",
			}],
		}), "utf-8");
		const course = await store.getCourse("course_legacy01");
		expect(course?.description).toBe("");
		const [plan] = await store.listPlans("course_legacy01");
		expect(plan.description).toBe("");
		expect(plan.goal_id).toBeNull();
		const [task] = await store.listTasks("course_legacy01");
		expect(task.plan_id).toBeNull();
		expect(task.concept_ids).toEqual([]);
		expect(task.source_ids).toEqual([]);
		const [source] = await store.listSourceBindings("course_legacy01");
		expect(source).toMatchObject({
			binding_id: "binding_legacy01",
			status: "active",
			updated_at: "2026-01-01T00:00:00.000Z",
		});
	});
});

describe("bindings", () => {
	it("binds goals idempotently and keeps two courses able to share one goal", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		const first = await store.bindGoal(python.course_id, "goal_shared");
		const retry = await store.bindGoal(python.course_id, "goal_shared");
		expect(retry.created).toBe(false);
		expect(retry.binding.binding_id).toBe(first.binding.binding_id);
		const shared = await store.bindGoal(math.course_id, "goal_shared");
		expect(shared.created).toBe(true);
		expect(await store.counts(python.course_id)).toMatchObject({ goals: 1 });
		expect(await store.counts(math.course_id)).toMatchObject({ goals: 1 });
		expect(await store.unbindGoal(python.course_id, "goal_shared")).toBe(true);
		expect(await store.unbindGoal(python.course_id, "goal_shared")).toBe(false);
	});

	it("refuses a binding to a course that does not exist", async () => {
		const { store } = await makeStore();
		await expectCode(store.bindGoal("course_missing", "goal_1"), "COURSE_NOT_FOUND");
	});

	it("binds a session once and never moves it to another course", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		const first = await store.bindSession({ courseId: python.course_id, sessionId: "session-1.jsonl", origin: "free_question" });
		expect(first.created).toBe(true);
		const retry = await store.bindSession({ courseId: python.course_id, sessionId: "session-1.jsonl", origin: "free_question" });
		expect(retry.created).toBe(false);
		expect(retry.binding.binding_id).toBe(first.binding.binding_id);
		await expectCode(
			store.bindSession({ courseId: math.course_id, sessionId: "session-1.jsonl" }),
			"COURSE_SESSION_CONFLICT",
		);
		expect((await store.getSessionBinding("session-1.jsonl"))?.course_id).toBe(python.course_id);
	});

	it("lets a task adopt a session that had none, but never replace an existing task", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const taskA = await store.createTask(course.course_id, { title: "任务 A" });
		const taskB = await store.createTask(course.course_id, { title: "任务 B" });
		await store.bindSession({ courseId: course.course_id, sessionId: "s.jsonl" });
		const adopted = await store.bindSession({ courseId: course.course_id, sessionId: "s.jsonl", taskId: taskA.task_id });
		expect(adopted.binding.task_id).toBe(taskA.task_id);
		await expectCode(
			store.bindSession({ courseId: course.course_id, sessionId: "s.jsonl", taskId: taskB.task_id }),
			"COURSE_SESSION_CONFLICT",
		);
	});

	it("refuses a task id that belongs to another course", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		const task = await store.createTask(math.course_id, { title: "极限" });
		await expectCode(
			store.bindSession({ courseId: python.course_id, sessionId: "s.jsonl", taskId: task.task_id }),
			"COURSE_CONFLICT",
		);
	});

	it("drops a binding only when the session itself is gone", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindSession({ courseId: course.course_id, sessionId: "gone.jsonl" });
		await store.bindSession({ courseId: course.course_id, sessionId: "kept.jsonl" });
		expect(await store.removeSessionBinding("gone.jsonl")).toBe(true);
		expect(await store.removeSessionBinding("gone.jsonl")).toBe(false);
		expect(await store.removeSessionBinding("never-bound.jsonl")).toBe(false);
		expect((await store.listSessionBindings(course.course_id)).map((binding) => binding.session_id)).toEqual(["kept.jsonl"]);
		expect(await store.counts(course.course_id)).toMatchObject({ sessions: 1 });
	});

	it("binds the same L2 source to two courses with one explicit record each", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		const a = await store.bindSource(python.course_id, "l2src_shared");
		const b = await store.bindSource(math.course_id, "l2src_shared");
		expect(a.created).toBe(true);
		expect(b.created).toBe(true);
		expect((await store.bindSource(python.course_id, "l2src_shared")).created).toBe(false);
		expect((await store.listSourceBindings(python.course_id)).map((entry) => entry.source_id)).toEqual(["l2src_shared"]);
		expect((await store.listSourceBindings(math.course_id)).map((entry) => entry.source_id)).toEqual(["l2src_shared"]);
	});

	it("detaches a source as a status change and reactivates the same binding", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const first = await store.bindSource(course.course_id, "l2src_book");
		expect(first.binding.status).toBe("active");

		expect(await store.unbindSource(course.course_id, "l2src_book")).toBe(true);
		// A repeated detach is a no-op, not a second state transition.
		expect(await store.unbindSource(course.course_id, "l2src_book")).toBe(false);

		// Hidden from the active scope, but still readable as history.
		expect(await store.listSourceBindings(course.course_id)).toEqual([]);
		const [detached] = await store.listSourceBindings(course.course_id, { includeDetached: true });
		expect(detached).toMatchObject({ binding_id: first.binding.binding_id, status: "detached" });
		expect(detached.detached_at).toBeTruthy();
		expect(await store.counts(course.course_id)).toMatchObject({ sources: 0 });

		const again = await store.bindSource(course.course_id, "l2src_book");
		expect(again.created).toBe(false);
		expect(again.binding.binding_id).toBe(first.binding.binding_id);
		expect(again.binding.status).toBe("active");
		expect(again.binding.detached_at).toBeUndefined();
	});

	it("resolves a session context from one snapshot with active sources only", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindGoal(course.course_id, "goal_python");
		await store.bindSource(course.course_id, "l2src_active");
		await store.bindSource(course.course_id, "l2src_detached");
		await store.unbindSource(course.course_id, "l2src_detached");
		const task = await store.createTask(course.course_id, { title: "装饰器" });
		await store.bindSession({ courseId: course.course_id, sessionId: "s.jsonl", taskId: task.task_id });

		const context = await store.getSessionContext("s.jsonl");
		expect(context).toMatchObject({
			course: { course_id: course.course_id },
			task: { task_id: task.task_id },
			sourceIds: ["l2src_active"],
			goalIds: ["goal_python"],
		});
		// An unbound session stays undefined: no course is invented.
		expect(await store.getSessionContext("other.jsonl")).toBeUndefined();
	});
});

describe("plans and tasks", () => {
	it("forces an agent-suggested plan to draft until the learner confirms it", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const suggested = await store.createPlan(course.course_id, { title: "四周入门", origin: "agent_suggested" });
		expect(suggested.status).toBe("draft");
		// Even an explicit active status cannot skip the confirmation step.
		const escalated = await store.createPlan(course.course_id, { title: "两周冲刺", origin: "agent_suggested", status: "active" });
		expect(escalated.status).toBe("draft");
		const confirmed = await store.updatePlan(course.course_id, suggested.plan_id, { status: "active" });
		expect(confirmed.status).toBe("active");
		const manual = await store.createPlan(course.course_id, { title: "自建计划" });
		expect(manual.status).toBe("active");
		expect(manual.origin).toBe("user");
	});

	it("refuses a task whose plan belongs to another course", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		const plan = await store.createPlan(math.course_id, { title: "数学计划" });
		await expectCode(
			store.createTask(python.course_id, { title: "错位任务", planId: plan.plan_id }),
			"COURSE_CONFLICT",
		);
	});

	it("keeps task fields the caller did not change and normalizes id lists", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const task = await store.createTask(course.course_id, {
			title: "闭包",
			conceptIds: ["concept_a", "concept_a", "concept_b"],
			sourceIds: ["l2src_1"],
		});
		expect(task.concept_ids).toEqual(["concept_a", "concept_b"]);
		expect(task.status).toBe("pending");
		const updated = await store.updateTask(course.course_id, task.task_id, { status: "in_progress" });
		expect(updated.status).toBe("in_progress");
		expect(updated.title).toBe("闭包");
		expect(updated.source_ids).toEqual(["l2src_1"]);
		expect(updated.updated_at).not.toBe(task.updated_at);
	});

	it("rejects unsafe ids inside a task's lists", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await expectCode(
			store.createTask(course.course_id, { title: "坏任务", conceptIds: ["../etc"] }),
			"COURSE_INVALID",
		);
	});
});

describe("persistence", () => {
	it("survives a fresh store instance (restart) and keeps one revision counter", async () => {
		const { store, dataDir } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.createTask(course.course_id, { title: "变量" });
		const reopened = new CourseStore({ dataDir });
		expect((await reopened.listCourses()).map((entry) => entry.title)).toEqual(["Python 编程"]);
		expect(await reopened.listTasks(course.course_id)).toHaveLength(1);
		const state = JSON.parse(await readFile(join(dataDir, "courses", "state.json"), "utf-8")) as { revision: number };
		expect(state.revision).toBe(2);
	});

	it("serializes concurrent mutations in one process", async () => {
		const { store } = await makeStore();
		await Promise.all(Array.from({ length: 12 }, (_, index) => store.createCourse({ title: `课程 ${index}` })));
		expect(await store.listCourses()).toHaveLength(12);
	});

	it("returns one consistent snapshot whose counts match its lists", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		await store.bindGoal(python.course_id, "goal_1");
		await store.createPlan(python.course_id, { title: "入门" });
		await store.createTask(python.course_id, { title: "变量" });
		await store.bindSession({ courseId: python.course_id, sessionId: "s.jsonl" });
		await store.bindSource(python.course_id, "l2src_1");
		await store.createTask(math.course_id, { title: "极限" });

		const snapshot = await store.snapshot(python.course_id);
		expect(snapshot?.course.title).toBe("Python 编程");
		expect(snapshot?.counts).toEqual({
			goals: snapshot?.goals.length,
			plans: snapshot?.plans.length,
			tasks: snapshot?.tasks.length,
			sessions: snapshot?.sessions.length,
			sources: snapshot?.sources.length,
		});
		expect(snapshot?.tasks.map((task) => task.title)).toEqual(["变量"]);
		expect(await store.snapshot("course_missing")).toBeUndefined();
	});
});
