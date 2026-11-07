import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore, CourseStoreError } from "./course-store.js";
import type { PlanGeneration } from "./types.js";

/**
 * E4.3-R1 store-level integrity regressions:
 * idempotent replay without a version bump, duplicate draft ids, cross-plan
 * moves, bound-task protection, goal binding and no-op adjustments.
 */

const roots: string[] = [];

async function makeStore(): Promise<{ store: CourseStore; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-courses-integrity-"));
	roots.push(root);
	const dataDir = join(root, "data");
	return { store: new CourseStore({ dataDir }), dataDir };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(CourseStoreError);
	await expect(promise).rejects.toMatchObject({ code });
}

function generation(overrides: Partial<PlanGeneration> = {}): PlanGeneration {
	return {
		request_id: "req_1",
		fingerprint: "fp_1",
		basis: "course_material",
		model: { provider_id: "fixture", model_id: "dummy", model_version: null, version_source: "unavailable" },
		generated_at: "2026-11-07T00:00:00.000Z",
		goal_ids: [],
		source_ids: [],
		provided_units: 0,
		units: [],
		assumptions: [],
		uncertainties: [],
		material_note: "test",
		...overrides,
	};
}

async function revisionOf(dataDir: string): Promise<number> {
	const state = JSON.parse(await readFile(join(dataDir, "courses", "state.json"), "utf-8")) as { revision: number };
	return state.revision;
}

describe("generation idempotency", () => {
	it("returns the stored plan without bumping the file revision or adding tasks", async () => {
		const { store, dataDir } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await store.bindGoal(course.course_id, "goal_python");
		const input = {
			title: "草稿",
			goalId: "goal_python",
			generation: generation(),
			stages: [{ title: "基础", tasks: [{ title: "A", conceptIds: ["concept_a"] }] }],
		};
		const first = await store.saveGeneratedPlanDraft(course.course_id, input);
		const revisionAfterFirst = await revisionOf(dataDir);
		const tasksAfterFirst = await store.listTasks(course.course_id);
		const second = await store.saveGeneratedPlanDraft(course.course_id, input);
		expect(second.created).toBe(false);
		expect(second.plan.plan_id).toBe(first.plan.plan_id);
		expect(await revisionOf(dataDir)).toBe(revisionAfterFirst);
		expect(await store.listTasks(course.course_id)).toEqual(tasksAfterFirst);
	});

	it("reports a request-id conflict for a different fingerprint and rejects unbound goals", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await expectCode(store.saveGeneratedPlanDraft(course.course_id, {
			title: "草稿",
			goalId: "goal_other",
			generation: generation(),
			stages: [{ title: "基础", tasks: [{ title: "A" }] }],
		}), "COURSE_CONFLICT");
		await store.saveGeneratedPlanDraft(course.course_id, {
			title: "草稿",
			generation: generation(),
			stages: [{ title: "基础", tasks: [{ title: "A" }] }],
		});
		const lookup = await store.lookupGeneratedPlan(course.course_id, "req_1", "fp_other");
		expect(lookup.status).toBe("conflict");
		const replay = await store.lookupGeneratedPlan(course.course_id, "req_1", "fp_1");
		expect(replay.status).toBe("found");
	});
});

describe("draft id uniqueness", () => {
	it("rejects duplicate stage and task ids without changing the plan", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			status: "draft",
			stages: [{ title: "基础", tasks: [{ title: "A" }, { title: "B" }] }],
		});
		const before = await store.snapshot(course.course_id);
		await expectCode(store.replacePlanDraft(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			stages: [
				{ stage_id: created.stages[0].stage_id, title: "一", tasks: [] },
				{ stage_id: created.stages[0].stage_id, title: "二", tasks: [] },
			],
		}), "COURSE_INVALID");
		await expectCode(store.replacePlanDraft(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			stages: [{
				title: "基础",
				tasks: [
					{ task_id: created.tasks[0].task_id, title: "A" },
					{ task_id: created.tasks[0].task_id, title: "重复" },
				],
			}],
		}), "COURSE_INVALID");
		const after = await store.snapshot(course.course_id);
		expect(after).toEqual(before);
	});

	it("rejects duplicate stage ids in a stage-only replacement", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			stages: [{ title: "基础", tasks: [{ title: "A" }] }],
		});
		await expectCode(store.replacePlanStages(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			stages: [
				{ stage_id: created.stages[0].stage_id, title: "一" },
				{ stage_id: created.stages[0].stage_id, title: "二" },
			],
		}), "COURSE_INVALID");
	});
});

