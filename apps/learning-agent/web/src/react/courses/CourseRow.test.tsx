// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import type { CourseDailyPlan, CourseSummary } from "../../api/courses.js";
import { CourseRow } from "./CourseRow.js";

/**
 * UI-C01 — a course row states each fact once.
 *
 * Before this change a paused course read "已暂停" twice (badge and subtitle),
 * a completed course read "已完成" twice, and a course without a plan read
 * "尚未启用学习计划" as badge, subtitle and progress note. These cases pin the
 * badge as the single owner of the status, the subtitle as the place for a real
 * stage/plan name, and the unchanged row behaviour (open / menu / archive).
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
});

const daily = (overrides: Partial<CourseDailyPlan> = {}): CourseDailyPlan => ({
	course_id: "course_cn",
	course_title: "同义替换",
	status: "ok",
	daily_minutes: 30,
	plan: { plan_id: "plan_1", title: "同义词训练计划", revision: 1 },
	other_active_plans: 0,
	items: [task()],
	planned_minutes: 20,
	task_progress: { total: 4, completed: 0, in_progress: 0, percent: 0 },
	knowledge: { due_reviews: 0, weak_concepts: 0, stable_concepts: 0, evidence_backed_concepts: 0 },
	notes: [],
	...overrides,
});

function row(props: {
	course?: CourseSummary;
	daily?: CourseDailyPlan;
	onOpen?: () => void;
	onArchive?: () => void;
	onDelete?: () => void;
} = {}) {
	const onOpen = props.onOpen ?? vi.fn();
	const onArchive = props.onArchive ?? vi.fn();
	const onDelete = props.onDelete ?? vi.fn();
	const { container } = render(
		<CourseRow
			course={props.course ?? course()}
			daily={props.daily ?? daily()}
			onOpen={onOpen}
			onArchive={onArchive}
			onDelete={onDelete}
		/>,
	);
	return { container, onOpen, onArchive, onDelete };
}

describe("CourseRow — one statement per fact", () => {
	it("T07 shows a paused status once and keeps a real stage in the subtitle", () => {
		row({ course: course({ status: "paused" }), daily: daily() });
		// One badge, and no second "已暂停" in the subtitle.
		expect(screen.getAllByText("已暂停")).toHaveLength(1);
		expect(screen.getByText("第一阶段：词义辨析")).toBeTruthy();
	});

	it("T07b shows no subtitle for a paused course with no stage or plan", () => {
		const { container } = row({
			course: course({ status: "paused" }),
			daily: daily({ status: "no_active_plan", plan: null, items: [], task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 } }),
		});
		expect(screen.getAllByText("已暂停")).toHaveLength(1);
		// The only "no plan" mention is the badge; the subtitle is not drawn.
		expect(screen.getAllByText("尚未启用学习计划")).toHaveLength(1);
		expect(container.querySelector(".mla-today-course-sub")).toBeNull();
	});

	it("T08 shows a completed status once", () => {
		row({
			course: course({ status: "completed" }),
			daily: daily({ items: [task({ stage_title: "收尾阶段" })] }),
		});
		expect(screen.getAllByText("已完成")).toHaveLength(1);
		expect(screen.getByText("收尾阶段")).toBeTruthy();
	});

	it("T09 states a missing plan once", () => {
		row({
			daily: daily({
				status: "no_active_plan",
				plan: null,
				items: [],
				task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 },
			}),
		});
		expect(screen.getAllByText("尚未启用学习计划")).toHaveLength(1);
		expect(screen.queryByText("未启用计划")).toBeNull();
		expect(screen.queryByText("暂无今日安排。打开课程查看学习计划。")).toBeNull();
	});

	it("T10 shows the real stage for an in-progress course, with no invented description", () => {
		row();
		expect(screen.getByText("第一阶段：词义辨析")).toBeTruthy();
		expect(screen.queryByText("进行中")).toBeNull();
	});

	it("falls back to the plan title when no task carries a stage", () => {
		row({ daily: daily({ items: [task({ stage_id: null, stage_title: undefined })] }) });
		expect(screen.getByText("同义词训练计划")).toBeTruthy();
	});

	it("T16 keeps the task progress and percentage from the same plan", () => {
		const { container } = row({
			daily: daily({ task_progress: { total: 4, completed: 1, in_progress: 0, percent: 25 } }),
		});
		expect(screen.getByText("1 / 4")).toBeTruthy();
		expect(screen.getByText("25%")).toBeTruthy();
		expect(container.querySelector(".mla-today-track > span")?.getAttribute("style")).toContain("width: 25%");
	});

	it("T15 keeps the row open action and the more-actions menu", () => {
		const { container, onOpen, onArchive, onDelete } = row();
		// Both the row and its menu trigger mention the title; the row button is
		// the one that opens the course.
		const main = container.querySelector(".mla-today-course-main") as HTMLElement;
		fireEvent.click(main);
		expect(onOpen).toHaveBeenCalledTimes(1);

		const trigger = screen.getByRole("button", { name: "更多操作：同义替换" });
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(screen.getByText("归档课程"));
		expect(onArchive).toHaveBeenCalledTimes(1);
		expect(onDelete).not.toHaveBeenCalled();
	});

	it("T13 truncates long names without dropping the full title", () => {
		const longTitle = "同义替换与近义词辨析：从语境到语体的系统训练方法";
		const { container } = row({ course: course({ title: longTitle }) });
		const name = within(container).getByText(longTitle);
		// The text stays whole in the DOM; truncation is a CSS concern.
		expect(name.textContent).toBe(longTitle);
		expect(container.querySelector(".mla-today-course-name strong")).toBe(name);
	});
});
