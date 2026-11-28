// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./ProfilePage.js";
import { coursesStore } from "../../stores/courses-store.js";
import { ApiError } from "../../api/client.js";

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

/**
 * E4.9i-P2-7 (T03) — scope isolation when the same concept exists everywhere.
 *
 * The three scopes are three independent reads: the global profile comes from
 * `learnerStore`, a course view from `GET /api/courses/:id/learner`. They share
 * a `concept_id` on purpose here, because that is the shape that would expose
 * a merge: one row per concept per scope, with that scope's state, origin,
 * evidence count and diagnosis.
 *
 * The page itself never filters or merges — the server does. These cases pin
 * that the *page* never re-introduces a cross-scope value: no global fallback
 * for a missing course record, no stale course data after a switch, no late
 * response overwriting the current scope.
 */
describe("profile page — course scope isolation (P2-7)", () => {
	const CONCEPT_ID = "concept_01";

	const globalProfile = () => ({
		learner_id: "default",
		version: 4,
		updated_at: "2026-11-01T00:00:00.000Z",
		goals: [{
			goal_id: "goal_global", title: "全局目标", type: "skill", status: "active",
			priority: 0.5, success_criteria: [], source: "user_declared",
			updated_at: "2026-11-01T00:00:00.000Z",
		}],
		knowledge_states: [{
			concept_id: CONCEPT_ID, concept_name: "同义替换（全部课程）", domain: "cet4",
			mastery: 0.5, confidence: 0.5, stability: 0.5,
			evidence_ids: ["g1", "g2", "g3"], diagnosis: "全局诊断",
			next_actions: ["全局建议"], origin: "manual", provenance_unknown: false,
			state_label: "learning",
		}],
		misconceptions: [],
		preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
		profile_summary: "全局摘要",
	});

	const courseView = (patch: {
		id: string; title: string; goalTitle: string; name: string;
		state: string; mastery: number; origin: string;
		provenanceUnknown?: boolean; evidence: string[];
		diagnosis: string; suggestion: string;
	}) => ({
		course: {
			course_id: patch.id, title: patch.title, description: "",
			status: "in_progress", created_at: "", updated_at: "",
		},
		goals: [{
			goal_id: `goal_${patch.id}`, title: patch.goalTitle, status: "active",
			success_criteria: [], course_id: patch.id,
		}],
		knowledge_states: [{
			concept_id: CONCEPT_ID, concept_name: patch.name, domain: "cet4",
			mastery: patch.mastery, confidence: 0.6, stability: 0.6,
			evidence_ids: patch.evidence, diagnosis: patch.diagnosis,
			next_actions: [patch.suggestion], origin: patch.origin,
			provenance_unknown: patch.provenanceUnknown ?? false,
			state_label: patch.state,
		}],
		preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
		unclassified: { knowledge_states: 0, goals: 0 },
	});

	const viewA = () => courseView({
		id: "course_a", title: "课程 A", goalTitle: "A 课程目标", name: "同义替换（A）",
		state: "stable", mastery: 0.9, origin: "derived",
		evidence: ["a1", "a2", "a3", "a4", "a5"],
		diagnosis: "A课程诊断", suggestion: "A课程建议",
	});

	const viewB = () => courseView({
		id: "course_b", title: "课程 B", goalTitle: "B 课程目标", name: "同义替换（B）",
		state: "review_due", mastery: 0.3, origin: "legacy",
		provenanceUnknown: true, evidence: ["b1", "b2"],
		diagnosis: "B课程诊断", suggestion: "B课程建议",
	});

	/** Two courses plus the shared profile; every test starts from 全部课程. */
	function prepareScopes() {
		coursesApi.listCourses.mockResolvedValue([course("course_a", "课程 A"), course("course_b", "课程 B")]);
		coursesApi.getCourseLearner.mockImplementation(async (id: string) =>
			id === "course_b" ? viewB() : viewA());
		learnerApi.getLearnerProfile.mockResolvedValue(globalProfile());
	}

	/** The scope trigger; each switch opens the listbox itself. */
	async function scopeTrigger(): Promise<HTMLElement> {
		return screen.findByLabelText("选择学习档案范围");
	}

	async function selectScope(trigger: HTMLElement, name: string) {
		openSelect(trigger);
		fireEvent.click(await screen.findByRole("option", { name }));
	}

	it("C01 — opening 全部课程 shows the global record", async () => {
		prepareScopes();
		render(<ProfilePage />);

		await waitFor(() => expect(screen.getByText("全局目标")).toBeTruthy());
		expect(screen.getAllByText("同义替换（全部课程）").length).toBeGreaterThan(0);
		expect(screen.queryByText("同义替换（A）")).toBeNull();
		expect(screen.queryByText("同义替换（B）")).toBeNull();
	});

	it("C02 — switching to A shows only A's record", async () => {
		prepareScopes();
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");

		await waitFor(() => expect(screen.getByText("同义替换（A）")).toBeTruthy());
		expect(screen.queryByText("同义替换（全部课程）")).toBeNull();
		expect(screen.queryByText("全局目标")).toBeNull();
		expect(screen.getByText("A课程诊断")).toBeTruthy();
	});

	it("C03 — A→B leaves nothing of A behind", async () => {
		prepareScopes();
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");
		await waitFor(() => expect(screen.getByText("A课程诊断")).toBeTruthy());

		await selectScope(trigger, "课程 B");
		await waitFor(() => expect(screen.getByText("B课程诊断")).toBeTruthy());

		expect(screen.queryByText("同义替换（A）")).toBeNull();
		expect(screen.queryByText("A课程诊断")).toBeNull();
		expect(screen.queryByText("A 课程目标")).toBeNull();
		// B's review_due state must not inherit A's 稳定 badge. The filter row
		// also renders the word 稳定, so the assertion reads the badges.
		const badgeLabels = [...document.querySelectorAll(".mla-badge")].map((b) => b.textContent?.trim());
		expect(badgeLabels).not.toContain("稳定");
	});

	it("C04 — B→全部课程 restores the global record", async () => {
		prepareScopes();
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 B");
		await waitFor(() => expect(screen.getByText("B课程诊断")).toBeTruthy());

		await selectScope(trigger, "全部课程");
		await waitFor(() => expect(coursesStore.selectedCourseId).toBeNull());

		expect(screen.getByText("全局目标")).toBeTruthy();
		expect(screen.queryByText("同义替换（B）")).toBeNull();
	});

	it("C05 — the same concept_id is not merged across scopes", async () => {
		prepareScopes();
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");
		await waitFor(() => expect(screen.getByText("同义替换（A）")).toBeTruthy());

		// One row in this scope, with A's own numbers — not three rows, not the
		// global evidence list appended to A's.
		expect(document.querySelectorAll(".mla-course-knowledge-row")).toHaveLength(1);
		expect(screen.getByText("证据标识 5 个")).toBeTruthy();
		expect(screen.queryByText("证据标识 8 个")).toBeNull();
	});

	it("C06 — filter counts come from the visible scope, not from the other one", async () => {
		prepareScopes();
		render(<ProfilePage />);
		await waitFor(() => expect(screen.getByText("全局目标")).toBeTruthy());

		// Global: one learning concept => needs attention, not stable.
		expect(screen.getByRole("button", { name: /^需要关注\s*1$/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^稳定\s*0$/ })).toBeTruthy();

		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");
		await waitFor(() => expect(screen.getByText("同义替换（A）")).toBeTruthy());

		expect(screen.getByRole("button", { name: /^稳定\s*1$/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^需要关注\s*0$/ })).toBeTruthy();

		await selectScope(trigger, "课程 B");
		await waitFor(() => expect(screen.getAllByText("同义替换（B）").length).toBeGreaterThan(0));

		expect(screen.getByRole("button", { name: /^待复习\s*1$/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^稳定\s*0$/ })).toBeTruthy();
	});

	it("C07 — origin labels are the scope's own, including its unknown-source flag", async () => {
		prepareScopes();
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");
		await waitFor(() => expect(screen.getByText("同义替换（A）")).toBeTruthy());
		expect(screen.getByText("系统推导")).toBeTruthy();
		expect(screen.queryByText("来源不明")).toBeNull();

		await selectScope(trigger, "课程 B");
		await waitFor(() => expect(screen.getAllByText("同义替换（B）").length).toBeGreaterThan(0));
		expect(screen.getByText("历史记录")).toBeTruthy();
		expect(screen.getByText("来源不明")).toBeTruthy();
		// A's derived label must not survive the switch.
		expect(screen.queryByText("系统推导")).toBeNull();
	});

	it("C08 — evidence counts are never backfilled from the global record", async () => {
		prepareScopes();
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 B");
		await waitFor(() => expect(screen.getAllByText("同义替换（B）").length).toBeGreaterThan(0));

		expect(screen.getByText("证据标识 2 个")).toBeTruthy();
		expect(screen.queryByText("证据标识 3 个")).toBeNull();
	});

	it("C09 — an empty course shows its own empty state, not other scopes' data", async () => {
		prepareScopes();
		const empty = { ...viewA(), goals: [], knowledge_states: [] };
		coursesApi.getCourseLearner.mockImplementation(async (id: string) =>
			id === "course_a" ? empty : viewB());
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");

		await waitFor(() => expect(screen.getByText("课程 A")).toBeTruthy());
		expect(screen.getByText("这门课程还没有带证据的知识点。完成练习或学习对话后，这里会显示服务端记录的掌握状态。")).toBeTruthy();
		expect(screen.queryByText("同义替换（全部课程）")).toBeNull();
		expect(screen.queryByText("同义替换（A）")).toBeNull();
	});

	it("C10 — a failed course read renders an error, not a fabricated success", async () => {
		prepareScopes();
		coursesApi.getCourseLearner.mockImplementation(async (id: string) => {
			if (id === "course_a") throw new ApiError(500, "服务端暂时不可用");
			return viewB();
		});
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");

		await waitFor(() => {
			const alert = [...document.querySelectorAll("p")].find((el) =>
				(el.getAttribute("style") ?? "").includes("danger"));
			expect(alert).toBeTruthy();
		});
		expect(screen.queryByRole("heading", { name: "知识掌握" })).toBeNull();
		expect(screen.queryByText("稳定")).toBeNull();
		expect(screen.queryByText("同义替换（全部课程）")).toBeNull();
	});

	it("C11 — a late response for the previous course cannot overwrite the current one", async () => {
		prepareScopes();
		let resolveA: (value: ReturnType<typeof viewA>) => void = () => undefined;
		const pendingA = new Promise<ReturnType<typeof viewA>>((resolve) => { resolveA = resolve; });
		coursesApi.getCourseLearner.mockImplementation(async (id: string) => {
			if (id === "course_a") return pendingA;
			return viewB();
		});

		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");
		// A is still in flight; leave before it answers.
		await selectScope(trigger, "课程 B");
		await waitFor(() => expect(screen.getByText("B课程诊断")).toBeTruthy());

		await act(async () => { resolveA(viewA()); });
		await waitFor(() => expect(screen.getByText("B课程诊断")).toBeTruthy());
		expect(screen.queryByText("同义替换（A）")).toBeNull();
		expect(screen.queryByText("A课程诊断")).toBeNull();
	});

	it("C12 — the course-scoped view stays read-only", async () => {
		prepareScopes();
		render(<ProfilePage />);
		const trigger = await scopeTrigger();
		await selectScope(trigger, "课程 A");
		await waitFor(() => expect(screen.getByText("同义替换（A）")).toBeTruthy());

		// The global profile view offers 编辑; the course view must not, and must
		// not mount any editor that could write a course's record.
		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(document.querySelectorAll("textarea")).toHaveLength(0);
		expect(document.querySelectorAll("input")).toHaveLength(0);
	});
});
