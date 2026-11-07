import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore, CourseStoreError } from "./course-store.js";
import { startLearning, type LearningStartDeps, type LearningStartOutcome } from "./learning-start.js";
import type { PlanStage } from "./types.js";

/**
 * E4.4a contract: one task → one live session, a session is never created
 * before the attempt can be named, and a failed binding never leaves a
 * misclassified conversation behind.
 */

const roots: string[] = [];

async function makeStore(): Promise<CourseStore> {
	const root = await mkdtemp(join(tmpdir(), "inno-learning-start-"));
	roots.push(root);
	return new CourseStore({ dataDir: join(root, "data") });
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface RuntimeHarness {
	deps: LearningStartDeps;
	created: string[];
	discarded: string[];
	activated: string[];
	records: Array<{ sessionId: string; goalId: string | null }>;
	addSession: (id: string) => void;
}

function harness(store: CourseStore, overrides: Partial<LearningStartDeps> = {}): RuntimeHarness {
	const sessions = new Set<string>();
	const created: string[] = [];
	const discarded: string[] = [];
	const activated: string[] = [];
	const records: Array<{ sessionId: string; goalId: string | null }> = [];
	let sequence = 0;
	const deps: LearningStartDeps = {
		courseStore: store,
		sessionExists: async (id) => sessions.has(id),
		sessionState: () => null,
		createSession: async () => {
			const sessionId = `session_${++sequence}.jsonl`;
			sessions.add(sessionId);
			created.push(sessionId);
			return { sessionId, previousSessionId: "previous.jsonl" };
		},
		activateSession: async (id) => {
			activated.push(id);
			return "ok";
		},
		discardSession: async (id) => {
			sessions.delete(id);
			discarded.push(id);
			return { discarded: true };
		},
		initializeLearningRecord: async (sessionId, goalId) => {
			records.push({ sessionId, goalId });
			return { created: true, checkpoint: { revision: 1, status: "active", step: "conversation" } };
		},
		...overrides,
	};
	return {
		deps,
		created,
		discarded,
		activated,
		records,
		addSession: (id: string) => sessions.add(id),
	};
}

async function seed(store: CourseStore) {
	const course = await store.createCourse({ title: "Python 编程" });
	const other = await store.createCourse({ title: "高等数学" });
	await store.bindGoal(course.course_id, "goal_python");
	const { plan, stages, tasks } = await store.createPlanWithStructure(course.course_id, {
		title: "Python 计划",
		status: "active",
		goalId: "goal_python",
		stages: [{
			title: "基础",
			tasks: [
				{ title: "阅读装饰器教材", estimatedMinutes: 25, conceptIds: ["concept_decorator"], conceptLabels: ["装饰器"] },
				{ title: "装饰器练习", estimatedMinutes: 35 },
			],
		}],
	});
	return { course, other, plan, stage: stages[0] as PlanStage, tasks, planTask: tasks[0] };
}

function expectReady(outcome: LearningStartOutcome): Extract<LearningStartOutcome, { status: "ready" }> {
	if (outcome.status !== "ready") throw new Error(`expected ready, got ${JSON.stringify(outcome)}`);
	return outcome;
}

describe("learning start idempotency", () => {
	it("reopens the task's existing session instead of creating a second one", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		const runtime = harness(store);

		const first = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_first",
		}));
		expect(first.created).toBe(true);
		expect(first.resumed).toBe(false);
		expect(first.task?.status).toBe("in_progress");
		expect(runtime.created).toHaveLength(1);

		const second = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_second",
		}));
		expect(second.created).toBe(false);
		expect(second.resumed).toBe(true);
		expect(second.sessionId).toBe(first.sessionId);
		// A resume never reserved a request record, so it must not report a
		// spurious "start record" warning.
		expect(second.warnings).toEqual([]);
		expect(runtime.created).toHaveLength(1);
		expect(runtime.activated).toEqual([first.sessionId]);
		// The task session keeps one binding, not one per click.
		const bindings = await store.listSessionBindings(course.course_id);
		expect(bindings.filter((binding) => binding.task_id === planTask.task_id)).toHaveLength(1);
	});

	it("replays the same request id without creating another session", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		const runtime = harness(store);

		const first = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_same",
		}));
		const second = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_same",
		}));
		expect(second.sessionId).toBe(first.sessionId);
		expect(second.resumed).toBe(true);
		expect(runtime.created).toHaveLength(1);
	});

	it("collapses concurrent starts of one task into a single session", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		let resolveCreate!: (value: { sessionId: string; previousSessionId: string }) => void;
		const gate = new Promise<{ sessionId: string; previousSessionId: string }>((yes) => { resolveCreate = yes; });
		let calls = 0;
		const runtime = harness(store, {
			createSession: async () => {
				calls += 1;
				return gate;
			},
		});

		const a = startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_a",
		});
		const b = startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_b",
		});
		resolveCreate({ sessionId: "session_shared.jsonl", previousSessionId: "previous.jsonl" });
		runtime.addSession("session_shared.jsonl");
		const [first, second] = [expectReady(await a), expectReady(await b)];
		expect(calls).toBe(1);
		expect(first.sessionId).toBe("session_shared.jsonl");
		expect(second.sessionId).toBe("session_shared.jsonl");
	});

	it("rejects a request id reused for another task", async () => {
		const store = await makeStore();
		const { course, tasks } = await seed(store);
		const runtime = harness(store);
		expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: tasks[0].task_id, requestId: "req_shared",
		}));
		const conflict = await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: tasks[1].task_id, requestId: "req_shared",
		});
		expect(conflict).toMatchObject({ status: "error", httpStatus: 409, code: "request_conflict" });
		expect(runtime.created).toHaveLength(1);
	});
});

