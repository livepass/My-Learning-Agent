// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/index.js";
import { LearnerProfilePanel } from "./LearnerProfilePanel.js";
import { CourseLearnerPanel } from "./courses/CourseLearnerPanel.js";
import { learnerStore } from "../stores/learner-store.js";
import { coursesStore } from "../stores/courses-store.js";
import type { KnowledgeState, LearnerProfile } from "../types/learner.js";

/**
 * E4.9i-P2-1 — one knowledge-state vocabulary.
 *
 * The all-courses view used to bucket `mastery` into 已掌握 / 巩固中 / 待复习
 * of its own, while the course-scoped view read the server's `state_label`.
 * A concept with `mastery: 0.05, state_label: "learning"` therefore read
 * 「待复习」 on one page and 「学习中」 on the other. These cases pin the
 * replacement rule: the label comes from `state_label` only, and anything
 * missing or unrecognised degrades to 「证据不足」 instead of being guessed.
 */

const learnerApi = vi.hoisted(() => ({
	getLearnerProfile: vi.fn(),
	patchLearnerProfile: vi.fn(),
	updateKnowledge: vi.fn(),
	getLearningRecommendations: vi.fn(),
}));

vi.mock("../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../api/learner.js")>("../api/learner.js");
	return { ...actual, ...learnerApi };
});

const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getCourseLearner: vi.fn(),
	getDailyPlans: vi.fn(),
}));

vi.mock("../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../api/courses.js")>("../api/courses.js");
	return { ...actual, ...coursesApi };
});

const knowledge = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
	concept_name: patch.concept_id,
	domain: "cet4",
	mastery: 0.5,
	confidence: 0.5,
	stability: 0.5,
	evidence_ids: [],
	diagnosis: "",
	next_actions: [],
	...patch,
});

const profile = (states: KnowledgeState[], overrides: Partial<LearnerProfile> = {}): LearnerProfile => ({
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-01T00:00:00.000Z",
	goals: [],
	knowledge_states: states,
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
	...overrides,
});

const courseView = (states: Array<Record<string, unknown>>) => ({
	course: { course_id: "course_a", title: "同义替换", description: "", status: "in_progress", created_at: "", updated_at: "" },
	goals: [],
	knowledge_states: states.map((state) => ({
		domain: "cet4", mastery: 0.5, confidence: 0.5, stability: 0.5,
		evidence_ids: [], diagnosis: "", next_actions: [], ...state,
	})),
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	unclassified: { knowledge_states: 0, goals: 0 },
});

/**
 * E4.9i-P2-3: the all-courses page now lists a weak concept twice — in 知识状态
 * and again in 需要关注的知识点 (the course view has done this since E4.5e). A
 * global `getByText(name)` would therefore match two nodes, so every lookup here
 * is scoped to the knowledge section. The assertions themselves are unchanged.
 */
function knowledgeSection(): HTMLElement {
	// Matches the Chinese and English section title, since T12 switches language
	// part-way through.
	return screen.getByRole("button", { name: /知识状态|Knowledge/ }).closest("section") as HTMLElement;
}

/** The clickable row header for a concept, inside the knowledge section only. */
function knowledgeRowButton(conceptName: string): HTMLElement {
	const row = [...knowledgeSection().querySelectorAll("button[aria-expanded]")].find(
		(button) => button.textContent?.includes(conceptName),
	);
	if (!row) throw new Error(`no knowledge row for ${conceptName}`);
	return row as HTMLElement;
}

/** Every state badge on the page, for "no badge claims X" assertions. */
function allBadgeLabels(): string[] {
	return [...document.querySelectorAll(".mla-badge")].map((badge) => badge.textContent?.trim() ?? "");
}

/** The badge is the only place a state label is rendered in a knowledge row. */
function badgeText(conceptName: string): string | undefined {
	const row = knowledgeRowButton(conceptName);
	const badges = [...row.querySelectorAll(".mla-badge")];
	return badges.map((b) => b.textContent?.trim()).find((text) => text && !text.includes("%"));
}

/** The knowledge section collapses itself above five rows. */
function expandKnowledgeSection() {
	const header = screen.getByRole("button", { name: /知识状态/ });
	if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
}

/**
 * The course view lists a weak concept twice (knowledge list + 需要关注 card),
 * so the badge must be read from the knowledge section specifically.
 */
