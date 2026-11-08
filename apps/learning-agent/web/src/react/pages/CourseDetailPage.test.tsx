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
	listCourseSourceCandidates: vi.fn(),
	getDailyPlans: vi.fn(),
	getCourseSessions: vi.fn(),
	getCourseLearner: vi.fn(),
	getCourseSettings: vi.fn(),
	getUnclassified: vi.fn(),
	getPlanSuggestions: vi.fn(),
	listCourses: vi.fn(),
	generatePlan: vi.fn(),
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
	// Radix Select needs these in jsdom: it captures the pointer and scrolls the
	// highlighted option into view, neither of which jsdom implements.
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => undefined;
	Element.prototype.releasePointerCapture = () => undefined;
	Element.prototype.scrollIntoView = () => undefined;
	coursesStore.reset();
	api.getCourse.mockResolvedValue(detail);
	api.listPlans.mockResolvedValue([draftPlan]);
	api.getPlanDetail.mockResolvedValue({ plan: draftPlan, stages: [], tasks: [] });
	api.listCourseSources.mockResolvedValue([]);
	api.listCourseSourceCandidates.mockResolvedValue([]);
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

	it("does not present an unstarted draft plan's tasks as learning records (E4.6-R1)", async () => {
		setUrl("page=course&course=course_python&view=records");
		// The course snapshot carries every task because the draft editor needs
		// them; the records view must decide by "has this actually started".
		api.getCourse.mockResolvedValue({
			...detail,
			plans: [{ ...draftPlan, status: "draft", origin: "agent_suggested" }],
			stages: [{
				stage_id: "stage_1", course_id: "course_python", plan_id: "plan_1", title: "基础",
				description: "", order: 0,
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			tasks: [{
				task_id: "task_1", course_id: "course_python", plan_id: "plan_1", stage_id: "stage_1",
				title: "阅读装饰器教材", order: 0, estimated_minutes: 25, difficulty: "standard",
				concept_ids: [], source_ids: [], status: "pending",
				created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
			}],
			sessions: [],
		});
		api.getCourseSessions.mockResolvedValue({ sessions: [] });

		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByText("还没有学习记录")).toBeTruthy());
		expect(screen.queryByText("阅读装饰器教材")).toBeNull();
	});

	it("lists a task once it has really started, and keeps it after archiving (E4.6-R1)", async () => {
		setUrl("page=course&course=course_python&view=records");
		const started = {
			task_id: "task_1", course_id: "course_python", plan_id: "plan_1", stage_id: null,
			title: "阅读装饰器教材", order: 0, estimated_minutes: 25, difficulty: "standard" as const,
			concept_ids: [], source_ids: [], status: "in_progress" as const,
			created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
		};
		api.getCourse.mockResolvedValue({
			...detail,
			// The plan is already archived: history must not disappear with it.
			plans: [{ ...draftPlan, status: "archived", origin: "agent_suggested" }],
			stages: [],
			tasks: [started],
			sessions: [],
		});
		api.getCourseSessions.mockResolvedValue({
			sessions: [{
				binding_id: "b1", course_id: "course_python", session_id: "s1.jsonl",
				task_id: "task_1", origin: "task", created_at: "2026-11-02T00:00:00.000Z",
			}],
		});

		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getAllByText("阅读装饰器教材").length).toBeGreaterThan(0));
		// The task badge and the course header both read 「进行中」.
		expect(screen.getAllByText("进行中").length).toBeGreaterThan(0);
		expect(screen.queryByText("还没有学习记录")).toBeNull();
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

	it("defaults AI plan generation to the course material once sources load", async () => {
		setUrl("page=course&course=course_python&view=plan");
		// Sources arrive after the panel mounts; the basis must follow them.
		api.listCourseSources.mockResolvedValue([{
			binding_id: "b1", course_id: "course_python", source_id: "src_ok", status: "active",
			created_at: "2026-11-02T00:00:00.000Z", updated_at: "2026-11-02T00:00:00.000Z",
			source: {
				title: "Python 教程.md", status: "indexed", source_type: "markdown",
				passage_count: 5, updated_at: "2026-11-02T00:00:00.000Z",
				indexed_at: "2026-11-02T00:00:00.000Z",
			},
		}]);

		render(<CourseDetailPage />);

		await waitFor(() => expect(screen.getByRole("button", { name: /AI 生成草稿/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /AI 生成草稿/ }));

		const basis = await screen.findByLabelText("规划依据");
		await waitFor(() => expect(basis.textContent).toContain("基于课程教材"));
	});

	it("offers a source that belongs to another course in 关联已有资料 (E4.6a)", async () => {
		setUrl("page=course&course=course_python&view=library");
		api.listCourseSourceCandidates.mockResolvedValue([{
			source_id: "l2src_shared",
			title: "高等数学讲义.md",
			source_type: "markdown",
			status: "indexed",
			passage_count: 8,
			bound_to_current: false,
			courses: [{ course_id: "course_math", title: "高等数学" }],
		}]);

		render(<CourseDetailPage />);

		const trigger = await screen.findByLabelText("选择已有资料");
		// Radix opens its listbox from the keyboard in jsdom.
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		const option = await screen.findByRole("option", { name: /高等数学讲义\.md/ });
		expect(option.textContent).toContain("已在 高等数学");
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

	it("does not carry one dialog's failure into the other dialog (E4.6b)", async () => {
		setUrl("page=course&course=course_python&view=plan");
		api.generatePlan.mockRejectedValueOnce(new ApiError(502, "模型调用失败，请重试。"));

		render(<CourseDetailPage />);

		fireEvent.click(await screen.findByRole("button", { name: /AI 生成草稿/ }));
		fireEvent.click(await screen.findByRole("button", { name: "生成草稿" }));
		const aiDialog = await screen.findByRole("dialog");
		await waitFor(() => expect(aiDialog.textContent).toContain("模型调用失败"));

		// Close the AI dialog and open the manual one: it never calls the model,
		// so it must not present the model failure as its own.
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		fireEvent.click(await screen.findByRole("button", { name: /手动创建/ }));

		const manualDialog = await screen.findByRole("dialog");
		expect(manualDialog.textContent).not.toContain("模型调用失败");
	});
});