describe("learning start validation", () => {
	it("refuses a completed task and never creates a session", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		await store.updateTask(course.course_id, planTask.task_id, { status: "completed" });
		const runtime = harness(store);
		const outcome = await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_done",
		});
		expect(outcome).toMatchObject({ status: "error", httpStatus: 409, code: "task_completed" });
		expect(runtime.created).toHaveLength(0);
	});

	it("refuses a task from another course without confirming it exists", async () => {
		const store = await makeStore();
		const { other, planTask } = await seed(store);
		const runtime = harness(store);
		const outcome = await startLearning(runtime.deps, {
			courseId: other.course_id, taskId: planTask.task_id, requestId: "req_cross",
		});
		expect(outcome).toMatchObject({ status: "error", httpStatus: 404, code: "task_not_found" });
		expect(runtime.created).toHaveLength(0);
	});

	it("refuses a task whose plan is still a draft", async () => {
		const store = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const { plan, tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "草稿计划",
			status: "draft",
			stages: [{ title: "基础", tasks: [{ title: "阅读教材" }] }],
		});
		expect(plan.status).toBe("draft");
		const runtime = harness(store);
		const outcome = await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: tasks[0].task_id, requestId: "req_draft",
		});
		expect(outcome).toMatchObject({ status: "error", httpStatus: 409, code: "plan_not_active" });
		expect(runtime.created).toHaveLength(0);
	});
});

