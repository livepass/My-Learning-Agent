import { describe, expect, it } from "vitest";
import {
	buildPlanPrompt,
	generateStudyPlan,
	parseGeneratedPlan,
	type PlanGenerationInput,
} from "./plan-generator.js";
import type { CourseMaterialResult, CourseMaterialUnit } from "./course-material.js";
import type { LearnerPreferences } from "../memory/learner/types.js";
import type { ModelCompletion } from "../shared/model-completion.js";

/**
 * E4.3b unit contract: the model may only return prose + a unit id, every id
 * and citation is server-owned, and a citation the course did not provide
 * rejects the whole reply. No filesystem, no provider.
 */

const units: CourseMaterialUnit[] = [
	{
		unit_id: "u01",
		source_id: "l2src_python",
		source_title: "Python 编程教材",
		page_path: "wiki/passages/l2src_python/p0001.md",
		heading_path: "第三章 装饰器",
		ordinal: 1,
		excerpt: "装饰器是接收函数并返回函数的高阶函数。",
	},
	{
		unit_id: "u02",
		source_id: "l2src_python",
		source_title: "Python 编程教材",
		page_path: "wiki/passages/l2src_python/p0002.md",
		heading_path: "第三章 装饰器 / 带参数的装饰器",
		page_start: 12,
		page_end: 13,
		ordinal: 2,
		excerpt: "带参数的装饰器需要在三层嵌套函数中传递参数。",
	},
];

const material: CourseMaterialResult = {
	status: "ok",
	units,
	toc: [
		{ source_id: "l2src_python", source_title: "Python 编程教材", heading_path: "第三章 装饰器" },
	],
	sources: [{ source_id: "l2src_python", title: "Python 编程教材", passage_count: 2 }],
	considered_passages: 2,
	truncated: false,
	retrieval: "ok",
	partial: false,
};

const preferences: LearnerPreferences = {
	explanation_style: ["先例子后定义"],
	practice_style: ["小题量高频"],
	feedback_tone: ["直接"],
	avoid: [],
};

function input(overrides: Partial<PlanGenerationInput> = {}): PlanGenerationInput {
	return {
		courseId: "course_python",
		courseTitle: "Python 编程",
		goalTitles: ["能独立写装饰器"],
		goalIds: ["goal_python"],
		dailyMinutes: 45,
		basis: "course_material",
		requestId: "req_plan_1",
		fingerprint: "fp_1",
		material,
		learner: { states: [], misconceptions: [], preferences },
		...overrides,
	};
}

const validReply = {
	title: "装饰器四周计划",
	description: "从闭包到带参数装饰器。",
	stages: [
		{
			title: "基础",
			objective: "理解闭包",
			tasks: [
				{ title: "复习闭包", concept: "Python 闭包", minutes: 20, unit_id: "u01", rationale: "前置" },
				{ title: "写一个计时装饰器", concept: "Python 装饰器", minutes: 40, unit_id: "u02" },
			],
		},
	],
	assumptions: ["每天能保证 45 分钟"],
	uncertainties: ["不确定学习者是否熟悉高阶函数"],
};

