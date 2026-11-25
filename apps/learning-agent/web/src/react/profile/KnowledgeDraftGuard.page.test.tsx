// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { ProfilePage } from "../pages/ProfilePage.js";
import { learnerStore } from "../../stores/learner-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { KnowledgeState, LearnerProfile } from "../../types/learner.js";

/**
 * E4.9i-P2-2-R1 — the two page-level exits.
 *
 * The row's own exits are covered in `KnowledgeDraftGuard.test.tsx`; these
 * cases cover the paths that unmount the editor from above: collapsing the
 * whole 知识状态 section, and changing the course range in the page header.
 */

const learnerApi = vi.hoisted(() => ({
	getLearnerProfile: vi.fn(),
	patchLearnerProfile: vi.fn(),
	updateKnowledge: vi.fn(),
	getLearningRecommendations: vi.fn(),
}));

vi.mock("../../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learner.js")>("../../api/learner.js");
	return { ...actual, ...learnerApi };
});

const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getCourseLearner: vi.fn(),
	getDailyPlans: vi.fn(),
}));

vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...coursesApi };
});

const knowledge = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
	concept_name: patch.concept_id,
	domain: "cet4",
	mastery: 0.5,
	confidence: 0.5,
	stability: 0.5,
	evidence_ids: [],
	diagnosis: "诊断文本",
	next_actions: [],
	...patch,
});

const profile = (states: KnowledgeState[]): LearnerProfile => ({
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-01T00:00:00.000Z",
	goals: [],
	knowledge_states: states,
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
});

const course = (id: string, title: string) => ({
	course_id: id, title, description: "", status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 0, tasks: 0, sessions: 0, sources: 0 },
});

const learnerView = (id: string, title: string) => ({
	course: { course_id: id, title, description: "", status: "in_progress", created_at: "", updated_at: "" },
	goals: [],
	knowledge_states: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	unclassified: { knowledge_states: 0, goals: 0 },
});

function stubRadixSelect() {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => undefined;
	Element.prototype.releasePointerCapture = () => undefined;
	Element.prototype.scrollIntoView = () => undefined;
}

/** Start editing the first knowledge row, with a changed diagnosis. */
async function openDirtyEditor() {
	const row = screen.getByText("c1").closest("button")!;
	fireEvent.click(row);
	const edit = await screen.findByRole("button", { name: "编辑" });
	fireEvent.click(edit);
	fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "未保存草稿" } });
	return row;
}

beforeEach(async () => {
	vi.clearAllMocks();
	stubRadixSelect();
	learnerStore.profile = null;
	learnerStore.isSaving = false;
	learnerStore.isLoading = false;
	coursesStore.reset();
	learnerApi.getLearningRecommendations.mockResolvedValue({ recommendations: [], generated_at: "" });
	learnerApi.getLearnerProfile.mockImplementation(async () => learnerStore.profile ?? profile([]));
	learnerApi.updateKnowledge.mockImplementation(async (conceptId: string, patch: Partial<KnowledgeState>) =>
		knowledge({ concept_id: conceptId, ...patch }));
	coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程"), course("course_math", "高等数学")]);
	coursesApi.getCourseLearner.mockImplementation(async (id: string) =>
		id === "course_math" ? learnerView("course_math", "高等数学") : learnerView("course_python", "Python 编程"));
	coursesApi.getDailyPlans.mockResolvedValue({ date: "2026-11-24", daily_minutes: 30, courses: [], notes: [] });
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("R1 — section collapse", () => {
	it("G08 asks before collapsing the section with a dirty editor", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor();

		fireEvent.click(screen.getByRole("button", { name: /知识状态/ }));

		expect(confirm).toHaveBeenCalledOnce();
	});

	it("G09 keeps the section open and the draft intact when the discard is refused", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor();

		fireEvent.click(screen.getByRole("button", { name: /知识状态/ }));

		expect(screen.getByRole("button", { name: /知识状态/ }).getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByDisplayValue("未保存草稿")).toBeTruthy();
	});

	it("collapses an unchanged section without asking", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);

		fireEvent.click(screen.getByRole("button", { name: /知识状态/ }));

		expect(confirm).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /知识状态/ }).getAttribute("aria-expanded")).toBe("false");
	});

	it("G15 refuses the section collapse while a save is in flight", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		let resolveSave: () => void = () => {};
		learnerApi.updateKnowledge.mockImplementationOnce(() => new Promise((resolve) => {
			resolveSave = () => resolve(knowledge({ concept_id: "c1" }));
		}));
		render(<ProfilePage />);
		await openDirtyEditor();

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalled());

		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		fireEvent.click(screen.getByRole("button", { name: /知识状态/ }));

		expect(confirm).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /知识状态/ }).getAttribute("aria-expanded")).toBe("true");

		await act(async () => { resolveSave(); });
	});
});

describe("R1 — course scope switch", () => {
	async function switchTo(title: string) {
		const trigger = screen.getByLabelText("选择学习档案范围");
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		fireEvent.click(await screen.findByRole("option", { name: title }));
	}

	it("G11 refuses the switch and keeps the draft when the discard is declined", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor();

		await switchTo("高等数学");

		expect(confirm).toHaveBeenCalledOnce();
		expect(coursesStore.selectedCourseId).toBeNull();
		expect(screen.getByDisplayValue("未保存草稿")).toBeTruthy();
		expect(coursesApi.getCourseLearner).not.toHaveBeenCalled();
	});

	it("G12 switches normally once the discard is confirmed", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ProfilePage />);
		await openDirtyEditor();

		await switchTo("高等数学");

		await waitFor(() => expect(coursesStore.selectedCourseId).toBe("course_math"));
		expect(screen.queryByDisplayValue("未保存草稿")).toBeNull();
		// Discarding never saves.
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
	});

	it("G13 keeps the Select on the original course after a refusal", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor();

		await switchTo("高等数学");

		expect(coursesStore.selectedCourseId).toBeNull();
		const trigger = screen.getByLabelText("选择学习档案范围");
		expect(trigger.textContent).toContain("全部课程");
	});

	it("G16 refuses the switch while a save is in flight", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		let resolveSave: () => void = () => {};
		learnerApi.updateKnowledge.mockImplementationOnce(() => new Promise((resolve) => {
			resolveSave = () => resolve(knowledge({ concept_id: "c1" }));
		}));
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ProfilePage />);
		await openDirtyEditor();

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalled());

		await switchTo("高等数学");

		expect(confirm).not.toHaveBeenCalled();
		expect(coursesStore.selectedCourseId).toBeNull();
		expect(screen.getByRole("slider")).toBeTruthy();

		await act(async () => { resolveSave(); });
	});

	it("switches freely when nothing is being edited", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);

		await switchTo("高等数学");

		expect(confirm).not.toHaveBeenCalled();
		await waitFor(() => expect(coursesStore.selectedCourseId).toBe("course_math"));
	});

	it("G22 keeps the course view read-only", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		coursesStore.selectCourse("course_math");
		render(<ProfilePage />);

		await waitFor(() => expect(screen.queryByRole("heading", { name: "知识掌握" })).toBeTruthy());
		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
	});
});
