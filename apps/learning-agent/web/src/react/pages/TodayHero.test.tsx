// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import type { CourseDailyPlan, CourseSummary, DailyPlanItem } from "../../api/courses.js";
import { TodayHero, type TodayHeroVariant } from "./TodayHero.js";

/**
 * UI-C01 — the primary surface states each fact once.
 *
 * The "今日主课" badge used to append the course title while the heading below
 * was that same title, and a paused hero said "已暂停" in the badge and again in
 * the meta line. These cases pin the de-duplication and the copy that remains.
 */

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

const course = (overrides: Partial<CourseSummary> = {}): CourseSummary => ({
	course_id: "course_cn",
	title: "同义替换",
	description: "",
	status: "in_progress",
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 4, sessions: 1, sources: 0 },
	...overrides,
});

const task = (overrides: Record<string, unknown> = {}) => ({
	kind: "task" as const,
	task_id: "task_1",
	title: "辨析近义词",
	status: "pending" as const,
	order: 0,
	stage_id: "stage_1",
	stage_title: "第一阶段：词义辨析",
	estimated_minutes: 20,
	difficulty: "standard" as const,
	concept_ids: [],
	source_ids: [],
	reason_code: "next_task" as const,
	reason: "这是当前计划的下一项任务。",
	...overrides,
}) as Extract<DailyPlanItem, { kind: "task" }>;

const daily = (overrides: Partial<CourseDailyPlan> = {}): CourseDailyPlan => ({
	course_id: "course_cn",
	course_title: "同义替换",
	status: "ok",
	daily_minutes: 30,
	plan: { plan_id: "plan_1", title: "同义词训练计划", revision: 1 },
	other_active_plans: 0,
	items: [task()],
	planned_minutes: 20,
	task_progress: { total: 4, completed: 2, in_progress: 0, percent: 50 },
	knowledge: { due_reviews: 0, weak_concepts: 0, stable_concepts: 0, evidence_backed_concepts: 0 },
	notes: [],
	...overrides,
});

function hero(variant: TodayHeroVariant, overrides: { course?: CourseSummary; daily?: CourseDailyPlan; task?: DailyPlanItem } = {}) {
	render(
		<TodayHero
			variant={variant}
			course={overrides.course ?? course()}
			daily={overrides.daily ?? daily()}
			task={overrides.task as never}
			busy={false}
			disabled={false}
			reviewCount={0}
			onStart={vi.fn()}
			onResume={vi.fn()}
			onOpen={vi.fn()}
			onPlan={vi.fn()}
			onRecords={vi.fn()}
			onLearn={vi.fn()}
		/>,
	);
	return document.querySelector(".mla-today-hero") as HTMLElement;
}

describe("TodayHero — one statement per fact", () => {
	it("T10 names the course once and keeps the real stage and duration", () => {
		const region = hero("task", { task: task() });
		expect(region.querySelector("#today-hero-title")?.textContent).toBe("辨析近义词");
		expect(region.querySelector(".mla-today-hero-meta")?.textContent).toBe(
			"同义替换 · 第一阶段：词义辨析 · 20 分钟",
		);
	});

	it("T12 drops a stage that is just the course title", () => {
		const region = hero("task", {
			task: task({ stage_title: "同义替换" }),
			daily: daily({ plan: null }),
		});
		expect(region.querySelector(".mla-today-hero-meta")?.textContent).toBe("同义替换 · 20 分钟");
	});

	it("T07 states a paused status once", () => {
		const region = hero("paused", { course: course({ status: "paused" }) });
		// Badge owns the state; the meta line is not an echo of it.
		expect(region.querySelector(".mla-today-hero-badge")?.textContent).toBe("课程已暂停");
		expect(region.querySelector(".mla-today-hero-meta")?.textContent).toBe("同义词训练计划");
		expect(screen.getAllByText(/已暂停/)).toHaveLength(1);
	});

	it("T07b omits the meta line for a paused course with no plan", () => {
		const region = hero("paused", {
			course: course({ status: "paused" }),
			daily: daily({ status: "no_active_plan", plan: null, items: [] }),
		});
		expect(region.querySelector(".mla-today-hero-meta")).toBeNull();
		expect(screen.getAllByText(/已暂停/)).toHaveLength(1);
	});

	it("T09 states a missing plan once", () => {
		const region = hero("no-plan", { daily: daily({ status: "no_active_plan", plan: null, items: [] }) });
		expect(region.querySelector(".mla-today-hero-badge")?.textContent).toBe("还没有学习计划");
		expect(screen.getAllByText("还没有学习计划")).toHaveLength(1);
	});

	it("does not repeat the course title in the main-course badge", () => {
		const region = hero("course");
		expect(region.querySelector(".mla-today-hero-badge")?.textContent).toBe("今日主课");
		expect(region.querySelector("#today-hero-title")?.textContent).toBe("同义替换");
		expect(screen.getAllByText(/同义替换/)).toHaveLength(1);
	});

	it("T16 keeps the plan progress numbers", () => {
		const region = hero("task", { task: task() });
		expect(region.querySelector(".mla-today-hero-progress")?.textContent).toContain("2/4 · 50%");
	});
});