describe("cross-plan task move", () => {
	it("bumps both plans, keeps both orders dense and checks the source revision", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const a = await store.createPlanWithStructure(course.course_id, {
			title: "A", stages: [{ title: "A", tasks: [{ title: "A1" }, { title: "A2" }] }],
		});
		const b = await store.createPlanWithStructure(course.course_id, {
			title: "B", stages: [{ title: "B", tasks: [{ title: "B1" }] }],
		});
		const moved = await store.updateTask(course.course_id, a.tasks[0].task_id, {
			planId: b.plan.plan_id,
			expectedPlanRevision: 1,
			expectedTargetRevision: 1,
		});
		expect(moved).toMatchObject({ plan_id: b.plan.plan_id, order: 1, stage_id: null });
		const aTasks = await store.listTasks(course.course_id, a.plan.plan_id);
		const bTasks = await store.listTasks(course.course_id, b.plan.plan_id);
		expect(aTasks.map((task) => [task.title, task.order])).toEqual([["A2", 0]]);
		expect(bTasks.map((task) => [task.title, task.order])).toEqual([["B1", 0], ["A1", 1]]);
		expect((await store.getPlan(course.course_id, a.plan.plan_id))?.revision).toBe(2);
		expect((await store.getPlan(course.course_id, b.plan.plan_id))?.revision).toBe(2);

		await expectCode(store.updateTask(course.course_id, a.tasks[1].task_id, {
			planId: b.plan.plan_id,
			expectedPlanRevision: 1,
		}), "COURSE_CONFLICT");
		expect((await store.getTask(course.course_id, a.tasks[1].task_id))?.plan_id).toBe(a.plan.plan_id);
	});
});

describe("bound task protection", () => {
	async function setup() {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划", status: "draft", stages: [{ title: "基础", tasks: [{ title: "A" }, { title: "B" }] }],
		});
		await store.bindSession({
			courseId: course.course_id,
			sessionId: "s1.jsonl",
			taskId: created.tasks[0].task_id,
		});
		return { store, course, created };
	}

	it("refuses to delete a task referenced by a session binding", async () => {
		const { store, course, created } = await setup();
		await expectCode(store.deleteTask(course.course_id, created.tasks[0].task_id), "COURSE_CONFLICT");
		expect(await store.getTask(course.course_id, created.tasks[0].task_id)).toBeDefined();
		expect(await store.getSessionBinding("s1.jsonl")).toMatchObject({ task_id: created.tasks[0].task_id });
	});

	it("refuses a draft replacement that omits a bound task", async () => {
		const { store, course, created } = await setup();
		await expectCode(store.replacePlanDraft(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			stages: [{ stage_id: created.stages[0].stage_id, title: "基础", tasks: [{ title: "只剩新任务" }] }],
		}), "COURSE_CONFLICT");
		expect((await store.listTasks(course.course_id)).map((task) => task.title)).toEqual(["A", "B"]);
	});
});

describe("goal binding", () => {
	it("refuses a plan goal that is not bound to the course", async () => {
		const { store } = await makeStore();
		const python = await store.createCourse({ title: "Python 编程" });
		const math = await store.createCourse({ title: "高等数学" });
		await store.bindGoal(math.course_id, "goal_math");
		await expectCode(store.createPlan(python.course_id, { title: "错绑", goalId: "goal_math" }), "COURSE_CONFLICT");
		await store.bindGoal(python.course_id, "goal_python");
		const plan = await store.createPlan(python.course_id, { title: "正确", goalId: "goal_python" });
		expect(plan.goal_id).toBe("goal_python");
		await expectCode(store.updatePlan(python.course_id, plan.plan_id, { goalId: "goal_math" }), "COURSE_CONFLICT");
	});
});

describe("adjustment no-ops", () => {
	it("refuses deferring an already-last task and duplicate support tasks", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划", stages: [{ title: "阶段", tasks: [{ title: "A", conceptIds: ["concept_a"] }, { title: "B" }] }],
		});
		await expectCode(store.applyPlanAdjustment(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			suggestionId: "sug_defer_last",
			type: "defer_task",
			taskId: created.tasks[1].task_id,
			reasonCode: "plan_overloaded",
		}), "COURSE_CONFLICT");
		expect((await store.getPlan(course.course_id, created.plan.plan_id))?.revision).toBe(1);

		const applied = await store.applyPlanAdjustment(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			suggestionId: "sug_review",
			type: "review_prerequisite",
			taskId: created.tasks[0].task_id,
			conceptId: "concept_a",
			conceptLabel: "A",
			reasonCode: "review_due",
		});
		expect(applied.tasks[0].title).toBe("复习：A");
		await expectCode(store.applyPlanAdjustment(course.course_id, created.plan.plan_id, {
			expectedRevision: 2,
			suggestionId: "sug_review_again",
			type: "review_prerequisite",
			taskId: created.tasks[0].task_id,
			conceptId: "concept_a",
			reasonCode: "review_due",
		}), "COURSE_CONFLICT");
	});
});

describe("draft edit preservation", () => {
	it("keeps omitted concepts, sources and citations when only the title changes", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			status: "draft",
			stages: [{
				title: "基础",
				tasks: [{
					title: "A",
					conceptIds: ["concept_a"],
					conceptLabels: ["A"],
					sourceIds: ["l2src_1"],
					sourceRefs: [{ source_id: "l2src_1", page_path: "wiki/passages/l2src_1/p0001.md", unit_id: "u01" }],
					estimatedMinutes: 30,
				}],
			}],
		});
		const edited = await store.replacePlanDraft(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			stages: [{ stage_id: created.stages[0].stage_id, title: "基础", tasks: [{ task_id: created.tasks[0].task_id, title: "A（改名）" }] }],
		});
		expect(edited.tasks[0]).toMatchObject({
			title: "A（改名）",
			concept_ids: ["concept_a"],
			concept_labels: ["A"],
			source_ids: ["l2src_1"],
			estimated_minutes: 30,
			source_refs: [{ source_id: "l2src_1", page_path: "wiki/passages/l2src_1/p0001.md", unit_id: "u01" }],
		});
	});
});
