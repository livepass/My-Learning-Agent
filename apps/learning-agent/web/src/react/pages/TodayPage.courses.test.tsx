// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayPage } from "./TodayPage.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import i18n from "../../i18n/index.js";

/**
 * The today page's multi-course behaviour: cards come from the server, the
 * start button navigates only after a bound session exists, and the existing
 * C4 recommendation section keeps rendering.
 */

const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getDailyPlans: vi.fn(),
	startCourseLearning: vi.fn(),
	createCourse: vi.fn(),
	archiveCourse: vi.fn(),
	resumeCourse: vi.fn(),
	deleteCourse: vi.fn(),
	getCourseDeletionPreview: vi.fn(),
}));

vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...coursesApi };
});

const learnerApi = vi.hoisted(() => ({
	getLearnerProfile: vi.fn(),
	getLearningRecommendations: vi.fn(),
}));

vi.mock("../../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learner.js")>("../../api/learner.js");
	return { ...actual, ...learnerApi };
});

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../shell/navigation.js", () => ({ navigate: nav.navigate }));

const course = (id: string, title: string, overrides: Record<string, unknown> = {}) => ({
	course_id: id,
	title,
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 3, sessions: 1, sources: 1 },
	...overrides,
});

const dailyCourse = (id: string, title: string, taskTitle: string, overrides: Record<string, unknown> = {}) => ({
	course_id: id,
	course_title: title,
	status: "ok" as const,
	daily_minutes: 30,
	plan: { plan_id: `plan_${id}`, title: "计划", revision: 2 },
	other_active_plans: 0,
	items: [{
		kind: "task" as const,
		task_id: `task_${id}`,
		title: taskTitle,
		status: "pending" as const,
		order: 0,
		stage_id: null,
		estimated_minutes: 25,
		difficulty: "standard" as const,
		concept_ids: [],
		source_ids: [],
		reason_code: "next_task" as const,
		reason: "这是当前计划的下一项任务。",
	}],
	planned_minutes: 25,
	task_progress: { total: 3, completed: 1, in_progress: 0, percent: 33 },
	knowledge: { due_reviews: 0, weak_concepts: 0, stable_concepts: 0, evidence_backed_concepts: 0 },
	notes: [],
	...overrides,
});

const profile = {
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-03T00:00:00.000Z",
	goals: [],
	knowledge_states: [],
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
};

beforeEach(async () => {
	vi.clearAllMocks();
	await i18n.changeLanguage("zh-CN");
	// jsdom has no native <dialog>; the confirmation dialog needs showModal/close.
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		show: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
	});
	coursesStore.reset();
	learnerStore.profile = null;
	learnerStore.recommendations = null;
	learnerStore.recommendationsError = null;
	learnerStore.error = null;
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);
	sessionsStore.sessions = [];
	sessionsStore.currentSessionId = null;
	learnerApi.getLearnerProfile.mockResolvedValue(profile);
	learnerApi.getLearningRecommendations.mockResolvedValue({
		as_of: "", generated_at: "", profile_version: 1, recommendations: [], status: "empty",
		empty_reason: "no_knowledge_evidence", limit: 3,
	});
	coursesApi.getDailyPlans.mockResolvedValue({
		as_of: "2026-11-03T00:00:00.000Z",
		generated_at: "2026-11-03T00:00:00.000Z",
		minutes_override: null,
		courses: [],
		total_planned_minutes: 0,
	});
});

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
	vi.restoreAllMocks();
});

