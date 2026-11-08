import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { coursesStore } from "./courses-store.js";

const api = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getCourse: vi.fn(),
	listPlans: vi.fn(),
	getPlanDetail: vi.fn(),
	confirmPlan: vi.fn(),
	getDailyPlans: vi.fn(),
	startCourseLearning: vi.fn(),
	getSessionCourseContext: vi.fn(),
	listCourseSources: vi.fn(),
	getCourseLearner: vi.fn(),
}));

vi.mock("../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../api/courses.js")>("../api/courses.js");
	return { ...actual, ...api };
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const course = (id: string, title: string) => ({
	course_id: id,
	title,
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
});

const plan = (id: string, revision: number, status: "draft" | "active" = "draft") => ({
	plan_id: id,
	course_id: "course_a",
	title: "计划 A",
	description: "",
	goal_id: null,
	status,
	origin: "user" as const,
	revision,
	stage_count: 0,
	task_count: 0,
	completed_task_count: 0,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
});

beforeEach(() => {
	vi.clearAllMocks();
	coursesStore.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("courses store — course switching", () => {
	it("drops a late response for the course the user already left", async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		api.getCourse
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);

		coursesStore.selectCourse("course_a");
		const pendingA = coursesStore.loadDetail("course_a");
		coursesStore.selectCourse("course_b");
		const pendingB = coursesStore.loadDetail("course_b");

		// Course A answers after the switch: it must not paint course B's view.
		first.resolve({ course: course("course_a", "A"), counts: {}, goals: [], plans: [], stages: [], tasks: [], sessions: [], sources: [] });
		await pendingA;
		expect(coursesStore.detail).toBeNull();

		second.resolve({ course: course("course_b", "B"), counts: {}, goals: [], plans: [], stages: [], tasks: [], sessions: [], sources: [] });
		await pendingB;
		expect(coursesStore.detail?.course.course_id).toBe("course_b");
	});

	it("clears every course-scoped fact on select", async () => {
		coursesStore.selectCourse("course_a");
		coursesStore.plans = [plan("plan_1", 1)];
		coursesStore.sources = [{
			binding_id: "b1", course_id: "course_a", source_id: "s1", status: "active",
			created_at: "", updated_at: "", source: null,
		}];
		coursesStore.feedback = { tone: "error", message: "x" };

		coursesStore.selectCourse("course_b");

		expect(coursesStore.plans).toEqual([]);
		expect(coursesStore.sources).toEqual([]);
		expect(coursesStore.planDetail).toBeNull();
		expect(coursesStore.feedback).toBeNull();
	});

	it("keeps the global daily snapshot and the course-scoped one apart", async () => {
		api.getDailyPlans.mockImplementation(async (options: { courseId?: string } = {}) => ({
			as_of: "",
			generated_at: "",
			minutes_override: null,
			total_planned_minutes: 0,
			courses: options.courseId
				? [{ course_id: options.courseId, course_title: options.courseId, status: "ok", daily_minutes: 30, plan: null, other_active_plans: 0, items: [], planned_minutes: 0, task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 }, knowledge: { due_reviews: 0, weak_concepts: 0, stable_concepts: 0, evidence_backed_concepts: 0 }, notes: [] }]
				: [],
		}));

		coursesStore.selectCourse("course_a");
		await coursesStore.loadDaily();
		await coursesStore.loadCourseDaily("course_a");

		expect(coursesStore.daily?.courses).toEqual([]);
		expect(coursesStore.courseDaily?.courses[0]?.course_id).toBe("course_a");
		// The course-scoped read must ask for that course explicitly.
		expect(api.getDailyPlans).toHaveBeenCalledWith({ courseId: "course_a" });
	});
});