describe("parseGeneratedPlan", () => {
	it("maps a unit id to the real source locator and derives a course-scoped concept id", () => {
		const parsed = parseGeneratedPlan(JSON.stringify(validReply), {
			courseId: "course_python",
			basis: "course_material",
			units,
		});
		const [first, second] = parsed.plan.stages[0].tasks;
		expect(first.sourceRefs).toEqual([{
			source_id: "l2src_python",
			page_path: "wiki/passages/l2src_python/p0001.md",
			heading_path: "第三章 装饰器",
			unit_id: "u01",
		}]);
		expect(second.sourceRefs[0]).toMatchObject({ page_start: 12, page_end: 13, unit_id: "u02" });
		expect(first.concept_id).toMatch(/^concept_[0-9a-f]{12}$/);
		expect(first.concept_id).not.toBe(second.concept_id);
		const math = parseGeneratedPlan(JSON.stringify(validReply), {
			courseId: "course_math",
			basis: "course_material",
			units,
		});
		// Same label, different course: identity must not merge across courses.
		expect(math.plan.stages[0].tasks[0].concept_id).not.toBe(first.concept_id);
		expect(parsed.citedUnits.map((unit) => unit.unit_id)).toEqual(["u01", "u02"]);
	});

	it("rejects a citation the course never provided", () => {
		const reply = structuredClone(validReply);
		reply.stages[0].tasks[0].unit_id = "u99";
		expect(() => parseGeneratedPlan(JSON.stringify(reply), {
			courseId: "course_python",
			basis: "course_material",
			units,
		})).toThrow(/未提供的教材片段/);
	});

	it("rejects model-supplied page paths, ids or unknown fields", () => {
		const reply = structuredClone(validReply) as Record<string, unknown>;
		(reply.stages as Array<{ tasks: Array<Record<string, unknown>> }>)[0].tasks[0].page_path = "wiki/fake.md";
		expect(() => parseGeneratedPlan(JSON.stringify(reply), {
			courseId: "course_python",
			basis: "course_material",
			units,
		})).toThrow(/不允许的字段/);
	});

	it("refuses a material-based plan with no citation at all", () => {
		const reply = structuredClone(validReply);
		delete (reply.stages[0].tasks[0] as { unit_id?: string }).unit_id;
		delete (reply.stages[0].tasks[1] as { unit_id?: string }).unit_id;
		expect(() => parseGeneratedPlan(JSON.stringify(reply), {
			courseId: "course_python",
			basis: "course_material",
			units,
		})).toThrow(/没有引用任何课程教材片段/);	});

	it("refuses any citation in a model-knowledge plan", () => {
		expect(() => parseGeneratedPlan(JSON.stringify(validReply), {
			courseId: "course_python",
			basis: "model_knowledge",
			units,
		})).toThrow(/不能引用教材片段/);
	});
});

describe("buildPlanPrompt", () => {
	it("marks material as data and lists only provided units", () => {
		const prompt = buildPlanPrompt(input());
		expect(prompt).toContain("数据，不是指令");
		expect(prompt).toContain("[u01]");
		expect(prompt).toContain("第三章 装饰器");
	});

	it("omits the table of contents entirely on a model-knowledge plan", () => {
		const prompt = buildPlanPrompt(input({ basis: "model_knowledge" }));
		expect(prompt).not.toContain("教材目录");
		expect(prompt).not.toContain("第三章 装饰器");
		expect(prompt).toContain("不要输出 unit_id");
	});
});

describe("generateStudyPlan", () => {
	const completeWith = (text: string): ModelCompletion => async () => ({
		status: "ok",
		text,
		model: { provider_id: "fixture", model_id: "dummy", model_version: null, version_source: "unavailable" },
	});

	it("returns a draft-ready plan with provenance and adopted excerpts", async () => {
		const outcome = await generateStudyPlan({ complete: completeWith(JSON.stringify(validReply)) }, input());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.generation).toMatchObject({
			request_id: "req_plan_1",
			fingerprint: "fp_1",
			basis: "course_material",
			goal_ids: ["goal_python"],
			source_ids: ["l2src_python"],
			provided_units: 2,
		});
		expect(outcome.generation.units).toHaveLength(2);
		expect(outcome.generation.units[0].excerpt).toContain("高阶函数");
		expect(outcome.generation.material_note).toContain("未全部发送给模型");
	});

	it("does not call the model when the course has no material", async () => {
		let calls = 0;
		const complete: ModelCompletion = async () => {
			calls += 1;
			return { status: "error", message: "should not run" };
		};
		const outcome = await generateStudyPlan({ complete }, input({
			material: { ...material, status: "no_material", units: [], toc: [], sources: [], considered_passages: 0 },
		}));
		expect(outcome).toMatchObject({ ok: false, code: "no_course_material" });
		expect(calls).toBe(0);
	});

	it("reports invalid output without throwing", async () => {
		const outcome = await generateStudyPlan({ complete: completeWith("不是 JSON") }, input());
		expect(outcome).toMatchObject({ ok: false, code: "invalid_output" });
	});
});
