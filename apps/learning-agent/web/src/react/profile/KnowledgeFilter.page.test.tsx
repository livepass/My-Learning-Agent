// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { ProfilePage } from "../pages/ProfilePage.js";
import { learnerStore } from "../../stores/learner-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { KnowledgeState, LearnerProfile } from "../../types/learner.js";

/**
 * E4.9i-P2-4 — filter switching against a real profile page.
 *
 * The filter row is the newest exit from a knowledge edit: selecting another
 * state unmounts the rows that no longer match. These cases pin that it takes
 * the same verdict as every other exit (G01–G10), and that the two course
 * scopes keep their own counts and their own filter (I01–I10).
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

const courseView = (states: Array<Record<string, unknown>>) => ({
	course: { course_id: "course_a", title: "同义替换", description: "", status: "in_progress", created_at: "", updated_at: "" },
	goals: [],
	knowledge_states: states.map((state) => ({
		domain: "cet4", mastery: 0.5, confidence: 0.5, stability: 0.5,
		evidence_ids: [], diagnosis: "课程诊断", next_actions: [], ...state,
	})),
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	unclassified: { knowledge_states: 0, goals: 0 },
});

const MIXED = [
	knowledge({ concept_id: "c_stable", concept_name: "稳定项", state_label: "stable" }),
	knowledge({ concept_id: "c_learn", concept_name: "学习中项", state_label: "learning" }),
	knowledge({ concept_id: "c_review", concept_name: "待复习项", state_label: "review_due" }),
	knowledge({ concept_id: "c_unknown", concept_name: "证据不足项", state_label: "unknown" }),
];

function stubRadixSelect() {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => undefined;
	Element.prototype.releasePointerCapture = () => undefined;
	Element.prototype.scrollIntoView = () => undefined;
}

/** The knowledge section collapses itself above five rows. */
function expandKnowledgeSection() {
	const header = screen.getByRole("button", { name: /知识状态|Knowledge/ });
	if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
}

/** Buttons inside the knowledge section only — the weak card repeats names. */
function knowledgeSection(): HTMLElement {
	return screen.getByRole("button", { name: /知识状态|Knowledge/ }).closest("section") as HTMLElement;
}

function filterButton(label: string): HTMLButtonElement {
	const section = knowledgeSection();
	const button = [...section.querySelectorAll("button")].find((b) =>
		b.textContent?.trim().startsWith(label) && b.hasAttribute("aria-pressed"));
	if (!button) throw new Error(`no filter button ${label}`);
	return button as HTMLButtonElement;
}

/** Concept names currently visible in the knowledge list. */
function visibleNames(): string[] {
	return [...knowledgeSection().querySelectorAll("button[aria-expanded]")]
		.map((button) => button.textContent ?? "")
		.filter((text) => /项$/.test(text.split("cet4")[0] ?? ""))
		.map((text) => text.split("cet4")[0]!.trim());
}

async function openDirtyEditor(conceptName: string) {
	expandKnowledgeSection();
	const row = [...knowledgeSection().querySelectorAll("button[aria-expanded]")]
		.find((button) => button.textContent?.includes(conceptName)) as HTMLElement;
	fireEvent.click(row);
	fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
	fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "未保存草稿" } });
}

