// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { LearnerProfilePanel } from "../LearnerProfilePanel.js";
import { CourseLearnerPanel } from "../courses/CourseLearnerPanel.js";
import { learnerStore } from "../../stores/learner-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { KnowledgeState, LearnerProfile } from "../../types/learner.js";

/**
 * E4.9i-P2-2 — the list inside its two containers.
 *
 * The component suite covers the row's own behaviour; these cases pin what the
 * page decides: which store call is made, that the course view cannot reach the
 * editor, that the collapse rule survived the extraction, and that a course
 * switch never paints one course's knowledge under another.
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

beforeEach(async () => {
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
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("all-courses container", () => {
	it("saves through learnerStore.patchKnowledge with the unchanged payload", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", mastery: 0.4, diagnosis: "旧诊断", next_actions: ["旧建议"] }),
		]);
		render(<LearnerProfilePanel />);

		fireEvent.click(screen.getByText("同义替换").closest("button")!);
		fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledWith("c1", {
			diagnosis: "旧诊断",
			next_actions: ["旧建议"],
			mastery: 0.4,
		}));
	});

	it("T30 keeps the collapse rule above five rows", async () => {
		learnerStore.profile = profile(
			Array.from({ length: 6 }, (_, index) => knowledge({ concept_id: `c${index + 1}` })),
		);
		render(<LearnerProfilePanel />);

		const header = screen.getByRole("button", { name: /知识状态/ });
		expect(header.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("c1")).toBeNull();

		fireEvent.click(header);
		expect(screen.getByText("c1")).toBeTruthy();
	});

	it("does not collapse five rows", async () => {
		learnerStore.profile = profile(
			Array.from({ length: 5 }, (_, index) => knowledge({ concept_id: `c${index + 1}` })),
		);
		render(<LearnerProfilePanel />);
		expect(screen.getByText("c1")).toBeTruthy();
	});

	it("D: a server refresh replaces the saved data but never the open draft", async () => {
		learnerStore.profile = profile([knowledge({ concept_id: "c1", concept_name: "同义替换", diagnosis: "旧诊断" })]);
		render(<LearnerProfilePanel />);

		fireEvent.click(screen.getByText("同义替换").closest("button")!);
		fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
		fireEvent.change(screen.getByDisplayValue("旧诊断"), { target: { value: "正在编辑的草稿" } });

		learnerStore.profile = profile([knowledge({ concept_id: "c1", concept_name: "同义替换", diagnosis: "服务端新诊断" })]);
		learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
		await act(async () => { await learnerStore.load(); });

		// The editor keeps the learner's words; the refresh is not applied over them.
		expect(screen.getByDisplayValue("正在编辑的草稿")).toBeTruthy();
	});
});

describe("course-scoped container", () => {
	it("T25/T26 renders read-only and keeps the evidence count and weak section", async () => {
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "c1", concept_name: "同义替换", state_label: "learning", evidence_ids: ["e1", "e2", "e3"] },
			{ concept_id: "c2", concept_name: "虚拟语气", state_label: "misconception", evidence_ids: ["e4"] },
		]));
		coursesStore.selectCourse("course_a");
		render(<CourseLearnerPanel courseId="course_a" />);

		await screen.findByRole("heading", { name: "知识掌握" });
		// Evidence counts survive the extraction.
		expect(screen.getAllByText(/证据 3 条/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/证据 1 条/).length).toBeGreaterThan(0);
		// The weak-knowledge section is still there.
		expect(screen.getByRole("heading", { name: "需要关注的知识点" })).toBeTruthy();
		// And there is no way into the editor at all.
		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
	});

	it("E4.9i-P2-3: the course view keeps its own counters and never shows the all-courses overview", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "global1", concept_name: "全部课程概念", state_label: "learning" }),
		]);
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "c1", concept_name: "同义替换", state_label: "learning" },
			{ concept_id: "c2", concept_name: "虚拟语气", state_label: "stable" },
		]));
		coursesStore.selectCourse("course_a");
		render(<CourseLearnerPanel courseId="course_a" />);

		await screen.findByRole("heading", { name: "知识掌握" });
		// The course view keeps its four course facts (knowledge count + weak count).
		// Scoped to `.mla-fact`: P2-4's filter row also renders these numbers.
		const facts = [...document.querySelectorAll(".mla-fact strong")].map((node) => node.textContent);
		expect(facts).toContain("2");
		expect(facts).toContain("1");
		// The all-courses conclusion and weak card are not ported into this view.
		expect(screen.queryByText(/共记录/)).toBeNull();
		expect(screen.queryByText(/下一步动作：/)).toBeNull();
		expect(screen.queryByText("全部课程概念")).toBeNull();
	});

	it("T29 a course switch never paints the previous course's knowledge", async () => {
		coursesApi.getCourseLearner.mockImplementation(async (id: string) => id === "course_a"
			? courseView([{ concept_id: "a1", concept_name: "课程 A 概念", state_label: "learning" }])
			: courseView([{ concept_id: "b1", concept_name: "课程 B 概念", state_label: "stable" }]));

		coursesStore.selectCourse("course_a");
		const { rerender } = render(<CourseLearnerPanel courseId="course_a" />);
		await waitFor(() => expect(screen.getAllByText("课程 A 概念").length).toBeGreaterThan(0));

		coursesStore.selectCourse("course_b");
		rerender(<CourseLearnerPanel courseId="course_b" />);
		await waitFor(() => expect(screen.getAllByText("课程 B 概念").length).toBeGreaterThan(0));
		expect(screen.queryByText("课程 A 概念")).toBeNull();
	});
});
