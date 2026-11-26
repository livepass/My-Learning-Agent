// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { ProfilePage } from "../pages/ProfilePage.js";
import { learnerStore } from "../../stores/learner-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { KnowledgeState, LearnerProfile } from "../../types/learner.js";

/**
 * E4.9i-P2-6 (T08 C / E) — provenance across the edit lifecycle and the course scope.
 *
 * The display rules are pure and tested separately. What these cases pin is the
 * part that only the real page can show: that the source the reader sees is the
 * one the server last returned, at every step of an edit, and that the course
 * view reads its own records rather than borrowing the global profile's.
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

function stubRadixSelect() {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => undefined;
	Element.prototype.releasePointerCapture = () => undefined;
	Element.prototype.scrollIntoView = () => undefined;
}

function knowledgeSection(): HTMLElement {
	return screen.getByRole("button", { name: /知识状态|Knowledge/ }).closest("section") as HTMLElement;
}

function expandKnowledgeSection() {
	const header = screen.getByRole("button", { name: /知识状态|Knowledge/ });
	if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
}

function rowFor(name: string): HTMLElement {
	const button = [...knowledgeSection().querySelectorAll("button[aria-expanded]")]
		.find((b) => b.textContent?.includes(name));
	if (!button) throw new Error(`no row for ${name}`);
	return button as HTMLElement;
}

function sectionButton(label: RegExp): HTMLButtonElement {
	const button = [...knowledgeSection().querySelectorAll("button")]
		.find((b) => label.test(b.textContent?.trim() ?? ""));
	if (!button) throw new Error(`no ${label} button in the knowledge section`);
	return button as HTMLButtonElement;
}

/** The provenance line inside the open row, as rendered. */
function provenanceTextOf(row: HTMLElement): string {
	const wrapper = row.parentElement!;
	return wrapper.querySelector(".mla-provenance")?.textContent ?? "";
}

async function openEditor(name: string) {
	expandKnowledgeSection();
	const row = rowFor(name);
	fireEvent.click(row);
	const edit = [...row.parentElement!.querySelectorAll("button")]
		.filter((button) => button.textContent?.trim() === "编辑").pop();
	fireEvent.click(edit!);
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
	// The server's own rule: a PATCH writes origin "manual". Merge onto the stored
	// record the way the real PATCH does, so the concept keeps its name and its
	// other fields instead of collapsing to its id.
	learnerApi.updateKnowledge.mockImplementation(async (conceptId: string, patch: Partial<KnowledgeState>) => {
		const stored = learnerStore.profile?.knowledge_states.find((k) => k.concept_id === conceptId);
		return knowledge({ ...(stored ?? { concept_id: conceptId }), ...patch, concept_id: conceptId, origin: "manual" });
	});
	coursesApi.listCourses.mockResolvedValue([]);
	coursesApi.getCourseLearner.mockImplementation(async () => courseView([]));
	coursesApi.getDailyPlans.mockResolvedValue({ date: "2026-11-24", daily_minutes: 30, courses: [], notes: [] });
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("C — the source follows the server, step by step", () => {
	it("C01 shows the stored source before editing", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		const row = rowFor("同义替换");
		fireEvent.click(row);
		expect(provenanceTextOf(row)).toContain("系统推导");
		expect(provenanceTextOf(row)).toContain("证据标识 1 个");
	});

	it("C02 opening the editor does not change the source", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		render(<ProfilePage />);
		await openEditor("同义替换");
		// The read view is replaced by the editor, but the record itself is untouched.
		expect(learnerStore.profile!.knowledge_states[0].origin).toBe("derived");
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("C03 typing a draft does not change the source", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		render(<ProfilePage />);
		await openEditor("同义替换");
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "草稿" } });
		expect(learnerStore.profile!.knowledge_states[0].origin).toBe("derived");
		// Nothing has been sent yet.
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
	});

	it("C04 shows the server's origin after a successful save", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		render(<ProfilePage />);
		await openEditor("同义替换");
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "保存后的诊断" } });
		fireEvent.click(sectionButton(/^(保存|Save)$/));

		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		// The label comes from what the server returned, not from the frontend
		// assuming a save means "manual".
		expect(learnerStore.profile!.knowledge_states[0].origin).toBe("manual");
		const row = rowFor("同义替换");
		expect(provenanceTextOf(row)).toContain("人工维护");
	});

	it("C05 keeps the draft and the original source when the save fails", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		learnerApi.updateKnowledge.mockRejectedValue(new Error("网络中断"));
		render(<ProfilePage />);
		await openEditor("同义替换");
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "没保存的诊断" } });
		fireEvent.click(sectionButton(/^(保存|Save)$/));

		await screen.findByRole("alert");
		expect(screen.getByDisplayValue("没保存的诊断")).toBeTruthy();
		expect(learnerStore.profile!.knowledge_states[0].origin).toBe("derived");
	});

	it("C06 cancelling an unchanged draft leaves the source alone", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		render(<ProfilePage />);
		await openEditor("同义替换");
		fireEvent.click(sectionButton(/^(取消|Cancel)$/));
		expect(learnerStore.profile!.knowledge_states[0].origin).toBe("derived");
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
	});

	it("C07 a passive refresh shows the latest server source", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(rowFor("同义替换"));
		expect(provenanceTextOf(rowFor("同义替换"))).toContain("系统推导");

		// The server now reports the record as legacy with unknown provenance.
		learnerStore.profile = profile([
			knowledge({
				concept_id: "c1", concept_name: "同义替换",
				origin: "legacy", provenance_unknown: true, evidence_ids: ["legacy_1", "event_1"],
			}),
		]);
		learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
		await act(async () => { await learnerStore.load(); });

		const text = provenanceTextOf(rowFor("同义替换"));
		expect(text).toContain("历史记录");
		expect(text).toContain("来源不明");
		expect(text).toContain("证据标识 2 个");
		expect(text).not.toContain("系统推导");
	});

	it("C08 a concept that left the profile still cannot be saved", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", origin: "derived", evidence_ids: ["e1"] }),
		]);
		render(<ProfilePage />);
		await openEditor("同义替换");
		fireEvent.change(screen.getByDisplayValue("诊断文本"), { target: { value: "消失前的草稿" } });

		// The concept is gone from the latest profile entirely.
		learnerStore.profile = profile([]);
		learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
		await act(async () => { await learnerStore.load(); });

		const save = sectionButton(/^(保存|Save)$/) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		fireEvent.click(save);
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue("消失前的草稿")).toBeTruthy();
	});
});