async function switchTo(title: string) {
	const trigger = screen.getByLabelText("选择学习档案范围");
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
	fireEvent.click(await screen.findByRole("option", { name: title }));
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
	coursesApi.listCourses.mockResolvedValue([course("course_a", "同义替换"), course("course_b", "高等数学")]);
	coursesApi.getCourseLearner.mockImplementation(async (id: string) =>
		id === "course_b"
			? courseView([{ concept_id: "b1", concept_name: "课程B概念", state_label: "stable" }])
			: courseView([
				{ concept_id: "a1", concept_name: "课程A概念", state_label: "learning" },
				{ concept_id: "a2", concept_name: "课程A稳定", state_label: "stable" },
			]));
	coursesApi.getDailyPlans.mockResolvedValue({ date: "2026-11-24", daily_minutes: 30, courses: [], notes: [] });
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("P2-4 — filter switching and draft protection", () => {
	it("G01 switches with no draft without asking", async () => {
		learnerStore.profile = profile(MIXED);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		expandKnowledgeSection();

		fireEvent.click(filterButton("稳定"));

		expect(confirm).not.toHaveBeenCalled();
		expect(filterButton("稳定").getAttribute("aria-pressed")).toBe("true");
	});

	it("G02 asks once when a dirty draft would be unmounted", async () => {
		learnerStore.profile = profile(MIXED);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");

		fireEvent.click(filterButton("稳定"));

		expect(confirm).toHaveBeenCalledOnce();
	});

	it("G03 keeps the filter, the editor and the draft when the switch is refused", async () => {
		learnerStore.profile = profile(MIXED);
		vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");

		fireEvent.click(filterButton("稳定"));

		expect(filterButton("全部").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByDisplayValue("未保存草稿")).toBeTruthy();
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("G04 switches once the discard is confirmed", async () => {
		learnerStore.profile = profile(MIXED);
		vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");

		fireEvent.click(filterButton("稳定"));

		expect(filterButton("稳定").getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByDisplayValue("未保存草稿")).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
		// Discarding never saves.
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
	});

	it("G05 asks once for two dirty drafts, not once per row", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "甲项", state_label: "learning", diagnosis: "甲诊断" }),
			knowledge({ concept_id: "c2", concept_name: "乙项", state_label: "fragile", diagnosis: "乙诊断" }),
		]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		expandKnowledgeSection();
		for (const [name, diagnosis] of [["甲项", "甲诊断"], ["乙项", "乙诊断"]] as const) {
			const row = [...knowledgeSection().querySelectorAll("button[aria-expanded]")]
				.find((button) => button.textContent?.includes(name)) as HTMLElement;
			fireEvent.click(row);
			const editButtons = [...row.parentElement!.querySelectorAll("button")]
				.filter((button) => button.textContent?.trim() === "编辑");
			fireEvent.click(editButtons[editButtons.length - 1]!);
			fireEvent.change(screen.getByDisplayValue(diagnosis), { target: { value: `${diagnosis}草稿` } });
		}

		fireEvent.click(filterButton("稳定"));

		expect(confirm).toHaveBeenCalledOnce();
	});

	it("G06 refuses the switch while a save is in flight, without a confirm", async () => {
		learnerStore.profile = profile(MIXED);
		let resolveSave: () => void = () => {};
		learnerApi.updateKnowledge.mockImplementationOnce(() => new Promise((resolve) => {
			resolveSave = () => resolve(knowledge({ concept_id: "c_learn", concept_name: "学习中项", state_label: "learning" }));
		}));
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalled());

		fireEvent.click(filterButton("稳定"));

		expect(confirm).not.toHaveBeenCalled();
		expect(filterButton("全部").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("slider")).toBeTruthy();

		await act(async () => { resolveSave(); });
	});

	it("G07 switches freely after a successful save", async () => {
		learnerStore.profile = profile(MIXED);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalled());
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());

		fireEvent.click(filterButton("稳定"));
		expect(filterButton("稳定").getAttribute("aria-pressed")).toBe("true");
	});

	it("G08 keeps the failed draft protected after a failed save", async () => {
		learnerStore.profile = profile(MIXED);
		learnerApi.updateKnowledge.mockRejectedValueOnce(new Error("网络中断"));
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await screen.findByRole("alert");

		fireEvent.click(filterButton("稳定"));

		expect(confirm).toHaveBeenCalledOnce();
		expect(screen.getByDisplayValue("未保存草稿")).toBeTruthy();
	});

	it("G10 does not ask when the current filter is selected again", async () => {
		learnerStore.profile = profile(MIXED);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");

		fireEvent.click(filterButton("全部"));

		expect(confirm).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue("未保存草稿")).toBeTruthy();
	});
});

