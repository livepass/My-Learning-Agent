// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./ProfilePage.js";
import { coursesStore } from "../../stores/courses-store.js";

/**
 * E4.5e: the profile page can scope itself to one course.
 *
 * Regression guard: choosing a course used to leave the body empty. The page
 * kept its own `courseId` state while `coursesStore` drops every course-scoped
 * read whose id is not `selectedCourseId`, so the panel mounted, issued the
 * request, and then discarded the response. The page must drive the store's
 * selection instead.
 */

const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getCourseLearner: vi.fn(),
	getDailyPlans: vi.fn(),
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

const course = (id: string, title: string) => ({
	course_id: id,
	title,
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 1, plans: 1, tasks: 2, sessions: 0, sources: 1 },
});

const learnerView = (id: string, title: string) => ({
	course: { course_id: id, title, description: "", status: "in_progress", created_at: "", updated_at: "" },
	goals: [{
		goal_id: `goal_${id}`, title: `${title} 的目标`, status: "active",
		success_criteria: [], course_id: id,
	}],
	knowledge_states: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	unclassified: { knowledge_states: 0, goals: 0 },
});

/** Radix Select needs these in jsdom; the pattern matches the UI tests. */
function stubRadixSelect() {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => undefined;
	Element.prototype.releasePointerCapture = () => undefined;
	Element.prototype.scrollIntoView = () => undefined;
}

/** Radix opens its listbox from the keyboard, which jsdom can drive. */
function openSelect(trigger: HTMLElement) {
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

beforeEach(() => {
	vi.clearAllMocks();
	stubRadixSelect();
	coursesStore.reset();
	coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程"), course("course_math", "高等数学")]);
	coursesApi.getCourseLearner.mockImplementation(async (id: string) =>
		id === "course_math" ? learnerView("course_math", "高等数学") : learnerView("course_python", "Python 编程"));
	coursesApi.getDailyPlans.mockResolvedValue({ date: "2026-11-08", daily_minutes: 30, courses: [], notes: [] });
	learnerApi.getLearnerProfile.mockResolvedValue({
		profile_version: 1, goals: [], knowledge_states: [], misconceptions: [],
		preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	});
	learnerApi.getLearningRecommendations.mockResolvedValue({ recommendations: [], generated_at: "" });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("profile page — course scope", () => {
	it("renders the selected course's learner view instead of an empty body", async () => {
		render(<ProfilePage />);

		const trigger = await screen.findByLabelText("选择学习档案范围");
		openSelect(trigger);
		const option = await screen.findByRole("option", { name: "高等数学" });
		fireEvent.click(option);

		await waitFor(() => expect(screen.getByText("高等数学 的目标")).toBeTruthy());
		expect(screen.getByText("只显示归属这门课程的学习记录")).toBeTruthy();
		expect(coursesApi.getCourseLearner).toHaveBeenCalledWith("course_math");
		// The page drives the store's single selection instead of keeping a copy.
		expect(coursesStore.selectedCourseId).toBe("course_math");
	});

	it("never shows another course's goal in a course-scoped view", async () => {
		render(<ProfilePage />);

		const trigger = await screen.findByLabelText("选择学习档案范围");
		openSelect(trigger);
		fireEvent.click(await screen.findByRole("option", { name: "高等数学" }));

		await waitFor(() => expect(screen.getByText("高等数学 的目标")).toBeTruthy());
		expect(screen.queryByText("Python 编程 的目标")).toBeNull();
	});

	it("returns to the shared profile when the scope goes back to all courses", async () => {
		render(<ProfilePage />);

		const trigger = await screen.findByLabelText("选择学习档案范围");
		openSelect(trigger);
		fireEvent.click(await screen.findByRole("option", { name: "高等数学" }));
		await waitFor(() => expect(screen.getByText("高等数学 的目标")).toBeTruthy());

		openSelect(trigger);
		fireEvent.click(await screen.findByRole("option", { name: "全部课程" }));

		await waitFor(() => expect(coursesStore.selectedCourseId).toBeNull());
		// The course-scoped panel is gone; the shared profile panel is back.
		expect(screen.queryByText("只显示归属这门课程的学习记录")).toBeNull();
	});
});