describe("courses store — writes", () => {
	it("re-reads the plan after a 409 instead of overwriting the newer revision", async () => {
		coursesStore.selectCourse("course_a");
		api.confirmPlan.mockRejectedValueOnce(new ApiError(409, "course_conflict", {
			error: "course_conflict",
			revision: 7,
		}));
		api.listPlans.mockResolvedValue([plan("plan_1", 7)]);
		api.getPlanDetail.mockResolvedValue({ plan: plan("plan_1", 7), stages: [], tasks: [] });
		api.getDailyPlans.mockResolvedValue({
			as_of: "", generated_at: "", minutes_override: null, courses: [], total_planned_minutes: 0,
		});

		const ok = await coursesStore.confirmPlan("course_a", "plan_1", 3, false);

		expect(ok).toBe(false);
		expect(coursesStore.feedback?.tone).toBe("conflict");
		expect(coursesStore.feedback?.message).toContain("#7");
		// The page now shows the server's current revision.
		expect(coursesStore.plans[0]?.revision).toBe(7);
		expect(api.getPlanDetail).toHaveBeenCalledWith("course_a", "plan_1");
		// It must not retry blindly with the stale revision.
		expect(api.confirmPlan).toHaveBeenCalledTimes(1);
	});

	it("reuses one request id for a retried learning start and creates nothing on failure", async () => {
		coursesStore.selectCourse("course_a");
		api.startCourseLearning
			.mockRejectedValueOnce(new ApiError(503, "learning_unavailable", { error: "learning_unavailable" }))
			.mockResolvedValueOnce({
				request_id: "ignored",
				session: { session_id: "s1.jsonl", active: true, created: true, resumed: false },
				course: { course_id: "course_a", title: "A", status: "in_progress" },
				task: null,
				goal_id: null,
				learning: { created: true, checkpoint: null },
				context_ready: true,
				warnings: [],
			});

		const failed = await coursesStore.startLearning("course_a", "task_1");
		expect(failed).toBeNull();
		expect(coursesStore.feedback?.tone).toBe("error");

		const ok = await coursesStore.startLearning("course_a", "task_1");
		expect(ok?.session.session_id).toBe("s1.jsonl");

		const firstId = api.startCourseLearning.mock.calls[0]![1].request_id;
		const secondId = api.startCourseLearning.mock.calls[1]![1].request_id;
		expect(secondId).toBe(firstId);
	});

	it("uses a fresh request id after a successful start", async () => {
		coursesStore.selectCourse("course_a");
		const result = {
			request_id: "x",
			session: { session_id: "s1.jsonl", active: true, created: true, resumed: false },
			course: { course_id: "course_a", title: "A", status: "in_progress" },
			task: null,
			goal_id: null,
			learning: { created: true, checkpoint: null },
			context_ready: true,
			warnings: [],
		};
		api.startCourseLearning.mockResolvedValue(result);

		await coursesStore.startLearning("course_a", "task_1");
		await coursesStore.startLearning("course_a", "task_1");

		const [first, second] = api.startCourseLearning.mock.calls;
		expect(first![1].request_id).not.toBe(second![1].request_id);
	});

	it("blocks a second write while one is pending", async () => {
		coursesStore.selectCourse("course_a");
		const gate = deferred<unknown>();
		api.confirmPlan.mockReturnValue(gate.promise);
		api.listPlans.mockResolvedValue([]);
		api.getPlanDetail.mockResolvedValue({ plan: plan("plan_1", 2), stages: [], tasks: [] });
		api.getDailyPlans.mockResolvedValue({ as_of: "", generated_at: "", minutes_override: null, courses: [], total_planned_minutes: 0 });

		const first = coursesStore.confirmPlan("course_a", "plan_1", 1, false);
		const second = await coursesStore.confirmPlan("course_a", "plan_1", 1, false);
		expect(second).toBe(false);

		gate.resolve({ plan: plan("plan_1", 2, "active"), alreadyActive: false, archivedPlanIds: [] });
		await first;
	});
});

describe("courses store — session context", () => {
	it("drops a late context response after the conversation changed", async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		api.getSessionCourseContext
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);

		const pendingA = coursesStore.loadSessionContext("a.jsonl");
		const pendingB = coursesStore.loadSessionContext("b.jsonl");

		first.resolve({
			session_id: "a.jsonl", unclassified: false, binding: null,
			course: course("course_a", "A"), task: null, source_ids: [], goal_ids: [],
		});
		await pendingA;
		expect(coursesStore.sessionContexts["a.jsonl"]).toBeUndefined();

		second.resolve({
			session_id: "b.jsonl", unclassified: false, binding: null,
			course: course("course_b", "B"), task: null, source_ids: [], goal_ids: [],
		});
		await pendingB;
		expect(coursesStore.sessionContexts["b.jsonl"]?.context.course?.course_id).toBe("course_b");
	});
});
