// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayPage } from "./TodayPage.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";

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

const course = (id: string, title: string) => ({
	course_id: id,
	title,
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 3, sessions: 1, sources: 1 },
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

beforeEach(() => {
	vi.clearAllMocks();
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

afterEach(() => {
	cleanup();
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

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("learning_unavailable"));
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
});