function courseBadgeText(conceptName: string): string | undefined {
	const heading = screen.getByRole("heading", { name: "知识掌握" });
	const section = heading.closest("section")!;
	const name = [...section.querySelectorAll("strong")].find((el) => el.textContent === conceptName);
	if (!name) return undefined;
	const badges = [...name.parentElement!.querySelectorAll(".mla-badge")];
	return badges.map((b) => b.textContent?.trim()).find((text) => text && !text.includes("%"));
}

beforeEach(() => {
	vi.clearAllMocks();
	learnerStore.profile = null;
	learnerStore.isSaving = false;
	learnerStore.isLoading = false;
	coursesStore.reset();
	learnerApi.getLearningRecommendations.mockResolvedValue({ recommendations: [], generated_at: "" });
	learnerApi.getLearnerProfile.mockImplementation(async () => learnerStore.profile ?? profile([]));
	learnerApi.updateKnowledge.mockImplementation(async (conceptId: string, patch: Partial<KnowledgeState>) =>
		knowledge({ concept_id: conceptId, ...patch }));
	coursesApi.getDailyPlans.mockResolvedValue({ date: "2026-11-24", daily_minutes: 30, courses: [], notes: [] });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("knowledge state semantics", () => {
	it("T01 translates all six server states", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c_unknown", state_label: "unknown" }),
			knowledge({ concept_id: "c_learning", state_label: "learning" }),
			knowledge({ concept_id: "c_fragile", state_label: "fragile" }),
			knowledge({ concept_id: "c_review", state_label: "review_due" }),
			knowledge({ concept_id: "c_stable", state_label: "stable" }),
			knowledge({ concept_id: "c_misc", state_label: "misconception" }),
		]);
		render(<LearnerProfilePanel />);
		expandKnowledgeSection();

		expect(badgeText("c_unknown")).toBe("证据不足");
		expect(badgeText("c_learning")).toBe("学习中");
		expect(badgeText("c_fragile")).toBe("不稳定");
		expect(badgeText("c_review")).toBe("待复习");
		expect(badgeText("c_stable")).toBe("稳定");
		expect(badgeText("c_misc")).toBe("存在误区");
	});

	it("T02 shows 学习中 for mastery 0.05 with state_label=learning", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1", state_label: "learning", mastery: 0.05 })]);
		render(<LearnerProfilePanel />);

		expect(badgeText("c1")).toBe("学习中");
		// The old threshold bucketed this as needsReview → 「待复习」. Scoped to
		// badges: P2-4's filter row legitimately offers a 「待复习」 option, but no
		// state badge may claim it.
		expect(allBadgeLabels()).not.toContain("待复习");
	});

	it("T03 shows 待复习 for mastery 0.85 with state_label=review_due", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1", state_label: "review_due", mastery: 0.85 })]);
		render(<LearnerProfilePanel />);

		expect(badgeText("c1")).toBe("待复习");
		// The old threshold would have said 「已掌握」 for 0.85.
		expect(screen.queryByText("已掌握")).toBeNull();
	});

	it("T04 keeps 稳定 for mastery 0.20 with state_label=stable", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1", state_label: "stable", mastery: 0.2 })]);
		render(<LearnerProfilePanel />);

		expect(badgeText("c1")).toBe("稳定");
		expect(allBadgeLabels()).not.toContain("待复习");
	});

	it("T05 shows 证据不足 when state_label is absent", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1" })]);
		render(<LearnerProfilePanel />);

		expect(badgeText("c1")).toBe("证据不足");
	});

	it("T06 degrades an unknown state string to 证据不足 without leaking it", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", state_label: "brand_new_state" as never }),
			knowledge({ concept_id: "c2", state_label: "" as never }),
		]);
		render(<LearnerProfilePanel />);

		expect(badgeText("c1")).toBe("证据不足");
		expect(badgeText("c2")).toBe("证据不足");
		expect(screen.queryByText("brand_new_state")).toBeNull();
	});

	it("T07 keeps the mastery percentage and its progress bar", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1", state_label: "learning", mastery: 0.37 })]);
		const { container } = render(<LearnerProfilePanel />);

		expect(screen.getByText("37%")).toBeTruthy();
		const bar = container.querySelector<HTMLElement>('[style*="width: 37%"]');
		expect(bar).toBeTruthy();
	});

	it("T08 no longer renders any of the retired three-bucket labels", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", state_label: "stable", mastery: 0.9 }),
			knowledge({ concept_id: "c2", state_label: "fragile", mastery: 0.5 }),
			knowledge({ concept_id: "c3", state_label: "unknown", mastery: 0.1 }),
		]);
		render(<LearnerProfilePanel />);

		for (const retired of ["已掌握", "巩固中"]) {
			expect(screen.queryByText(retired), retired).toBeNull();
		}
	});

	it("T09 counts the overview by state_label", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", state_label: "review_due" }),
			knowledge({ concept_id: "c2", state_label: "review_due" }),
			knowledge({ concept_id: "c3", state_label: "learning" }),
		]);
		render(<LearnerProfilePanel />);

		const label = screen.getByText("待复习状态");
		const tile = label.parentElement!;
		expect(tile.querySelector(".text-2xl")?.textContent).toBe("2");
	});

	it("T10 a past review_due_at does not add to the state count when the state is learning", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", state_label: "learning", review_due_at: "2020-01-01T00:00:00.000Z" }),
		]);
		render(<LearnerProfilePanel />);

		const tile = screen.getByText("待复习状态").parentElement!;
		expect(tile.querySelector(".text-2xl")?.textContent).toBe("0");
	});

	it("T11 counts review_due even without a stored date", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1", state_label: "review_due" })]);
		render(<LearnerProfilePanel />);

		const tile = screen.getByText("待复习状态").parentElement!;
		expect(tile.querySelector(".text-2xl")?.textContent).toBe("1");
	});

	it("T12 uses the English labels when the language switches", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", state_label: "learning" }),
			knowledge({ concept_id: "c2", state_label: "unknown" }),
		]);
		render(<LearnerProfilePanel />);
		expect(badgeText("c1")).toBe("学习中");

		await act(async () => { await i18n.changeLanguage("en"); });

		await waitFor(() => expect(badgeText("c1")).toBe("Learning"));
		expect(badgeText("c2")).toBe("Insufficient evidence");
		expect(screen.queryByText("学习中")).toBeNull();
	});

	it("T13 keeps expand and edit working", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning", diagnosis: "旧诊断" }),
		]);
		render(<LearnerProfilePanel />);

		// E4.9i-P2-2: expanding now opens the read view, so the editor is one
		// explicit step further. The save assertion below is unchanged.
		fireEvent.click(knowledgeRowButton("同义替换"));
		await screen.findByText("旧诊断");
		fireEvent.click(screen.getByRole("button", { name: "编辑" }));
		const diagnosis = await screen.findByDisplayValue("旧诊断");
		fireEvent.change(diagnosis, { target: { value: "新诊断" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalled());
	});

	it("T14 sends the same patch payload as before", async () => {
		learnerStore.profile = profile([
			knowledge({
				concept_id: "c1", concept_name: "同义替换", state_label: "learning",
				mastery: 0.4, diagnosis: "旧诊断", next_actions: ["继续练习"],
			}),
		]);
		render(<LearnerProfilePanel />);

		fireEvent.click(knowledgeRowButton("同义替换"));
		fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
		fireEvent.click(await screen.findByRole("button", { name: "保存" }));

		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledWith("c1", {
			diagnosis: "旧诊断",
			next_actions: ["继续练习"],
			mastery: 0.4,
		}));
	});

	it("T15 renders the same label in the course-scoped view", async () => {
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "c1", concept_name: "同义替换", state_label: "learning", mastery: 0.05 },
			{ concept_id: "c2", concept_name: "虚拟语气", state_label: "review_due", mastery: 0.85 },
		]));
		coursesStore.selectCourse("course_a");
		render(<CourseLearnerPanel courseId="course_a" />);

		await screen.findByRole("heading", { name: "知识掌握" });
		expect(courseBadgeText("同义替换")).toBe("学习中");
		expect(courseBadgeText("虚拟语气")).toBe("待复习");
	});

	it("T16 does not paint an unknown state as success", async () => {
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "c1", concept_name: "同义替换", state_label: "unknown", mastery: 0.9 },
			{ concept_id: "c2", concept_name: "无标签", mastery: 0.9 },
		]));
		coursesStore.selectCourse("course_a");
		render(<CourseLearnerPanel courseId="course_a" />);

		await screen.findByRole("heading", { name: "知识掌握" });
		expect(courseBadgeText("同义替换")).toBe("证据不足");
		expect(courseBadgeText("无标签")).toBe("证据不足");

		const heading = screen.getByRole("heading", { name: "知识掌握" });
		const section = heading.closest("section")!;
		for (const badge of [...section.querySelectorAll(".mla-badge")]) {
			if (badge.textContent?.includes("证据不足")) {
				// `success` would claim the concept is fine; neutral says "unknown".
				expect(badge.className).not.toContain("mla-badge--success");
			}
		}
	});
});