describe("learning start degradation", () => {
	class FailingBindStore extends CourseStore {
		override async bindSession(): Promise<never> {
			throw new CourseStoreError("COURSE_CORRUPT", "模拟绑定写入失败");
		}
	}

	it("discards the new session when the course binding cannot be written", async () => {
		const root = await mkdtemp(join(tmpdir(), "inno-learning-start-fail-"));
		roots.push(root);
		const store = new FailingBindStore({ dataDir: join(root, "data") });
		const course = await store.createCourse({ title: "Python 编程" });
		const { tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			status: "active",
			tasks: [{ title: "阅读教材" }],
		});
		const runtime = harness(store);
		const outcome = await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: tasks[0].task_id, requestId: "req_bind_fail",
		});
		expect(outcome).toMatchObject({ status: "error", httpStatus: 503, code: "binding_failed", rolledBack: true });
		expect(runtime.created).toHaveLength(1);
		expect(runtime.discarded).toEqual(runtime.created);
		// No half-written state: no binding, no start record, task untouched.
		expect(await store.listSessionBindings(course.course_id)).toHaveLength(0);
		expect(await store.getLearningStart("req_bind_fail")).toBeUndefined();
		expect((await store.listTasks(course.course_id))[0].status).toBe("pending");
	});

	it("reports a partial start without failing when the B2 record cannot be opened", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		const runtime = harness(store, {
			initializeLearningRecord: async () => { throw new Error("record store unavailable"); },
		});
		const outcome = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_b2_fail",
		}));
		expect(outcome.learning).toEqual({ created: false, checkpoint: null });
		expect(outcome.warnings.join()).toContain("学习记录");
		// The session and binding are real, so the learner can keep working.
		expect(await store.listSessionBindings(course.course_id)).toHaveLength(1);
	});

	it("heals a binding whose session file disappeared", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		await store.bindSession({
			courseId: course.course_id, sessionId: "session_ghost.jsonl", taskId: planTask.task_id, origin: "task",
		});
		const runtime = harness(store);
		const outcome = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_heal",
		}));
		expect(outcome.created).toBe(true);
		expect(outcome.sessionId).not.toBe("session_ghost.jsonl");
		const bindings = await store.listSessionBindings(course.course_id);
		expect(bindings).toHaveLength(1);
		expect(bindings[0]).toMatchObject({ session_id: outcome.sessionId, task_id: planTask.task_id });
	});

	it("recovers a session created by an earlier attempt of the same request", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		await store.reserveLearningStart({
			courseId: course.course_id, requestId: "req_recover", taskId: planTask.task_id,
		});
		await store.attachLearningStartSession("req_recover", "session_orphan.jsonl");
		const runtime = harness(store);
		runtime.addSession("session_orphan.jsonl");

		const outcome = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_recover",
		}));
		expect(outcome.sessionId).toBe("session_orphan.jsonl");
		expect(outcome.resumed).toBe(true);
		expect(outcome.created).toBe(false);
		expect(runtime.created).toHaveLength(0);
		expect((await store.getLearningStart("req_recover"))?.status).toBe("ready");
	});
});

describe("learning start context", () => {
	it("opens free chat without a task and without inventing task state", async () => {
		const store = await makeStore();
		const { course } = await seed(store);
		const runtime = harness(store);
		const outcome = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: null, requestId: "req_free",
		}));
		expect(outcome.task).toBeNull();
		expect(outcome.goalId).toBeNull();
		const bindings = await store.listSessionBindings(course.course_id);
		expect(bindings[0]).toMatchObject({ task_id: null, origin: "free_question" });
	});

	it("opens B2 with the plan's bound goal", async () => {
		const store = await makeStore();
		const { course, planTask } = await seed(store);
		const runtime = harness(store);
		const outcome = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: planTask.task_id, requestId: "req_goal",
		}));
		expect(outcome.goalId).toBe("goal_python");
		expect(runtime.records[0]).toEqual({ sessionId: outcome.sessionId, goalId: "goal_python" });
	});

	it("does not attach a goal the course does not bind", async () => {
		const store = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const { tasks } = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			status: "active",
			// A goal id that no binding supports must not reach B2.
			stages: [{ title: "基础", tasks: [{ title: "阅读教材" }] }],
		});
		const runtime = harness(store);
		const outcome = expectReady(await startLearning(runtime.deps, {
			courseId: course.course_id, taskId: tasks[0].task_id, requestId: "req_no_goal",
		}));
		expect(outcome.goalId).toBeNull();
		expect(runtime.records[0].goalId).toBeNull();
	});
});
