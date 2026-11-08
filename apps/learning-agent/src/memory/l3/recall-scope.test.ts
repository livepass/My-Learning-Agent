import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore, CourseStoreError } from "../../courses/course-store.js";
import { recallOptionsForScope, resolveRecallScope } from "./recall-scope.js";

/**
 * E4.4b scope contract: the allowed session set comes from persisted course
 * bindings, an empty course is a real empty scope, and an unreadable store
 * fails closed instead of widening to global history.
 */

const roots: string[] = [];

async function makeStore(): Promise<CourseStore> {
	const root = await mkdtemp(join(tmpdir(), "inno-l3-scope-"));
	roots.push(root);
	return new CourseStore({ dataDir: join(root, "data") });
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("course recall scope", () => {
	it("restricts recall to the sessions of the bound course", async () => {
		const store = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		await store.bindSession({ courseId: python.course_id, sessionId: "python_a.jsonl", origin: "manual" });
		await store.bindSession({ courseId: python.course_id, sessionId: "python_b.jsonl", origin: "task", taskId: null });
		await store.bindSession({ courseId: math.course_id, sessionId: "math_a.jsonl", origin: "task", taskId: null });

		const scope = await resolveRecallScope(store, "python_a.jsonl");
		expect(scope.status).toBe("course");
		if (scope.status !== "course") throw new Error("expected course scope");
		expect([...scope.allowedSessionIds].sort()).toEqual(["python_a.jsonl", "python_b.jsonl"]);
		expect(scope.allowedSessionIds.has("math_a.jsonl")).toBe(false);
		expect(recallOptionsForScope(scope)).toEqual({ allowedSessionIds: scope.allowedSessionIds });
	});

	it("keeps a course with only its own session as a real, non-global scope", async () => {
		const store = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		await store.bindSession({ courseId: python.course_id, sessionId: "only.jsonl", origin: "task", taskId: null });
		const scope = await resolveRecallScope(store, "only.jsonl");
		expect(scope.status).toBe("course");
		if (scope.status !== "course") throw new Error("expected course scope");
		// Not `undefined`: undefined would mean "legacy global". An empty set
		// would be equally wrong here — the session itself is in the course.
		expect(scope.allowedSessionIds.size).toBe(1);
	});

	it("treats an unbound session as legacy global", async () => {
		const store = await makeStore();
		const scope = await resolveRecallScope(store, "legacy.jsonl");
		expect(scope).toEqual({ status: "unclassified" });
		expect(recallOptionsForScope(scope)).toEqual({});
	});

	it("has no scope to resolve without a session id", async () => {
		expect(await resolveRecallScope(undefined, "anything.jsonl")).toEqual({ status: "unclassified" });
		// E4.4-R1: without a usable identity we cannot prove the conversation is
		// legacy, so retrieval stops instead of falling back to global history.
		expect(await resolveRecallScope(await makeStore(), undefined)).toEqual({
			status: "unavailable",
			reason: "missing_session_id",
		});
		expect(await resolveRecallScope(await makeStore(), "../escape.jsonl")).toEqual({
			status: "unavailable",
			reason: "invalid_session_id",
		});
	});

	it("fails closed when the course store cannot be read", async () => {
		const broken = {
			getSessionContext: async () => { throw new CourseStoreError("COURSE_CORRUPT", "课程数据损坏"); },
		} as unknown as CourseStore;
		const scope = await resolveRecallScope(broken, "session_a.jsonl");
		expect(scope.status).toBe("unavailable");
		if (scope.status !== "unavailable") throw new Error("expected unavailable");
		expect(scope.reason).toBe("COURSE_CORRUPT");
		// Never a scope object: the caller must not be able to widen the search.
		expect(recallOptionsForScope(scope)).toEqual({});
	});
});
