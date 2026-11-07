import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore, CourseStoreError } from "./course-store.js";
import {
	assertClientCourseIntent,
	checkConceptScope,
	CourseContextError,
	resolveCourseContext,
	retrievalSourceScope,
} from "./course-context.js";

/**
 * E4.1a — one server-side resolution of "which course is this session in?".
 *
 * The tests pin the properties the four memory layers rely on: the persisted
 * binding is the only authority, an unbound session is never guessed into a
 * course, an empty course scope is not "no scope", and a client's claimed
 * course can never override the binding.
 */

const roots: string[] = [];

async function makeStore(): Promise<{ store: CourseStore; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-course-context-"));
	roots.push(root);
	const dataDir = join(root, "data");
	return { store: new CourseStore({ dataDir }), dataDir };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SESSION = "2026-11-07T00-00-00-000Z_01a1ab90-778c-705f-9f0a-1e7a7e0b3260.jsonl";

describe("resolveCourseContext", () => {
	it("reports a session without a binding as unclassified and never guesses", async () => {
		const { store } = await makeStore();
		expect(await resolveCourseContext(store, SESSION)).toEqual({ status: "unclassified", sessionId: SESSION });
		// No course store (route tests, pre-E4.1 deployment) behaves the same.
		expect(await resolveCourseContext(undefined, SESSION)).toEqual({ status: "unclassified", sessionId: SESSION });
	});

	it("resolves course, task, active sources and goals from one persisted binding", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const goal = await store.bindGoal(course.course_id, "goal_python");
		const plan = await store.createPlan(course.course_id, { title: "基础阶段", goalId: goal.binding.goal_id });
		const task = await store.createTask(course.course_id, { title: "理解装饰器", planId: plan.plan_id });
		await store.bindSource(course.course_id, "l2src_python");
		await store.bindSession({
			courseId: course.course_id,
			sessionId: SESSION,
			taskId: task.task_id,
			origin: "task",
		});

		const context = await resolveCourseContext(store, SESSION);
		expect(context).toMatchObject({
			status: "course",
			sessionId: SESSION,
			courseId: course.course_id,
			courseTitle: "Python 编程",
			taskId: task.task_id,
			sourceIds: ["l2src_python"],
			goalIds: ["goal_python"],
		});
		expect(retrievalSourceScope(context)).toEqual(["l2src_python"]);
	});

	it("keeps an empty course scope empty instead of widening to the whole knowledge base", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "高等数学" });
		await store.bindSession({ courseId: course.course_id, sessionId: SESSION });

		const context = await resolveCourseContext(store, SESSION);
		expect(context.status).toBe("course");
		// [] is authoritative: a course with no material retrieves nothing.
		expect(retrievalSourceScope(context)).toEqual([]);
	});

	it("keeps a legacy unclassified session on the global scope", async () => {
		const { store } = await makeStore();
		const context = await resolveCourseContext(store, SESSION);
		expect(retrievalSourceScope(context)).toBeUndefined();
	});

	it("treats a binding whose course vanished as a conflict, not as unclassified", async () => {
		const { store, dataDir } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindSession({ courseId: course.course_id, sessionId: SESSION });
		// Simulate a torn/edited state file: the binding survives, the course does not.
		const file = join(dataDir, "courses", "state.json");
		const state = JSON.parse(await readFile(file, "utf-8"));
		state.courses = [];
		await writeFile(file, JSON.stringify(state), "utf-8");

		await expect(resolveCourseContext(store, SESSION)).rejects.toBeInstanceOf(CourseStoreError);
		await expect(resolveCourseContext(store, SESSION)).rejects.toMatchObject({ code: "COURSE_CONFLICT" });
	});

	it("rejects an unsafe session id instead of reading an arbitrary key", async () => {
		const { store } = await makeStore();
		await expect(resolveCourseContext(store, "../escape")).rejects.toBeInstanceOf(CourseContextError);
		await expect(resolveCourseContext(store, "../escape")).rejects.toMatchObject({ code: "course_context_invalid" });
	});
});

describe("assertClientCourseIntent", () => {
	it("accepts no claim and a claim that matches the binding", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindSession({ courseId: course.course_id, sessionId: SESSION });
		const context = await resolveCourseContext(store, SESSION);

		expect(() => assertClientCourseIntent(context, undefined)).not.toThrow();
		expect(() => assertClientCourseIntent(context, course.course_id)).not.toThrow();
	});

	it("refuses a different course without moving the session", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		await store.bindSession({ courseId: python.course_id, sessionId: SESSION });
		const context = await resolveCourseContext(store, SESSION);

		expect(() => assertClientCourseIntent(context, math.course_id)).toThrow(CourseContextError);
		expect(() => assertClientCourseIntent(context, math.course_id)).toThrow(/另一门课程/);
		// The binding is unchanged by the refused intent.
		expect((await store.getSessionBinding(SESSION))?.course_id).toBe(python.course_id);
	});

	it("refuses a claimed course for an unbound session", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const context = await resolveCourseContext(store, SESSION);
		expect(() => assertClientCourseIntent(context, course.course_id)).toThrow(/尚未归属/);
	});

	it("rejects a malformed course id", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindSession({ courseId: course.course_id, sessionId: SESSION });
		const context = await resolveCourseContext(store, SESSION);
		expect(() => assertClientCourseIntent(context, "../escape")).toThrow(/不合法/);
	});
});

describe("checkConceptScope", () => {
	it("allows the owning course and a legacy unclassified concept", () => {
		const states = [
			{ concept_id: "concept_math", course_id: "course_math" },
			{ concept_id: "concept_legacy" },
		];
		expect(checkConceptScope(states, "concept_math", "course_math")).toEqual({ ok: true });
		// Legacy states have no course and are never retroactively adopted.
		expect(checkConceptScope(states, "concept_legacy", "course_python")).toEqual({ ok: true });
		// An id we have no evidence for carries no other course's data yet.
		expect(checkConceptScope(states, "concept_new", "course_python")).toEqual({ ok: true });
	});

	it("refuses another course's concept", () => {
		const states = [{ concept_id: "concept_math", course_id: "course_math" }];
		expect(checkConceptScope(states, "concept_math", "course_python")).toEqual({
			ok: false,
			conceptCourseId: "course_math",
		});
	});
});