describe("today page — course cards", () => {
	it("shows each course's own task and progress", async () => {
		coursesApi.listCourses.mockResolvedValue([
			course("course_python", "Python 编程"),
			course("course_math", "高等数学"),
		]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 50,
			courses: [
				dailyCourse("course_python", "Python 编程", "理解装饰器"),
				dailyCourse("course_math", "高等数学", "极限的ε-δ定义"),
			],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getAllByText("理解装饰器").length).toBeGreaterThanOrEqual(1));
		expect(screen.getAllByText("极限的ε-δ定义").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText((_, node) => node?.textContent === "1/3 · 33%").length).toBe(2);
		// Opening the page must not start anything.
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
		expect(nav.navigate).not.toHaveBeenCalled();
	});

	it("keeps two remaining tasks on the first screen and reveals the rest on demand", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		const items = [1, 2, 3, 4].map((index) => ({
			kind: "task" as const,
			task_id: `task_${index}`,
			title: `任务${index}`,
			status: index === 1 ? "in_progress" as const : "pending" as const,
			order: index - 1,
			stage_id: null,
			estimated_minutes: 10,
			difficulty: "standard" as const,
			concept_ids: [],
			source_ids: [],
			reason_code: index === 1 ? "in_progress" as const : "next_task" as const,
			reason: "测试任务。",
		}));
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 40,
			courses: [dailyCourse("course_python", "Python 编程", "任务1", {
				items,
				task_progress: { total: 4, completed: 0, in_progress: 1, percent: 0 },
			})],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getAllByText("任务1").length).toBeGreaterThan(0));
		// The hero is task 1; only tasks 2 and 3 stay on the first screen.
		expect(screen.getByText("任务2")).toBeTruthy();
		expect(screen.getByText("任务3")).toBeTruthy();
		expect(screen.queryByText("任务4")).toBeNull();

		const more = screen.getByRole("button", { name: "另有 1 项" });
		fireEvent.click(more);
		await waitFor(() => expect(screen.getByText("任务4")).toBeTruthy());
		expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
	});

	it("navigates only after learning/start returns a bound session", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 25,
			courses: [dailyCourse("course_python", "Python 编程", "理解装饰器")],
		});
		coursesApi.startCourseLearning.mockResolvedValue({
			request_id: "r1",
			session: { session_id: "s_python.jsonl", active: true, created: true, resumed: false },
			course: { course_id: "course_python", title: "Python 编程", status: "in_progress" },
			task: null,
			goal_id: null,
			learning: { created: true, checkpoint: null },
			context_ready: true,
			warnings: [],
		});

		render(<TodayPage />);
		await waitFor(() => expect(screen.getAllByText("理解装饰器").length).toBeGreaterThanOrEqual(1));

		fireEvent.click(screen.getAllByRole("button", { name: "开始学习" })[0]!);

		await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith("learn", {
			history: "push", session: "s_python.jsonl",
		}));
		expect(coursesApi.startCourseLearning).toHaveBeenCalledWith("course_python", {
			task_id: "task_course_python",
			request_id: expect.any(String),
		});
		expect(sessionsStore.openSession).toHaveBeenCalledWith("s_python.jsonl", { historyMode: "none" });
	});

	it("stays on the page and shows the error when the start fails", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 25,
			courses: [dailyCourse("course_python", "Python 编程", "理解装饰器")],
		});
		coursesApi.startCourseLearning.mockRejectedValue(
			Object.assign(new Error("learning_unavailable"), { status: 503, data: { error: "learning_unavailable" } }),
		);

		render(<TodayPage />);
		await waitFor(() => expect(screen.getAllByText("理解装饰器").length).toBeGreaterThanOrEqual(1));

		fireEvent.click(screen.getAllByRole("button", { name: "开始学习" })[0]!);

		// E4.9e: the 503 is shown as the localized unavailable message; the raw
		// code stays available for diagnostics only.
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("暂时不可用"));
		// Keyboard / screen-reader users land on the failure without scrolling.
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
		// No navigation and no fake conversation.
		expect(nav.navigate).not.toHaveBeenCalled();
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
	});

	it("guides a learner with no courses to create one", async () => {
		coursesApi.listCourses.mockResolvedValue([]);

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("还没有课程")).toBeTruthy());
		expect(screen.getAllByRole("button", { name: /创建课程/ }).length).toBeGreaterThanOrEqual(1);
	});

	it("points a course without an active plan to the plan tab", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0,
			courses: [dailyCourse("course_math", "高等数学", "", {
				status: "no_active_plan",
				plan: null,
				items: [],
				task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 },
			})],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByRole("button", { name: /去制定计划/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /去制定计划/ }));
		expect(nav.navigate).toHaveBeenCalledWith("course", {
			history: "push", course: { id: "course_math", view: "plan" },
		});
	});

	it("keeps the existing C4 recommendation section", async () => {
		coursesApi.listCourses.mockResolvedValue([]);
		learnerApi.getLearningRecommendations.mockResolvedValue({
			as_of: "", generated_at: "", profile_version: 1, status: "ok", limit: 3,
			recommendations: [{
				concept_id: "concept_a",
				concept_name: "Python 闭包",
				name_available: true,
				action: "review",
				suggested_kind: "free_recall",
				reason_code: "review_due",
				reason: "这条知识点的复习时间已到。",
				also_matches: [],
				evidence_basis: {
					state_label: "review_due",
					review_due_at: "2026-11-02T00:00:00.000Z",
					evidence_count: 2,
					has_active_misconception: false,
					provenance_limited: false,
					exposure_only: false,
				},
			}],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("Python 闭包")).toBeTruthy());
		expect(screen.getByText("下一步学习建议")).toBeTruthy();
		expect(screen.getAllByText("到期复习").length).toBeGreaterThanOrEqual(1);
	});

	it("keeps deletion behind the more-actions menu and a confirmation (E4.7)", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 25,
			courses: [dailyCourse("course_python", "Python 编程", "理解装饰器")],
		});
		coursesApi.getCourseDeletionPreview.mockResolvedValue({
			course_id: "course_python",
			title: "Python 编程",
			deletable: true,
			blockers: [],
			counts: { plans: 0, stages: 0, tasks: 0, started_tasks: 0, sessions: 0, goals: 0, sources: 0 },
			has_material: false,
		});

		render(<TodayPage />);
		const trigger = await screen.findByRole("button", { name: "更多操作：Python 编程" });
		// The menu is closed by default: no destructive action on the surface.
		expect(screen.queryByText("删除课程")).toBeNull();

		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		await waitFor(() => expect(screen.getByText("删除课程")).toBeTruthy());
		// The card itself also has a 查看课程 button, so the menu is identified by
		// its items rather than by a unique label.
		expect(screen.getAllByText("查看课程").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("归档课程")).toBeTruthy();

		fireEvent.click(screen.getByText("删除课程"));
		// A menu click only asks the server what would happen; nothing is deleted.
		await waitFor(() => expect(coursesApi.getCourseDeletionPreview).toHaveBeenCalledWith("course_python", expect.anything()));
		expect(coursesApi.deleteCourse).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.getByRole("button", { name: /继续删除/ })).toBeTruthy());
		expect(screen.getByRole("heading", { name: /删除课程「Python 编程」/ })).toBeTruthy();
	});

	it("archives a course from the same menu without a dialog", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 25,
			courses: [dailyCourse("course_python", "Python 编程", "理解装饰器")],
		});
		coursesApi.archiveCourse.mockResolvedValue({ ...course("course_python", "Python 编程"), status: "archived" });

		render(<TodayPage />);
		const trigger = await screen.findByRole("button", { name: "更多操作：Python 编程" });
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		await waitFor(() => expect(screen.getByText("归档课程")).toBeTruthy());

		fireEvent.click(screen.getByText("归档课程"));
		await waitFor(() => expect(coursesApi.archiveCourse).toHaveBeenCalledWith("course_python"));
		expect(coursesApi.deleteCourse).not.toHaveBeenCalled();
	});
});

