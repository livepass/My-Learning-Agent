// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import type { CourseDailyPlan, CourseSummary, DailyPlanItem } from "../../api/courses.js";
import { CourseCard, pickCurrentTask } from "./CourseCard.js";

/**
 * UI-C01 — the task card states each fact once.
 *
 * The cover carried the stage and the duration, and the body repeated both as a
 * visible subtitle; a missing stage made the cover fall back to the course title,
 * which the body also shows. These cases pin the split (cover = stage + minutes,
 * body = course / task / progress / actions), the screen-reader copy that keeps
 * the information reachable behind the decorative cover, and the unchanged
 * progress and actions.
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
	title: "辨析近义词的语体差异",
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

function card(props: {
	course?: CourseSummary;
	daily?: CourseDailyPlan;
	task?: Extract<DailyPlanItem, { kind: "task" }>;
	onStart?: () => void;
	onOpen?: () => void;
} = {}) {
	const onStart = props.onStart ?? vi.fn();
	const onOpen = props.onOpen ?? vi.fn();
	const { container } = render(
		<CourseCard
			course={props.course ?? course()}
			daily={props.daily ?? daily()}
			task={props.task ?? task()}
			busy={false}
			onStart={onStart}
			onOpen={onOpen}
		/>,
	);
	return { container, onStart, onOpen };
}

describe("CourseCard — cover owns stage and duration", () => {
	it("T11 shows the stage and the minutes once, in the cover only", () => {
		const { container } = card();
		// Cover: stage kicker + duration pill.
		expect(container.querySelector(".mla-today-cover-kicker")?.textContent).toBe("第一阶段：词义辨析");
		expect(container.querySelector(".mla-today-cover-minutes")?.textContent).toBe("20 分钟");
		// Body: the old visible subtitle is gone; only the screen-reader copy remains.
		expect(container.querySelector(".mla-today-task-sub")).toBeNull();
		const sr = container.querySelector(".mla-today-sr");
		expect(sr?.textContent).toBe("第一阶段：词义辨析 · 20 分钟");
		// One visible stage string and one visible duration string on the card.
		expect(screen.getAllByText("第一阶段：词义辨析")).toHaveLength(1);
		expect(screen.getAllByText("20 分钟")).toHaveLength(1);
	});

	it("T12 does not fabricate a stage when the server has none", () => {
		const { container } = card({
			task: task({ stage_id: null, stage_title: undefined }),
			daily: daily({ plan: null, items: [task({ stage_id: null, stage_title: undefined })] }),
		});
		// No stage kicker, and the cover does not fall back to the course title.
		expect(container.querySelector(".mla-today-cover-kicker")).toBeNull();
		expect(container.querySelector(".mla-today-cover-minutes")?.textContent).toBe("20 分钟");
		// The body still names the course exactly once, and the hidden copy keeps
		// only the real duration.
		expect(screen.getAllByText("同义替换")).toHaveLength(1);
		expect(container.querySelector(".mla-today-sr")?.textContent).toBe("20 分钟");
	});

	it("uses the plan title as the cover kicker when the task has no stage", () => {
		const { container } = card({ task: task({ stage_id: null, stage_title: undefined }) });
		// The plan title is a real payload field, so it is shown instead of a
		// fabricated stage — and it is not the course title, so no duplicate.
		expect(container.querySelector(".mla-today-cover-kicker")?.textContent).toBe("同义词训练计划");
	});

	it("T11b keeps the course title in the body and the task title as the heading", () => {
		const { container } = card();
		expect(container.querySelector(".mla-today-course-tag")?.textContent).toBe("同义替换");
		expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("辨析近义词的语体差异");
	});

	it("T14 keeps the cover decorative and the facts reachable", () => {
		const { container } = card();
		expect(container.querySelector(".mla-today-cover")?.getAttribute("aria-hidden")).toBe("true");
		// The card has an accessible name, the task heading is exposed, and the
		// stage/minutes text exists in the accessibility tree via `.mla-today-sr`.
		const article = container.querySelector("article")!;
		expect(article.getAttribute("aria-label")).toBe("课程：同义替换");
		const srTexts = [...container.querySelectorAll(".mla-today-sr")].map((node) => node.textContent);
		expect(srTexts).toContain("第一阶段：词义辨析 · 20 分钟");
		expect(srTexts).toContain("任务进度");
		expect(screen.getByRole("button", { name: "开始学习" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "查看课程" })).toBeTruthy();
	});

	it("T16 keeps the progress numbers and percentage from the daily plan", () => {
		const { container } = card();
		expect(container.querySelector(".mla-today-progress-text")?.textContent).toBe("2/4 · 50%");
		expect(container.querySelector(".mla-today-track > span")?.getAttribute("style")).toContain("width: 50%");
	});

	it("T15 keeps both actions wired", () => {
		const { onStart, onOpen } = card();
		fireEvent.click(screen.getByRole("button", { name: "开始学习" }));
		fireEvent.click(screen.getByRole("button", { name: "查看课程" }));
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("keeps 继续学习 for a task already in progress", () => {
		card({ task: task({ status: "in_progress", reason_code: "in_progress" }) });
		expect(screen.getByRole("button", { name: "继续学习" })).toBeTruthy();
	});

	it("T13 keeps long titles whole in the DOM", () => {
		const longTask = "从语境、语体与感情色彩三个维度系统辨析近义词的用法差异";
		const { container } = card({ task: task({ title: longTask }) });
		expect(within(container).getByRole("heading", { level: 3 }).textContent).toBe(longTask);
	});
});

describe("pickCurrentTask", () => {
	it("prefers an in-progress task and otherwise takes the first one", () => {
		const first = task({ task_id: "a", title: "第一项" });
		const running = task({ task_id: "b", title: "进行中", status: "in_progress", reason_code: "in_progress" });
		expect(pickCurrentTask(daily({ items: [first, running] }))?.task_id).toBe("b");
		expect(pickCurrentTask(daily({ items: [first] }))?.task_id).toBe("a");
		expect(pickCurrentTask(undefined)).toBeUndefined();
	});
});