/** `listCourses` returns a bare array of summaries, not `{ courses }`. */
const courseSummary = () => ({
	course_id: "course_a", title: "同义替换", description: "", status: "in_progress" as const,
	created_at: "", updated_at: "",
	counts: { goals: 0, plans: 0, tasks: 0, sessions: 0, sources: 0 },
});

describe("E — the course scope reads its own records", () => {
	async function openCourse() {
		render(<ProfilePage />);
		const trigger = await screen.findByLabelText("选择学习档案范围");
		// Radix opens its listbox from the keyboard, which jsdom can drive.
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		fireEvent.click(await screen.findByRole("option", { name: "同义替换" }));
		await screen.findByRole("heading", { name: /知识掌握/ });
	}

	it("E01 shows the course's own origin and evidence, not the global profile's", async () => {
		// The global record says manual with 9 identifiers; the course record says
		// derived with 1. The course view must show the latter.
		learnerStore.profile = profile([
			knowledge({
				concept_id: "a_short", concept_name: "虚拟语气",
				origin: "manual", provenance_unknown: false,
				evidence_ids: Array.from({ length: 9 }, (_, i) => `g${i}`),
			}),
		]);
		coursesApi.listCourses.mockResolvedValue([courseSummary()]);
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "a_short", concept_name: "虚拟语气", origin: "derived", evidence_ids: ["e1"] },
		]));

		await openCourse();
		const card = screen.getByRole("heading", { name: /知识掌握/ }).closest("section") as HTMLElement;
		const text = card.textContent ?? "";
		expect(text).toContain("系统推导");
		expect(text).toContain("证据标识 1 个");
		// The global record's 9 identifiers must not leak in.
		expect(text).not.toContain("证据标识 9 个");
		expect(text).not.toContain("人工维护");
	});

	it("E02 shows 来源不明 from the course record", async () => {
		coursesApi.listCourses.mockResolvedValue([courseSummary()]);
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "a_short", concept_name: "虚拟语气", origin: "legacy", provenance_unknown: true, evidence_ids: ["legacy_1"] },
		]));

		await openCourse();
		const card = screen.getByRole("heading", { name: /知识掌握/ }).closest("section") as HTMLElement;
		expect(card.textContent).toContain("历史记录");
		expect(card.textContent).toContain("来源不明");
	});

	it("E03 the course view stays read-only", async () => {
		coursesApi.listCourses.mockResolvedValue([courseSummary()]);
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "a_short", concept_name: "虚拟语气", origin: "derived", evidence_ids: ["e1"] },
		]));

		await openCourse();
		const card = screen.getByRole("heading", { name: /知识掌握/ }).closest("section") as HTMLElement;
		// Provenance is information; it must not introduce an editing entry.
		expect(card.querySelector("input")).toBeNull();
		expect(card.querySelector("textarea")).toBeNull();
	});
});
