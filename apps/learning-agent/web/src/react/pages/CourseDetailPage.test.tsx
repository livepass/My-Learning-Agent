// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CourseDetailPage } from "./CourseDetailPage.js";
import { coursesStore } from "../../stores/courses-store.js";
import { ApiError } from "../../api/client.js";

/**
 * Course detail page: URL-driven tabs, material status vs ownership, legacy
 * duplicate-session notice, and the draft-confirm conflict path.
 */

const api = vi.hoisted(() => ({
	getCourse: vi.fn(),
	listPlans: vi.fn(),
	getPlanDetail: vi.fn(),
	confirmPlan: vi.fn(),
	listCourseSources: vi.fn(),
	getDailyPlans: vi.fn(),
	getCourseSessions: vi.fn(),
	getCourseLearner: vi.fn(),
	getCourseSettings: vi.fn(),
	getUnclassified: vi.fn(),
	getPlanSuggestions: vi.fn(),
	listCourses: vi.fn(),
}));

vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...api };
});

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../shell/navigation.js", async () => {
	const actual = await vi.importActual<typeof import("../shell/navigation.js")>("../shell/navigation.js");
	return { ...actual, navigate: nav.navigate };
});

const course = {
	course_id: "course_python",
	title: "Python 编程",
	description: "从基础语法到异步编程。",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
};

const detail = {
	course,
	counts: { goals: 1, plans: 1, tasks: 2, sessions: 1, sources: 1 },
	goals: [],
	plans: [],
	stages: [],
	tasks: [],
	sessions: [],
	sources: [],
};

const draftPlan = {
	plan_id: "plan_1",
	course_id: "course_python",
	title: "Python 基础 4 周",
	description: "",
	goal_id: null,
	status: "draft" as const,
	origin: "agent_suggested" as const,
	revision: 3,
	stage_count: 1,
	task_count: 2,
	completed_task_count: 0,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
};

function setUrl(query: string) {
	window.history.replaceState(null, "", `/?${query}`);
}

beforeEach(() => {
	vi.clearAllMocks();
	// jsdom has no native dialog implementation; the shared Dialog calls these.
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
		show: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
	});
	coursesStore.reset();
	api.getCourse.mockResolvedValue(detail);
	api.listPlans.mockResolvedValue([draftPlan]);
	api.getPlanDetail.mockResolvedValue({ plan: draftPlan, stages: [], tasks: [] });
	api.listCourseSources.mockResolvedValue([]);
	api.getDailyPlans.mockResolvedValue({ as_of: "", generated_at: "", minutes_override: null, courses: [], total_planned_minutes: 0 });
	api.getCourseSessions.mockResolvedValue({ sessions: [] });
	api.getCourseLearner.mockResolvedValue({
		course, goals: [], knowledge_states: [],
		preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
		unclassified: { knowledge_states: 0, goals: 0 },
	});
	api.getCourseSettings.mockResolvedValue({ course_id: "course_python", daily_minutes: null, updated_at: null });
	api.getUnclassified.mockResolvedValue({ sessions: [], sources: [] });
	api.getPlanSuggestions.mockResolvedValue({ plan_id: "plan_1", revision: 3, suggestions: [], note: "" });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("course detail page", () => {
	it("renders the four tabs and opens the one named by the URL", async () => {
		setUrl("page=course&course=course_python&view=library");
		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByRole("tab", { name: "课程知识库" })).toBeTruthy());
		expect(screen.getByRole("tab", { name: "学习计划" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "学习记录" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "学习概况" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "课程知识库" }).getAttribute("aria-selected")).toBe("true");
	});

	it("pushes a new URL entry when the tab changes", async () => {
		setUrl("page=course&course=course_python&view=plan");
		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByRole("tab", { name: "学习记录" })).toBeTruthy());
		fireEvent.click(screen.getByRole("tab", { name: "学习记录" }));

		expect(nav.navigate).toHaveBeenCalledWith("course", {
			history: "push",
			course: { id: "course_python", view: "records" },
		});
	});

	it("shows the course header and counts from one server read", async () => {
		setUrl("page=course&course=course_python&view=plan");
		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByText("Python 编程")).toBeTruthy());
		expect(screen.getByText("1 个目标")).toBeTruthy();
		expect(screen.getByText("2 个任务")).toBeTruthy();
	});

	it("separates an uploaded-but-unindexed source from an indexed one", async () => {
		setUrl("page=course&course=course_python&view=library");
		api.listCourseSources.mockResolvedValue([
			{
				binding_id: "b1", course_id: "course_python", source_id: "src_ok", status: "active",
				created_at: "2026-11-02T00:00:00.000Z", updated_at: "2026-11-02T00:00:00.000Z",
				source: {
					title: "Python 教程.pdf", status: "indexed", source_type: "pdf",
					passage_count: 42, page_count: 10, updated_at: "2026-11-02T00:00:00.000Z",
					indexed_at: "2026-11-02T00:00:00.000Z",
				},
			},
			{
				binding_id: "b2", course_id: "course_python", source_id: "src_fail", status: "active",
				created_at: "2026-11-02T00:00:00.000Z", updated_at: "2026-11-02T00:00:00.000Z",
				source: {
					title: "高数笔记.docx", status: "error", source_type: "docx",
					passage_count: 0, updated_at: "2026-11-02T00:00:00.000Z",
					error: "无法解析该文档",
				},
			},
		]);

		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByText("已索引")).toBeTruthy());
		expect(screen.getByText("解析失败")).toBeTruthy();
		expect(screen.getByText(/无法解析该文档/)).toBeTruthy();
		expect(screen.getByRole("button", { name: /重试解析/ })).toBeTruthy();
	});

	it("reports legacy duplicate task bindings without deleting anything", async () => {
		setUrl("page=course&course=course_python&view=records");
		api.getCourseSessions.mockResolvedValue({
			sessions: [{
				binding_id: "b1", course_id: "course_python", session_id: "s1.jsonl",
				task_id: "task_1", origin: "task", created_at: "2026-11-02T00:00:00.000Z",
			}],
			duplicate_task_bindings: [{
				task_id: "task_1",
				session_ids: ["s1.jsonl", "s2.jsonl"],
				note: "历史遗留：同一任务存在多个会话。系统保留全部会话与学习记录，本次不自动清理。",
			}],
		});

		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByText(/历史遗留：同一任务存在多个会话/)).toBeTruthy());
		expect(screen.getByText(/s1\.jsonl、s2\.jsonl/)).toBeTruthy();
		// No delete control is offered for history.
		expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
	});

	it("surfaces a plan-confirm version conflict and keeps the newer revision", async () => {
		setUrl("page=course&course=course_python&view=plan");
		api.confirmPlan.mockRejectedValueOnce(
			new ApiError(409, "course_conflict", { error: "course_conflict", revision: 5 }),
		);
		api.listPlans
			.mockResolvedValueOnce([draftPlan])
			.mockResolvedValue([{ ...draftPlan, revision: 5 }]);

		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByRole("button", { name: /确认启用/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /确认启用/ }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("当前版本 #5"));
		expect(api.listPlans.mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});