describe("today page — archived courses (E4.7-R1b)", () => {
	it("keeps archived courses off the homepage and links to the archive centre", async () => {
		coursesApi.listCourses.mockResolvedValue([
			course("course_python", "Python 编程"),
			{ ...course("course_math", "高等数学"), status: "archived" },
		]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0, courses: [],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getAllByText("Python 编程").length).toBeGreaterThan(0));
		expect(screen.queryByText("高等数学")).toBeNull();
	});

	it("explains where the courses went when every course is archived", async () => {
		coursesApi.listCourses.mockResolvedValue([{ ...course("course_math", "高等数学"), status: "archived" }]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0, courses: [],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("课程都在归档中")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "查看归档课程" }));
		await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith("settings", {
			history: "push", settingsTab: "archive",
		}));
	});
});

describe("today page — recent sessions and resumed courses (E4.7-R1 final)", () => {
	const emptyDaily = {
		as_of: "", generated_at: "", minutes_override: null, courses: [], total_planned_minutes: 0,
	};
	const session = (
		id: string,
		name: string,
		overrides: Record<string, unknown> = {},
	) => ({
		id,
		name,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-02T00:00:00.000Z",
		messageCount: 2,
		preview: "继续上次的讨论",
		channels: ["web"],
		archived: false,
		course: null,
		daily_visible: true,
		...overrides,
	});

	it("filters 最近学习 with the server's daily_visible and counts only visible sessions", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockResolvedValue(emptyDaily);
		sessionsStore.sessions = [
			session("s_daily.jsonl", "日常会话"),
			// Hidden with its parent course, but never manually archived: the old
			// `!session.archived` filter let this one leak into the rail.
			session("s_course.jsonl", "随课程归档会话", {
				course: { course_id: "course_math", title: "高等数学", archived: true },
				daily_visible: false,
			}),
			session("s_manual.jsonl", "手动归档会话", { archived: true, daily_visible: false }),
		] as never;

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("日常会话")).toBeTruthy());
		expect(screen.queryByText("随课程归档会话")).toBeNull();
		expect(screen.queryByText("手动归档会话")).toBeNull();
		expect(screen.getByText("1 个会话")).toBeTruthy();
	});

	it("offers 继续课程 for a paused course and only changes the status", async () => {
		coursesApi.listCourses.mockResolvedValue([
			{ ...course("course_math", "高等数学"), status: "paused" },
		]);
		coursesApi.getDailyPlans.mockResolvedValue(emptyDaily);
		coursesApi.resumeCourse.mockResolvedValue({ ...course("course_math", "高等数学"), status: "in_progress" });

		render(<TodayPage />);

		const resume = await screen.findByRole("button", { name: /继续课程/ });
		// A paused course must not offer a learning start: that path is closed.
		expect(screen.queryByRole("button", { name: /开始学习|继续学习/ })).toBeNull();
		fireEvent.click(resume);

		await waitFor(() => expect(coursesApi.resumeCourse).toHaveBeenCalledWith("course_math"));
		// Resuming is status-only: no session is created or opened.
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
		expect(nav.navigate).not.toHaveBeenCalled();
	});
});