describe("P2-4 — filters across the two course scopes", () => {
	it("I01 filters the all-courses list", async () => {
		learnerStore.profile = profile(MIXED);
		render(<ProfilePage />);
		expandKnowledgeSection();

		expect(visibleNames()).toEqual(["稳定项", "学习中项", "待复习项", "证据不足项"]);
		fireEvent.click(filterButton("待复习"));
		expect(visibleNames()).toEqual(["待复习项"]);
	});

	it("I02 filters the course-scoped list", async () => {
		coursesStore.selectCourse("course_a");
		render(<ProfilePage />);
		await screen.findByRole("heading", { name: "知识掌握" });

		const section = screen.getByRole("heading", { name: "知识掌握" }).closest("section")!;
		const chip = (label: string) => [...section.querySelectorAll("button")]
			.find((b) => b.textContent?.trim().startsWith(label) && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
		fireEvent.click(chip("稳定"));

		const rows = [...section.querySelectorAll(".mla-state-row strong")].map((n) => n.textContent);
		expect(rows).toEqual(["课程A稳定"]);
	});

	it("I03 keeps the two scopes' counts isolated", async () => {
		learnerStore.profile = profile(MIXED);
		coursesStore.selectCourse("course_a");
		render(<ProfilePage />);
		await screen.findByRole("heading", { name: "知识掌握" });

		const section = screen.getByRole("heading", { name: "知识掌握" }).closest("section")!;
		const allChip = [...section.querySelectorAll("button")]
			.find((b) => b.textContent?.trim().startsWith("全部"))!;
		// The course list has two concepts, not the profile's four.
		expect(allChip.textContent).toContain("2");
	});

	it("I04 keeps the course view read-only", async () => {
		coursesStore.selectCourse("course_a");
		render(<ProfilePage />);
		await screen.findByRole("heading", { name: "知识掌握" });

		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
	});

	it("I05 resets the filter to 全部 after a successful course switch", async () => {
		learnerStore.profile = profile(MIXED);
		render(<ProfilePage />);
		await switchTo("同义替换");
		await screen.findByRole("heading", { name: "知识掌握" });

		let section = screen.getByRole("heading", { name: "知识掌握" }).closest("section")!;
		const chip = (label: string) => [...section.querySelectorAll("button")]
			.find((b) => b.textContent?.trim().startsWith(label) && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
		fireEvent.click(chip("稳定"));
		expect(chip("稳定").getAttribute("aria-pressed")).toBe("true");

		await switchTo("高等数学");
		await waitFor(() => expect(screen.getByText("课程B概念")).toBeTruthy());

		section = screen.getByRole("heading", { name: "知识掌握" }).closest("section")!;
		const allChip = [...section.querySelectorAll("button")]
			.find((b) => b.textContent?.trim().startsWith("全部"))!;
		expect(allChip.getAttribute("aria-pressed")).toBe("true");
	});

	it("I06 keeps the filter when a course switch is refused", async () => {
		learnerStore.profile = profile(MIXED);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		await openDirtyEditor("学习中项");
		fireEvent.click(filterButton("全部"));

		await switchTo("高等数学");

		expect(confirm).toHaveBeenCalled();
		expect(coursesStore.selectedCourseId).toBeNull();
		expect(screen.getByDisplayValue("未保存草稿")).toBeTruthy();
	});

	it("I07 leaves the overview conclusion unchanged when filtering", async () => {
		learnerStore.profile = profile(MIXED);
		render(<ProfilePage />);
		// The mount read must settle before the conclusion is drawn (P2-3).
		const before = (await screen.findByText(/共记录 4 个知识点/)).textContent;
		expandKnowledgeSection();

		fireEvent.click(filterButton("稳定"));

		expect(screen.getByText(/共记录 4 个知识点/).textContent).toBe(before);
	});

	it("I08 leaves the weak-knowledge card unchanged when filtering", async () => {
		learnerStore.profile = profile(MIXED);
		render(<ProfilePage />);
		await screen.findByText(/共记录 4 个知识点/);
		expandKnowledgeSection();

		fireEvent.click(filterButton("稳定"));

		const weakCard = screen.getByRole("button", { name: /需要关注的知识点/ }).closest("section")!;
		expect(weakCard.textContent).toContain("学习中项");
		expect(weakCard.textContent).toContain("待复习项");
	});

	it("I09 recomputes counts after a refresh", async () => {
		learnerStore.profile = profile(MIXED);
		render(<ProfilePage />);
		expandKnowledgeSection();
		expect(filterButton("全部").textContent).toContain("4");

		learnerStore.profile = profile([...MIXED, knowledge({ concept_id: "c_new", concept_name: "新增项", state_label: "stable" })]);
		learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
		await act(async () => { await learnerStore.load(); });

		await waitFor(() => expect(filterButton("全部").textContent).toContain("5"));
		expect(filterButton("稳定").textContent).toContain("2");
	});

	it("I10 shows the filter-empty message, not an empty profile, when nothing matches", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1", concept_name: "仅学习中", state_label: "learning" })]);
		render(<ProfilePage />);
		expandKnowledgeSection();

		fireEvent.click(filterButton("稳定"));

		expect(screen.getByText("当前筛选下没有知识点，可选择其他状态。")).toBeTruthy();
		expect(screen.queryByText("暂未追踪任何概念。")).toBeNull();
	});

	it("keeps the filter when a refresh fails and does not invent matches", async () => {
		learnerStore.profile = profile(MIXED);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("待复习"));

		learnerApi.getLearnerProfile.mockRejectedValue(new Error("网络中断"));
		await act(async () => { await learnerStore.load(); });

		expect(filterButton("待复习").getAttribute("aria-pressed")).toBe("true");
		expect(visibleNames()).toEqual(["待复习项"]);
		expect(screen.getByRole("alert").textContent).toContain("网络中断");
	});
});
