import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore, CourseStoreError } from "./course-store.js";
import type { PlanGeneration } from "./types.js";

/**
 * E4.3a/c store contract: plan + phases + tasks are written together, drafts
 * are editable only under a revision check, and confirmation is the single
 * draft → active path. Legacy files stay readable with their original order.
 */

const roots: string[] = [];

async function makeStore(): Promise<{ store: CourseStore; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-courses-plan-"));
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
		source_ids: ["l2src_python"],
		provided_units: 1,
		units: [],
		assumptions: [],
		uncertainties: [],
		material_note: "依据课程教材",
		...overrides,
	};
}

describe("legacy plan/task compatibility", () => {
	it("loads a pre-E4.3 file and keeps the original created_at order", async () => {
		const { dataDir } = await makeStore();
		await mkdir(join(dataDir, "courses"), { recursive: true });
		await writeFile(join(dataDir, "courses", "state.json"), JSON.stringify({
			schema_version: 1,
			revision: 4,
			courses: [{
				course_id: "course_legacy", title: "旧课程", description: "", status: "in_progress",
				created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
			}],
			goal_bindings: [],
			plans: [{
				plan_id: "plan_legacy", course_id: "course_legacy", title: "旧计划", description: "",
				goal_id: null, status: "active", origin: "user",
				created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
			}],
			tasks: [
				{
					task_id: "task_b", course_id: "course_legacy", plan_id: "plan_legacy", title: "第二",
					concept_ids: [], source_ids: [], status: "pending",
					created_at: "2026-01-03T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z",
				},
				{
					task_id: "task_a", course_id: "course_legacy", plan_id: "plan_legacy", title: "第一",
					concept_ids: [], source_ids: [], status: "pending",
					created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
				},
			],
			session_bindings: [],
			source_bindings: [],
		}), "utf-8");

		const store = new CourseStore({ dataDir });
		const tasks = await store.listTasks("course_legacy", "plan_legacy");
		expect(tasks.map((task) => task.task_id)).toEqual(["task_a", "task_b"]);
		expect(tasks.map((task) => task.order)).toEqual([0, 1]);
		expect(tasks[0]).toMatchObject({ difficulty: "standard", estimated_minutes: null, stage_id: null });
		const plan = await store.getPlan("course_legacy", "plan_legacy");
		expect(plan?.revision).toBe(1);
		expect(await store.listStages("course_legacy", "plan_legacy")).toEqual([]);
	});
});

describe("atomic plan creation", () => {
	it("creates the plan, phases and tasks in one write with dense task order", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "装饰器计划",
			targetDate: "2026-12-31",
			dailyMinutes: 45,
			stages: [
				{ title: "基础", tasks: [{ title: "复习闭包" }, { title: "写计时装饰器", estimatedMinutes: 40 }] },
				{ title: "进阶", tasks: [{ title: "带参数装饰器", difficulty: "challenge" }] },
			],
		});
		expect(created.stages.map((stage) => stage.order)).toEqual([0, 1]);
		expect(created.tasks.map((task) => task.order)).toEqual([0, 1, 2]);
		expect(created.tasks[2]).toMatchObject({ stage_id: created.stages[1].stage_id, difficulty: "challenge" });
		expect(created.plan).toMatchObject({ status: "active", origin: "user", revision: 1, target_date: "2026-12-31" });
		const snapshot = await store.snapshot(course.course_id);
		expect(snapshot?.plans).toHaveLength(1);
		expect(snapshot?.tasks).toHaveLength(3);
	});

	it("writes nothing when one task is invalid", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		await expectCode(store.createPlanWithStructure(course.course_id, {
			title: "坏计划",
			stages: [{ title: "基础", tasks: [{ title: "ok" }, { title: "   " }] }],
		}), "COURSE_INVALID");
		const snapshot = await store.snapshot(course.course_id);
		expect(snapshot?.plans).toEqual([]);
		expect(snapshot?.stages).toEqual([]);
		expect(snapshot?.tasks).toEqual([]);
	});
});