/**
 * E4.9f-R1 — the primary-course tier order and the server-owned completion
 * state. These cases render the real page: the component, the store and the
 * i18n resources all participate, so a regression in any of them fails here.
 */
describe("today page — primary course and plan completion (E4.9f-R1)", () => {
	const heroTitle = () => document.querySelector("#today-hero-title")?.textContent ?? "";
	const hero = () => document.querySelector(".mla-today-hero") as HTMLElement;

	const taskItem = (overrides: Record<string, unknown> = {}) => ({
		kind: "task" as const,
		task_id: "task_default",
		title: "默认任务",
		status: "pending" as const,
		order: 0,
		stage_id: null,
		estimated_minutes: 20,
		difficulty: "standard" as const,
		concept_ids: [],
		source_ids: [],
		reason_code: "next_task" as const,
		reason: "这是当前计划的下一项任务。",
		...overrides,
	});

	it("T01 does not let a recently edited paused course take the hero", async () => {
		coursesApi.listCourses.mockResolvedValue([
			course("course_paused", "暂停的课程", {
				status: "paused",
				updated_at: "2026-11-20T00:00:00.000Z",
			}),
			course("course_active", "进行中的课程", { updated_at: "2026-11-01T00:00:00.000Z" }),
		]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 20,
			courses: [dailyCourse("course_active", "进行中的课程", "可执行任务")],
		});

		render(<TodayPage />);

		await waitFor(() => expect(heroTitle()).toBe("可执行任务"));
		expect(within(hero()).queryByText("暂停的课程")).toBeNull();
	});

	it("T02 prefers an in-progress task over a newer course with only a next task", async () => {
		coursesApi.listCourses.mockResolvedValue([
			course("course_a", "课程 A", { updated_at: "2026-11-01T00:00:00.000Z" }),
			course("course_b", "课程 B", { updated_at: "2026-11-20T00:00:00.000Z" }),
		]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 40,
			courses: [
				dailyCourse("course_a", "课程 A", "正在学的任务", {
					items: [taskItem({
						task_id: "task_a",
						title: "正在学的任务",
						status: "in_progress",
						reason_code: "in_progress",
					})],
				}),
				dailyCourse("course_b", "课程 B", "下一个任务", {
					items: [taskItem({ task_id: "task_b", title: "下一个任务" })],
				}),
			],
		});

		render(<TodayPage />);

		await waitFor(() => expect(heroTitle()).toBe("正在学的任务"));
		expect(screen.getAllByRole("button", { name: "继续学习" }).length).toBeGreaterThan(0);
	});

	it("T03 breaks a tie between two executable courses with updated_at, deterministically", async () => {
		coursesApi.listCourses.mockResolvedValue([
			course("course_a", "课程 A", { updated_at: "2026-11-05T00:00:00.000Z" }),
			course("course_b", "课程 B", { updated_at: "2026-11-10T00:00:00.000Z" }),
		]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 40,
			courses: [
				dailyCourse("course_a", "课程 A", "A 的任务", {
					items: [taskItem({ task_id: "task_a", title: "A 的任务" })],
				}),
				dailyCourse("course_b", "课程 B", "B 的任务", {
					items: [taskItem({ task_id: "task_b", title: "B 的任务" })],
				}),
			],
		});

		render(<TodayPage />);

		await waitFor(() => expect(heroTitle()).toBe("B 的任务"));
	});

	it("T04 uses the server's all_completed status and real plan progress", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_ds", "数据结构")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0,
			courses: [dailyCourse("course_ds", "数据结构", "", {
				status: "all_completed",
				items: [],
				task_progress: { total: 12, completed: 12, in_progress: 0, percent: 100 },
			})],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("《数据结构》的当前学习计划已完成")).toBeTruthy());
		expect(screen.getByText("本计划已完成 12 / 12 项任务")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /开始学习|继续学习/ })).toBeNull();
	});

	it("T05 never infers completion from an empty task list", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_ds", "数据结构")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0,
			courses: [dailyCourse("course_ds", "数据结构", "", {
				status: "ok",
				items: [],
				task_progress: { total: 3, completed: 1, in_progress: 0, percent: 33 },
			})],
		});

		render(<TodayPage />);

		await waitFor(() => expect(heroTitle()).toBe("数据结构"));
		expect(screen.queryByText(/当前学习计划已完成/)).toBeNull();
		expect(screen.queryByText(/本计划已完成/)).toBeNull();
		expect(screen.getByText("当前没有可继续的任务。打开课程查看后续安排。")).toBeTruthy();
	});

	it("T06 keeps the review entry when a completed plan still has due reviews", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_ds", "数据结构")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0,
			courses: [dailyCourse("course_ds", "数据结构", "", {
				status: "all_completed",
				items: [],
				task_progress: { total: 2, completed: 2, in_progress: 0, percent: 100 },
			})],
		});
		learnerApi.getLearnerProfile.mockResolvedValue({
			...profile,
			knowledge_states: [{
				concept_id: "concept_due",
				concept_name: "梯度下降",
				domain: "机器学习",
				mastery: 0.4,
				confidence: 0.5,
				stability: 0.3,
				review_due_at: "2026-11-01T00:00:00.000Z",
				evidence_ids: ["ev_1"],
				diagnosis: "需要复习",
				next_actions: [],
				origin: "derived",
				provenance_unknown: false,
			}],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("梯度下降")).toBeTruthy());
		expect(screen.getByRole("button", { name: "开始复习" })).toBeTruthy();
		expect(screen.getByText("当前有 1 个知识点到期，可继续复习。")).toBeTruthy();
	});

	it("T07 offers plan creation when the course has no active plan", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0,
			courses: [dailyCourse("course_math", "高等数学", "", {
				status: "no_active_plan",
				plan: null,
				items: [],
				task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 },
			})],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("还没有学习计划")).toBeTruthy());
		expect(screen.getByRole("button", { name: /去制定计划/ })).toBeTruthy();
	});

	it("T07b distinguishes an active plan with no tasks from a completed plan", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0,
			courses: [dailyCourse("course_math", "高等数学", "", {
				status: "empty_plan",
				items: [],
				task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 },
			})],
		});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("计划中没有任务")).toBeTruthy());
		expect(screen.queryByText(/当前学习计划已完成/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /查看课程计划/ }));
		expect(nav.navigate).toHaveBeenCalledWith("course", {
			history: "push", course: { id: "course_math", view: "plan" },
		});
	});

	it("T09 disables every start button and issues one request on a double click", async () => {
		coursesApi.listCourses.mockResolvedValue([
			course("course_a", "课程 A"),
			course("course_b", "课程 B"),
		]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 40,
			courses: [
				dailyCourse("course_a", "课程 A", "A 的任务"),
				dailyCourse("course_b", "课程 B", "B 的任务"),
			],
		});
		coursesApi.startCourseLearning.mockReturnValue(new Promise(() => undefined));

		render(<TodayPage />);
		await waitFor(() => expect(heroTitle()).toBe("A 的任务"));

		const startButtons = screen.getAllByRole("button", { name: /开始学习|继续学习/ });
		fireEvent.click(startButtons[0]!);
		fireEvent.click(startButtons[0]!);

		await waitFor(() => expect(coursesApi.startCourseLearning).toHaveBeenCalledTimes(1));
		await waitFor(() => {
			for (const button of screen.getAllByRole("button", { name: /开始学习|继续学习/ })) {
				expect((button as HTMLButtonElement).disabled).toBe(true);
			}
		});
		expect((screen.getByRole("button", { name: "创建课程" }) as HTMLButtonElement).disabled).toBe(true);
		for (const trigger of screen.getAllByRole("button", { name: /更多操作/ })) {
			expect((trigger as HTMLButtonElement).disabled).toBe(true);
		}
	});

	it("T12 retries with the original course, task and request id", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 25,
			courses: [dailyCourse("course_python", "Python 编程", "理解装饰器")],
		});
		coursesApi.startCourseLearning
			.mockRejectedValueOnce(Object.assign(new Error("learning_unavailable"), {
				status: 503,
				data: { error: "learning_unavailable" },
			}))
			.mockResolvedValueOnce({
				request_id: "r_retry",
				session: { session_id: "s_retry.jsonl", active: true, created: true, resumed: false },
				course: { course_id: "course_python", title: "Python 编程", status: "in_progress" },
				task: null,
				goal_id: null,
				learning: { created: true, checkpoint: null },
				context_ready: true,
				warnings: [],
			});

		render(<TodayPage />);
		await waitFor(() => expect(heroTitle()).toBe("理解装饰器"));
		fireEvent.click(screen.getByRole("button", { name: "开始学习" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "重试" })).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith("learn", {
			history: "push", session: "s_retry.jsonl",
		}));

		const calls = coursesApi.startCourseLearning.mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[1]![0]).toBe(calls[0]![0]);
		expect(calls[1]![1].task_id).toBe(calls[0]![1].task_id);
		expect(calls[1]![1].request_id).toBe(calls[0]![1].request_id);
	});

	it("T13 does not blame a session failure for another write's error", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 25,
			courses: [dailyCourse("course_python", "Python 编程", "理解装饰器")],
		});
		coursesApi.startCourseLearning.mockRejectedValue(
			Object.assign(new Error("learning_unavailable"), { status: 503, data: { error: "learning_unavailable" } }),
		);
		coursesApi.archiveCourse.mockRejectedValue(new Error("io_error"));

		render(<TodayPage />);
		await waitFor(() => expect(heroTitle()).toBe("理解装饰器"));
		fireEvent.click(screen.getByRole("button", { name: "开始学习" }));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("没能建立学习会话"));

		const trigger = screen.getByRole("button", { name: "更多操作：Python 编程" });
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
		await waitFor(() => expect(screen.getByText("归档课程")).toBeTruthy());
		fireEvent.click(screen.getByText("归档课程"));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("操作未完成"));
		expect(screen.getByRole("alert").textContent).not.toContain("没能建立学习会话");
		expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
	});

	it("T15 keeps the course list but reports a daily-plan failure with a retry", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans
			.mockRejectedValueOnce(Object.assign(new Error("daily_unavailable"), { status: 503 }))
			.mockResolvedValueOnce({
				as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 25,
				courses: [dailyCourse("course_python", "Python 编程", "理解装饰器")],
			});

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("今日计划加载失败")).toBeTruthy());
		expect(screen.queryByText("还没有课程")).toBeNull();
		expect(screen.getByText("今日学习计划暂时不可用，请稍后重试。你的课程与学习记录没有丢失。")).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
		fireEvent.click(screen.getByRole("button", { name: "重试" }));

		await waitFor(() => expect(coursesApi.getDailyPlans).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(heroTitle()).toBe("理解装饰器"));
	});

	it("T16b switches the daily-plan error copy in place", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.getDailyPlans.mockRejectedValue(
			Object.assign(new Error("learning_unavailable"), { status: 503, data: { error: "learning_unavailable" } }),
		);

		render(<TodayPage />);
		await waitFor(() => expect(screen.getByText("今日计划加载失败")).toBeTruthy());
		expect(screen.getByText("今日学习计划暂时不可用，请稍后重试。你的课程与学习记录没有丢失。")).toBeTruthy();

		await act(async () => {
			await i18n.changeLanguage("en");
		});
		expect(screen.getByText("Could not load today's plan")).toBeTruthy();
		expect(screen.getByText("Today's learning plan is temporarily unavailable. Your courses and records are safe; try again shortly.")).toBeTruthy();

		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(screen.getByText("今日计划加载失败")).toBeTruthy();
	});

	it("T16 switches the completion copy in place between Chinese and English", async () => {
		coursesApi.listCourses.mockResolvedValue([course("course_ds", "数据结构")]);
		coursesApi.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, total_planned_minutes: 0,
			courses: [dailyCourse("course_ds", "数据结构", "", {
				status: "all_completed",
				items: [],
				task_progress: { total: 12, completed: 12, in_progress: 0, percent: 100 },
			})],
		});

		render(<TodayPage />);
		await waitFor(() => expect(screen.getByText("《数据结构》的当前学习计划已完成")).toBeTruthy());

		await act(async () => {
			await i18n.changeLanguage("en");
		});
		expect(screen.getByText("数据结构: current learning plan complete")).toBeTruthy();
		expect(screen.getByText("12 / 12 plan tasks complete")).toBeTruthy();

		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(screen.getByText("《数据结构》的当前学习计划已完成")).toBeTruthy();
	});
});
