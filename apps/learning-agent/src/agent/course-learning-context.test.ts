import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseStore, CourseStoreError } from "../courses/course-store.js";
import { buildCourseLearningContext, type CourseLearningContextDeps } from "./course-learning-context.js";
import { createDefaultProfile, type LearnerProfile } from "../memory/learner/types.js";
import type { L2SearchResult } from "../memory/l2/l2-search.js";
import type { RecallResult } from "../memory/l3/recall.js";

/**
 * E4.4c contract: the injected course context is scoped by the persisted
 * binding, bounded, and labelled by source. Python material and math material
 * must never appear in the same section; an unclassified session gets none.
 */

// Profile writes and temp-dir setup are I/O bound; the default 5 s is tight
// when the full suite runs several servers in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];

interface Fixture {
	root: string;
	store: CourseStore;
	courseId: string;
	otherCourseId: string;
	taskId: string;
	pythonPage: string;
	mathPage: string;
	learnerDir: string;
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "inno-course-context-"));
	roots.push(root);
	const dataDir = join(root, "data");
	const learnerDir = join(dataDir, "learner");
	const l2DataDir = join(dataDir, "l2");
	await mkdir(learnerDir, { recursive: true });
	await mkdir(join(l2DataDir, "wiki", "passages", "l2src_python"), { recursive: true });
	await mkdir(join(l2DataDir, "wiki", "passages", "l2src_math"), { recursive: true });

	const pythonPage = "wiki/passages/l2src_python/p0001.md";
	const mathPage = "wiki/passages/l2src_math/p0001.md";
	await writeFile(join(l2DataDir, pythonPage), [
		"---",
		"title: Python 装饰器",
		"type: passage",
		"passage:",
		"  source_id: l2src_python",
		"  heading_path: 第三章 装饰器",
		"---",
		"装饰器是接收函数并返回函数的高阶函数。",
	].join("\n"));
	await writeFile(join(l2DataDir, mathPage), [
		"---",
		"title: 高数导数",
		"type: passage",
		"passage:",
		"  source_id: l2src_math",
		"  heading_path: 第三章 导数",
		"---",
		"导数描述函数在某一点的瞬时变化率。",
	].join("\n"));

	const store = new CourseStore({ dataDir });
	const python = await store.createCourse({ title: "Python 编程" });
	const math = await store.createCourse({ title: "高等数学" });
	await store.bindGoal(python.course_id, "goal_python");
	await store.bindGoal(math.course_id, "goal_math");
	await store.bindSource(python.course_id, "l2src_python");
	await store.bindSource(math.course_id, "l2src_math");
	const { tasks } = await store.createPlanWithStructure(python.course_id, {
		title: "Python 计划",
		status: "active",
		goalId: "goal_python",
		stages: [{
			title: "基础阶段",
			tasks: [{
				title: "阅读装饰器教材",
				estimatedMinutes: 25,
				conceptIds: ["concept_decorator"],
				conceptLabels: ["装饰器"],
			}],
		}],
	});
	await store.bindSession({
		courseId: python.course_id, sessionId: "python_session.jsonl", taskId: tasks[0].task_id, origin: "task",
	});
	await store.bindSession({
		courseId: math.course_id, sessionId: "math_session.jsonl", origin: "task", taskId: null,
	});

	const profile: LearnerProfile = createDefaultProfile("default");
	profile.goals = [
		{ goal_id: "goal_python", title: "能独立写装饰器", type: "skill", priority: 1, status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-11-01T00:00:00.000Z" },
		{ goal_id: "goal_math", title: "掌握导数", type: "exam", priority: 1, status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-11-01T00:00:00.000Z" },
	];
	profile.knowledge_states = [
		{
			concept_id: "concept_decorator", concept_name: "装饰器", domain: "python", course_id: python.course_id,
			mastery: 0.3, confidence: 0.6, stability: 0.2, state_label: "fragile",
			evidence_ids: ["ev_1", "ev_2"], diagnosis: "需要更多练习", next_actions: ["复习闭包"],
		},
		{
			concept_id: "concept_closure", concept_name: "闭包", domain: "python", course_id: python.course_id,
			mastery: 0.55, confidence: 0.5, stability: 0.4, state_label: "review_due",
			review_due_at: "2026-11-01T00:00:00.000Z", evidence_ids: ["ev_3"], diagnosis: "到期复习", next_actions: [],
		},
		{
			concept_id: "concept_derivative", concept_name: "导数", domain: "math", course_id: math.course_id,
			mastery: 0.2, confidence: 0.5, stability: 0.2, state_label: "learning",
			evidence_ids: ["ev_9"], diagnosis: "高数专属", next_actions: [],
		},
	];
	profile.preferences = {
		explanation_style: ["example_first"],
		practice_style: ["small_steps"],
		feedback_tone: ["direct"],
		avoid: ["长篇理论"],
	};
	await writeFile(join(learnerDir, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");

	return {
		root, store, courseId: python.course_id, otherCourseId: math.course_id,
		taskId: tasks[0].task_id, pythonPage, mathPage, learnerDir,
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function deps(fx: Fixture, overrides: Partial<CourseLearningContextDeps> = {}): CourseLearningContextDeps {
	const searchCalls: Array<{ query: string; sourceIds: readonly string[] }> = [];
	const recallCalls: Array<{ query: string; exclude?: string; allowed?: ReadonlySet<string> }> = [];
	const base: CourseLearningContextDeps = {
		courseStore: fx.store,
		paths: { learnerDataDir: fx.learnerDir, l2DataDir: join(fx.root, "data", "l2") },
		searchL2: async (query, _limit, options) => {
			searchCalls.push({ query, sourceIds: options.sourceIds });
			// Mimic the real scoped search: only this course's source is eligible.
			if (!options.sourceIds.includes("l2src_python")) return [];
			return [{
				path: fx.pythonPage, title: "Python 装饰器", type: "passage",
				sourceIds: ["l2src_python"], score: 1, via: [{ type: "lexical", detail: "装饰器" }] as never,
			}];
		},
		l3: {
			recallWithStatus: async (query, exclude, options) => {
				recallCalls.push({ query, exclude, allowed: options?.allowedSessionIds });
				return {
					status: "ok",
					results: [{
						sessionId: "python_session.jsonl", role: "user", text: "上次装饰器的例子没看懂", ts: Date.parse("2026-11-05T00:00:00.000Z"), score: 0.8,
					}] as RecallResult[],
				};
			},
		},
		resolveRecallScope: async (sessionId) => {
			const context = sessionId ? await fx.store.getSessionContext(sessionId) : undefined;
			if (!context) return { status: "unclassified" };
			const bindings = await fx.store.listSessionBindings(context.course.course_id);
			return {
				status: "course",
				courseId: context.course.course_id,
				allowedSessionIds: new Set(bindings.map((binding) => binding.session_id)),
			};
		},
		...overrides,
	};
	// Expose call capture without widening the public deps type.
	(base as unknown as { searchCalls: typeof searchCalls }).searchCalls = searchCalls;
	(base as unknown as { recallCalls: typeof recallCalls }).recallCalls = recallCalls;
	return base;
}

describe("course learning context", () => {
	it("injects course, task, L1, L2 and L3 with no cross-course content", async () => {
		const fx = await fixture();
		const d = deps(fx);
		const context = await buildCourseLearningContext(d, "python_session.jsonl", "装饰器怎么写");
		expect(context.status).toBe("course");
		expect(context.section).toContain("Python 编程");
		expect(context.section).toContain("阅读装饰器教材");
		expect(context.section).toContain("基础阶段");
		expect(context.section).toContain("能独立写装饰器");
		// The profile store normalizes a state without reproducible evidence to
		// "unknown"; the section must report that honestly rather than invent a label.
		expect(context.section).toContain("装饰器：未知，掌握度 0.30");
		expect(context.section).toContain("装饰器是接收函数并返回函数的高阶函数");
		expect(context.section).toContain("上次装饰器的例子没看懂");
		expect(context.section).toContain("例子优先");
		// Another course's state, material and history never appear.
		expect(context.section).not.toContain("导数");
		expect(context.section).not.toContain("高等数学");
		expect(context.section).not.toContain("高数导数");
		// 闭包 is normalized to an unknown label but mastery 0.55 is not "weak";
		// only the low-mastery state is shown as a gap.
		expect(context.details).toMatchObject({ l1_states: 1, l2_snippets: 1, l3_snippets: 1 });

		const searchCalls = (d as unknown as { searchCalls: Array<{ sourceIds: readonly string[] }> }).searchCalls;
		expect(searchCalls[0].sourceIds).toEqual([expect.stringMatching(/^l2src_/)]);
		expect(searchCalls[0].sourceIds).not.toContain("l2src_math");
		const recallCalls = (d as unknown as { recallCalls: Array<{ exclude?: string; allowed?: ReadonlySet<string> }> }).recallCalls;
		expect(recallCalls[0].exclude).toBe("python_session.jsonl");
		expect(recallCalls[0].allowed?.has("math_session.jsonl")).toBe(false);
	});

	it("returns no course section for an unclassified session", async () => {
		const fx = await fixture();
		const context = await buildCourseLearningContext(deps(fx), "legacy_session.jsonl", "随便问问");
		expect(context.status).toBe("unclassified");
		expect(context.section).toBe("");
		expect(context.details).toMatchObject({ course_id: null, l2_snippets: 0, l3_snippets: 0 });
	});

	it("keeps the turn usable and injects nothing when the course store is unreadable", async () => {
		const broken = { getSessionContext: async () => { throw new CourseStoreError("COURSE_CORRUPT", "坏数据"); } } as unknown as CourseStore;
		const fx = await fixture();
		const context = await buildCourseLearningContext({ ...deps(fx), courseStore: broken }, "python_session.jsonl", "装饰器");
		expect(context).toMatchObject({ status: "unavailable", section: "" });
	});

	it("bounds the number of L1 states and material snippets", async () => {
		const fx = await fixture();
		const profile = createDefaultProfile("default");
		profile.knowledge_states = Array.from({ length: 12 }, (_, index) => ({
			concept_id: `concept_${index}`, concept_name: `知识点${index}`, domain: "python",
			course_id: fx.courseId, mastery: 0.1 + index * 0.01, confidence: 0.5, stability: 0.2,
			state_label: "fragile" as const, evidence_ids: ["ev"], diagnosis: "", next_actions: [],
		}));
		await writeFile(join(fx.learnerDir, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
		const hits: L2SearchResult[] = Array.from({ length: 5 }, (_, index) => ({
			path: fx.pythonPage, title: `片段${index}`, type: "passage",
			sourceIds: ["l2src_python"], score: 1, via: [] as never,
		}));
		const context = await buildCourseLearningContext({
			...deps(fx),
			searchL2: async () => hits,
		}, "python_session.jsonl", "装饰器");
		expect(context.details.l1_states).toBe(6);
		expect(context.details.l2_snippets).toBe(3);
		expect(context.section.length).toBeLessThanOrEqual(4_200);
	});

	it("explains an empty course instead of borrowing material", async () => {
		const fx = await fixture();
		const empty = await fx.store.createCourse({ title: "空课程" });
		await fx.store.bindSession({ courseId: empty.course_id, sessionId: "empty_session.jsonl", origin: "free_question", taskId: null });
		const calls: unknown[] = [];
		const context = await buildCourseLearningContext({
			...deps(fx),
			searchL2: async (...args) => { calls.push(args); return []; },
		}, "empty_session.jsonl", "有什么资料");
		expect(context.status).toBe("course");
		expect(context.section).toContain("尚未关联任何教材");
		// The scope is still passed — an empty array, not "no filter".
		expect((calls[0] as unknown[])[2]).toEqual({ sourceIds: [] });
	});

	it("labels L3 states instead of pretending there is no history", async () => {
		const fx = await fixture();
		const emptyIndex = await buildCourseLearningContext({
			...deps(fx),
			l3: { recallWithStatus: async () => ({ status: "empty_index", results: [] }) },
		}, "python_session.jsonl", "装饰器");
		expect(emptyIndex.section).toContain("历史对话索引尚未建立");
		expect(emptyIndex.details.l3_status).toBe("empty_index");

		const unavailable = await buildCourseLearningContext({
			...deps(fx),
			l3: { recallWithStatus: async () => ({ status: "unavailable", results: [] }) },
		}, "python_session.jsonl", "装饰器");
		expect(unavailable.section).toContain("历史对话索引暂不可用");
		expect(unavailable.details.l3_status).toBe("unavailable");

		const noScope = await buildCourseLearningContext({
			...deps(fx),
			resolveRecallScope: async () => ({ status: "unavailable", reason: "COURSE_CORRUPT" }),
		}, "python_session.jsonl", "装饰器");
		expect(noScope.section).toContain("课程归属暂时无法解析");
		expect(noScope.details.l3_status).toBe("scope_unavailable");
	});
});