describe("generated drafts", () => {
	it("saves as draft and is idempotent by request id and fingerprint", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const first = await store.saveGeneratedPlanDraft(course.course_id, {
			title: "AI 草稿",
			generation: generation(),
			stages: [{ title: "基础", tasks: [{ title: "复习闭包", conceptIds: ["concept_closure"] }] }],
		});
		expect(first.created).toBe(true);
		expect(first.plan.status).toBe("draft");
		expect(first.plan.origin).toBe("agent_suggested");

		const retry = await store.saveGeneratedPlanDraft(course.course_id, {
			title: "AI 草稿",
			generation: generation(),
			stages: [{ title: "基础", tasks: [{ title: "另一个", conceptIds: ["concept_x"] }] }],
		});
		expect(retry.created).toBe(false);
		expect(retry.plan.plan_id).toBe(first.plan.plan_id);
		expect(retry.tasks.map((task) => task.title)).toEqual(["复习闭包"]);

		const secondRequest = await store.saveGeneratedPlanDraft(course.course_id, {
			title: "重复指纹",
			generation: generation({ request_id: "req_2" }),
			stages: [{ title: "基础", tasks: [{ title: "重复" }] }],
		});
		expect(secondRequest.plan.plan_id).toBe(first.plan.plan_id);

		const forced = await store.saveGeneratedPlanDraft(course.course_id, {
			title: "重新生成",
			generation: generation({ request_id: "req_3" }),
			stages: [{ title: "基础", tasks: [{ title: "新任务" }] }],
		}, { force: true });
		expect(forced.created).toBe(true);
		expect(forced.plan.plan_id).not.toBe(first.plan.plan_id);
		expect((await store.listTasks(course.course_id))).toHaveLength(2);

		await expectCode(store.saveGeneratedPlanDraft(course.course_id, {
			title: "冲突",
			generation: generation({ fingerprint: "fp_other" }),
			stages: [{ title: "基础", tasks: [{ title: "冲突" }] }],
		}), "COURSE_CONFLICT");
	});
});

