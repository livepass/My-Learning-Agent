import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore } from "./course-store.js";

/**
 * E4.4-R1 — one learning task owns at most one default session.
 *
 * The invariant is enforced inside the store's write transaction, because a
 * caller-side check cannot survive two processes (or a retry after a lost
 * response). Legacy duplicates are reported and preserved, never repaired by
 * deleting a conversation.
 */

const roots: string[] = [];

async function makeStore(): Promise<{ store: CourseStore; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-courses-binding-"));
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

async function seed(store: CourseStore) {
	const course = await store.createCourse({ title: "Python 编程" });
	const other = await store.createCourse({ title: "高等数学" });
	const { plan, tasks } = await store.createPlanWithStructure(course.course_id, {
		title: "Python 计划",
		status: "active",
		stages: [{ title: "基础", tasks: [{ title: "阅读装饰器教材" }] }],
	});
	return { course, other, plan, task: tasks[0] };
}

describe("task session uniqueness", () => {
	it("rejects a second session for the same task without writing anything", async () => {
		const { store, dataDir } = await makeStore();
		const { course, task } = await seed(store);
		await store.bindSession({ courseId: course.course_id, sessionId: "session_a.jsonl", taskId: task.task_id, origin: "task" });
		const before = await revisionOf(dataDir);

		await expect(store.bindSession({
			courseId: course.course_id, sessionId: "session_b.jsonl", taskId: task.task_id, origin: "task",
		})).rejects.toMatchObject({ code: "COURSE_SESSION_CONFLICT" });
		expect(await revisionOf(dataDir)).toBe(before);
		expect((await store.listSessionBindings(course.course_id)).map((binding) => binding.session_id))
			.toEqual(["session_a.jsonl"]);
	});

	it("keeps a repeated bind of the same session idempotent", async () => {
		const { store } = await makeStore();
		const { course, task } = await seed(store);
		const first = await store.bindSession({ courseId: course.course_id, sessionId: "session_a.jsonl", taskId: task.task_id, origin: "task" });
		const second = await store.bindSession({ courseId: course.course_id, sessionId: "session_a.jsonl", taskId: task.task_id, origin: "task" });
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(await store.listSessionBindings(course.course_id)).toHaveLength(1);
	});

	it("refuses to adopt a task that another session already owns", async () => {
		const { store } = await makeStore();
		const { course, task } = await seed(store);
		await store.bindSession({ courseId: course.course_id, sessionId: "session_a.jsonl", taskId: task.task_id, origin: "task" });
		await store.bindSession({ courseId: course.course_id, sessionId: "session_free.jsonl", origin: "free_question" });
		await expect(store.bindSession({
			courseId: course.course_id, sessionId: "session_free.jsonl", taskId: task.task_id, origin: "task",
		})).rejects.toMatchObject({ code: "COURSE_SESSION_CONFLICT" });
		const bindings = await store.listSessionBindings(course.course_id);
		expect(bindings.find((binding) => binding.session_id === "session_free.jsonl")?.task_id).toBeNull();
	});

	it("lets exactly one of two concurrent binds win", async () => {
		const { store } = await makeStore();
		const { course, task } = await seed(store);
		const results = await Promise.allSettled([
			store.bindSession({ courseId: course.course_id, sessionId: "session_a.jsonl", taskId: task.task_id, origin: "task" }),
			store.bindSession({ courseId: course.course_id, sessionId: "session_b.jsonl", taskId: task.task_id, origin: "task" }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(rejected?.reason).toMatchObject({ code: "COURSE_SESSION_CONFLICT" });
		expect(await store.listSessionBindings(course.course_id)).toHaveLength(1);
	});

	it("still allows another course to bind its own session to its own task", async () => {
		const { store } = await makeStore();
		const { course, other, task } = await seed(store);
		await store.bindSession({ courseId: course.course_id, sessionId: "python.jsonl", taskId: task.task_id, origin: "task" });
		const otherTask = (await store.createPlanWithStructure(other.course_id, {
			title: "高数计划",
			status: "active",
			stages: [{ title: "基础", tasks: [{ title: "阅读导数教材" }] }],
		})).tasks[0];
		const bound = await store.bindSession({
			courseId: other.course_id, sessionId: "math.jsonl", taskId: otherTask.task_id, origin: "task",
		});
		expect(bound.created).toBe(true);
	});
});

describe("E4.6-R1: an unconfirmed plan owns no learning session", () => {
	async function seedDraft() {
		const { store, dataDir } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const draft = await store.createPlanWithStructure(course.course_id, {
			title: "AI 草稿",
			origin: "agent_suggested",
			status: "draft",
			stages: [{ title: "基础", tasks: [{ title: "阅读装饰器教材" }] }],
		});
		const loose = await store.createTask(course.course_id, { title: "自由任务" });
		return { store, dataDir, course, plan: draft.plan, task: draft.tasks[0], loose };
	}

	it("refuses to bind a session to a draft plan's task and writes nothing", async () => {
		const { store, dataDir, course, plan, task } = await seedDraft();
		expect((await store.getPlan(course.course_id, plan.plan_id))?.status).toBe("draft");
		const before = await revisionOf(dataDir);

		await expect(store.bindSession({
			courseId: course.course_id, sessionId: "session_draft.jsonl", taskId: task.task_id, origin: "task",
		})).rejects.toMatchObject({ code: "COURSE_CONFLICT" });

		expect(await revisionOf(dataDir)).toBe(before);
		expect(await store.listSessionBindings(course.course_id)).toEqual([]);
	});

	it("refuses to let a free session adopt a draft plan's task", async () => {
		const { store, course, task } = await seedDraft();
		await store.bindSession({ courseId: course.course_id, sessionId: "free.jsonl", origin: "free_question" });

		await expect(store.bindSession({
			courseId: course.course_id, sessionId: "free.jsonl", taskId: task.task_id, origin: "task",
		})).rejects.toMatchObject({ code: "COURSE_CONFLICT" });

		expect((await store.getSessionBinding("free.jsonl"))?.task_id).toBeNull();
	});

	it("binds the same task once its plan is confirmed, and keeps the record when archived", async () => {
		const { store, course, plan, task } = await seedDraft();
		const confirmed = await store.confirmPlan(course.course_id, plan.plan_id, { expectedRevision: 1 });
		expect(confirmed.plan.status).toBe("active");
		// Confirming a plan creates no session and no task progress by itself.
		expect(await store.listSessionBindings(course.course_id)).toEqual([]);
		expect((await store.getTask(course.course_id, task.task_id))?.status).toBe("pending");

		const bound = await store.bindSession({
			courseId: course.course_id, sessionId: "session_real.jsonl", taskId: task.task_id, origin: "task",
		});
		expect(bound.created).toBe(true);

		// Archiving the plan is not a delete: the binding and its task stay.
		await store.updatePlan(course.course_id, plan.plan_id, { status: "archived" });
		expect((await store.listSessionBindings(course.course_id)).map((binding) => binding.session_id))
			.toEqual(["session_real.jsonl"]);
		expect(await store.getTask(course.course_id, task.task_id)).toBeDefined();
	});

	it("still binds a plan-less task (free learning) without a plan check", async () => {
		const { store, course, loose } = await seedDraft();
		const bound = await store.bindSession({
			courseId: course.course_id, sessionId: "session_free_task.jsonl", taskId: loose.task_id, origin: "task",
		});
		expect(bound.created).toBe(true);
	});
});

describe("legacy duplicate task sessions", () => {
	async function writeLegacyStore(): Promise<{ store: CourseStore; dataDir: string }> {
		const { store, dataDir } = await makeStore();
		await mkdir(join(dataDir, "courses"), { recursive: true });
		await writeFile(join(dataDir, "courses", "state.json"), JSON.stringify({
			schema_version: 1,
			revision: 7,
			courses: [{
				course_id: "course_python", title: "Python 编程", description: "", status: "in_progress",
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			goal_bindings: [],
			plans: [{
				plan_id: "plan_python", course_id: "course_python", title: "计划", description: "",
				goal_id: null, status: "active", origin: "user", revision: 1,
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			stages: [],
			tasks: [{
				task_id: "task_decorator", course_id: "course_python", plan_id: "plan_python", stage_id: null,
				title: "阅读装饰器教材", order: 0, estimated_minutes: null, difficulty: "standard",
				concept_ids: [], source_ids: [], status: "in_progress",
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			session_bindings: [
				{
					binding_id: "binding_old", course_id: "course_python", session_id: "session_old.jsonl",
					task_id: "task_decorator", origin: "task", created_at: "2026-11-01T00:00:00.000Z",
				},
				{
					binding_id: "binding_new", course_id: "course_python", session_id: "session_new.jsonl",
					task_id: "task_decorator", origin: "task", created_at: "2026-11-02T00:00:00.000Z",
				},
			],
			source_bindings: [],
			study_settings: [],
			learning_starts: [],
		}, null, 2), "utf-8");
		return { store, dataDir };
	}

	it("reports duplicates oldest-first and preserves both bindings", async () => {
		const { store } = await writeLegacyStore();
		const duplicates = await store.listDuplicateTaskBindings("course_python");
		expect(duplicates).toEqual([{
			task_id: "task_decorator",
			session_ids: ["session_old.jsonl", "session_new.jsonl"],
		}]);
		// Reading does not repair: both records are still there.
		expect(await store.listSessionBindings("course_python")).toHaveLength(2);
	});

	it("refuses a third session while legacy duplicates exist", async () => {
		const { store, dataDir } = await writeLegacyStore();
		const before = await revisionOf(dataDir);
		await expect(store.bindSession({
			courseId: "course_python", sessionId: "session_third.jsonl", taskId: "task_decorator", origin: "task",
		})).rejects.toMatchObject({ code: "COURSE_SESSION_CONFLICT" });
		expect(await revisionOf(dataDir)).toBe(before);
		expect(await store.listSessionBindings("course_python")).toHaveLength(2);
	});

	it("removes only the deleted session's binding and leaves the other intact", async () => {
		const { store } = await writeLegacyStore();
		expect(await store.removeSessionBinding("session_old.jsonl")).toBe(true);
		const remaining = await store.listSessionBindings("course_python");
		expect(remaining.map((binding) => binding.session_id)).toEqual(["session_new.jsonl"]);
		expect(await store.listDuplicateTaskBindings("course_python")).toEqual([]);
	});
});