describe("draft editing and confirmation", () => {
	async function draftSetup() {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const saved = await store.saveGeneratedPlanDraft(course.course_id, {
			title: "AI 草稿",
			generation: generation(),
			stages: [{
				title: "基础",
				tasks: [
					{ title: "复习闭包", conceptIds: ["concept_closure"] },
					{ title: "写装饰器", conceptIds: ["concept_decorator"], estimatedMinutes: 40 },
				],
			}],
		});
		return { store, course, saved };
	}

	it("replaces the draft atomically and preserves row identity", async () => {
		const { store, course, saved } = await draftSetup();
		const [first, second] = saved.tasks;
		const replaced = await store.replacePlanDraft(course.course_id, saved.plan.plan_id, {
			expectedRevision: 1,
			title: "我改过的草稿",
			stages: [{
				stage_id: saved.stages[0].stage_id,
				title: "基础（改）",
				tasks: [
					{ task_id: first.task_id, title: "复习闭包（改）" },
					{ title: "新增任务" },
				],
			}],
		});
		expect(replaced.plan.title).toBe("我改过的草稿");
		expect(replaced.plan.revision).toBe(2);
		expect(replaced.tasks.map((task) => task.task_id)).toContain(first.task_id);
		expect(replaced.tasks.map((task) => task.task_id)).not.toContain(second.task_id);
		expect(replaced.tasks.find((task) => task.task_id === first.task_id)).toMatchObject({
			title: "复习闭包（改）",
			// E4.6-R2: an unstarted draft row stays pending through the edit.
			status: "pending",
			order: 0,
		});
		expect(replaced.stages[0].title).toBe("基础（改）");
		await expectCode(store.replacePlanDraft(course.course_id, saved.plan.plan_id, {
			expectedRevision: 1,
			stages: [{ title: "x", tasks: [{ title: "x" }] }],
		}), "COURSE_CONFLICT");
	});

	it("keeps a legacy completed row's status when a draft is replaced", async () => {
		// E4.6-R2 makes this state unreachable through the API, but a file written
		// before it may hold it. A draft edit must not reset history to `pending`.
		const { dataDir } = await makeStore();
		await mkdir(join(dataDir, "courses"), { recursive: true });
		await writeFile(join(dataDir, "courses", "state.json"), JSON.stringify({
			schema_version: 1,
			revision: 2,
			courses: [{
				course_id: "course_legacy_draft", title: "Python 编程", description: "", status: "in_progress",
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			goal_bindings: [],
			plans: [{
				plan_id: "plan_legacy_draft", course_id: "course_legacy_draft", title: "旧草稿", description: "",
				goal_id: null, status: "draft", origin: "agent_suggested", revision: 1,
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			stages: [{
				stage_id: "stage_legacy", course_id: "course_legacy_draft", plan_id: "plan_legacy_draft",
				title: "基础", description: "", order: 0,
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			tasks: [{
				task_id: "task_legacy_done", course_id: "course_legacy_draft", plan_id: "plan_legacy_draft",
				stage_id: "stage_legacy", title: "旧任务", order: 0, estimated_minutes: null,
				difficulty: "standard", concept_ids: [], source_ids: [], status: "completed",
				completed_at: "2026-11-02T00:00:00.000Z",
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-02T00:00:00.000Z",
			}],
			session_bindings: [],
			source_bindings: [],
			study_settings: [],
			learning_starts: [],
		}, null, 2), "utf-8");
		const store = new CourseStore({ dataDir });

		const replaced = await store.replacePlanDraft("course_legacy_draft", "plan_legacy_draft", {
			expectedRevision: 1,
			stages: [{
				stage_id: "stage_legacy",
				title: "基础",
				tasks: [{ task_id: "task_legacy_done", title: "旧任务（改名）" }],
			}],
		});
		expect(replaced.tasks[0]).toMatchObject({ title: "旧任务（改名）", status: "completed" });
	});

	it("refuses to bypass confirmation and handles the active-plan conflict", async () => {
		const { store, course, saved } = await draftSetup();
		const manual = await store.createPlan(course.course_id, { title: "我的计划" });
		expect(manual.status).toBe("active");
		await expectCode(store.updatePlan(course.course_id, saved.plan.plan_id, { status: "active" }), "COURSE_CONFLICT");
		await expectCode(store.confirmPlan(course.course_id, saved.plan.plan_id, { expectedRevision: 1 }), "COURSE_CONFLICT");
		const confirmed = await store.confirmPlan(course.course_id, saved.plan.plan_id, {
			expectedRevision: 1,
			replaceActive: true,
		});
		expect(confirmed.plan.status).toBe("active");
		expect(confirmed.archivedPlanIds).toEqual([manual.plan_id]);
		expect((await store.getPlan(course.course_id, manual.plan_id))?.status).toBe("archived");
		// Idempotent confirmation with the same revision.
		expect((await store.confirmPlan(course.course_id, saved.plan.plan_id, { expectedRevision: 2 })).alreadyActive).toBe(true);
	});

	it("refuses whole-plan replacement once the plan is active", async () => {
		const { store, course, saved } = await draftSetup();
		await store.confirmPlan(course.course_id, saved.plan.plan_id, { expectedRevision: 1 });
		await expectCode(store.replacePlanDraft(course.course_id, saved.plan.plan_id, {
			expectedRevision: 2,
			stages: [{ title: "x", tasks: [{ title: "x" }] }],
		}), "COURSE_CONFLICT");
	});
});

describe("task ordering and adjustments", () => {
	it("reorders only with the complete task list and bumps the plan revision", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			stages: [{ title: "阶段", tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] }],
		});
		const ids = created.tasks.map((task) => task.task_id);
		await expectCode(store.reorderTasks(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			taskIds: [ids[0], ids[1]],
		}), "COURSE_INVALID");
		const reordered = await store.reorderTasks(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			taskIds: [ids[2], ids[0], ids[1]],
		});
		expect(reordered.map((task) => task.title)).toEqual(["C", "A", "B"]);
		expect((await store.getPlan(course.course_id, created.plan.plan_id))?.revision).toBe(2);
	});

	it("applies one confirmed adjustment, records its basis and refuses a stale revision", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			stages: [{ title: "阶段", tasks: [{ title: "写装饰器", conceptIds: ["concept_decorator"] }] }],
		});
		const applied = await store.applyPlanAdjustment(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			suggestionId: "sug_1234567890abcdef",
			type: "review_prerequisite",
			taskId: created.tasks[0].task_id,
			conceptId: "concept_closure",
			conceptLabel: "闭包",
			reasonCode: "review_due",
			evidence: {
				concept_id: "concept_closure",
				state_label: "review_due",
				review_due_at: "2026-01-01T00:00:00.000Z",
				evidence_count: 2,
			},
		});
		expect(applied.tasks.map((task) => task.title)).toEqual(["复习：闭包", "写装饰器"]);
		expect(applied.plan.revision).toBe(2);
		expect(applied.plan.adjustments?.[0]).toMatchObject({
			suggestion_id: "sug_1234567890abcdef",
			type: "review_prerequisite",
			reason_code: "review_due",
			evidence: { evidence_count: 2, review_due_at: "2026-01-01T00:00:00.000Z" },
		});
		expect(applied.adjustment.changes[0]).toContain("复习：闭包");
		await expectCode(store.applyPlanAdjustment(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			suggestionId: "sug_1234567890abcdef",
			type: "defer_task",
			taskId: created.tasks[0].task_id,
			reasonCode: "review_due",
		}), "COURSE_CONFLICT");
	});

	it("replaces stage titles and order without deleting tasks", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			stages: [
				{ title: "基础", tasks: [{ title: "A" }] },
				{ title: "进阶", tasks: [{ title: "B" }] },
			],
		});
		const [firstStage, secondStage] = created.stages;
		const replaced = await store.replacePlanStages(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			stages: [
				{ stage_id: secondStage.stage_id, title: "进阶（提前）" },
				{ stage_id: firstStage.stage_id, title: "基础（改名）" },
			],
		});
		expect(replaced.stages.map((stage) => [stage.title, stage.order])).toEqual([["进阶（提前）", 0], ["基础（改名）", 1]]);
		expect(replaced.tasks).toHaveLength(2);
		expect(replaced.tasks.map((task) => task.title)).toEqual(["A", "B"]);

		const detached = await store.replacePlanStages(course.course_id, created.plan.plan_id, {
			expectedRevision: 2,
			stages: [{ stage_id: firstStage.stage_id, title: "只留基础" }],
		});
		expect(detached.stages).toHaveLength(1);
		expect(detached.tasks).toHaveLength(2);
		expect(detached.tasks.find((task) => task.title === "B")?.stage_id).toBeNull();
		await expectCode(store.replacePlanStages(course.course_id, created.plan.plan_id, {
			expectedRevision: 1,
			stages: [],
		}), "COURSE_CONFLICT");
	});

	it("deletes a task and closes the order gap", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const created = await store.createPlanWithStructure(course.course_id, {
			title: "计划",
			stages: [{ title: "阶段", tasks: [{ title: "A" }, { title: "B" }, { title: "C" }] }],
		});
		expect(await store.deleteTask(course.course_id, created.tasks[1].task_id)).toBe(true);
		const tasks = await store.listTasks(course.course_id, created.plan.plan_id);
		expect(tasks.map((task) => [task.title, task.order])).toEqual([["A", 0], ["C", 1]]);
		expect(await store.deleteTask(course.course_id, created.tasks[1].task_id)).toBe(false);
	});
});

describe("study settings", () => {
	it("stores one daily budget per course and validates it", async () => {
		const { store } = await makeStore();
		const course = await store.createCourse({ title: "Python 编程" });
		const settings = await store.setStudySettings(course.course_id, 45);
		expect(settings).toMatchObject({ course_id: course.course_id, daily_minutes: 45 });
		expect(await store.getStudySettings(course.course_id)).toMatchObject({ daily_minutes: 45 });
		await expectCode(store.setStudySettings(course.course_id, 0), "COURSE_INVALID");
		await expectCode(store.setStudySettings("course_missing", 30), "COURSE_NOT_FOUND");
		const state = JSON.parse(await readFile(store.filePath, "utf-8")) as { study_settings: unknown[] };
		expect(state.study_settings).toHaveLength(1);
	});
});
