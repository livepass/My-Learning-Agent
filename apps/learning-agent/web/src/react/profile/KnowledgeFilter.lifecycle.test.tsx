// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { ProfilePage } from "../pages/ProfilePage.js";
import { learnerStore } from "../../stores/learner-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { KnowledgeState, LearnerProfile } from "../../types/learner.js";

/**
 * E4.9i-P2-4-R1 — the edit lifecycle under passive data changes.
 *
 * P2-4 guarded *active* filter switches but not a refresh: if the server moved
 * a concept out of the selected filter, the row disappeared on the next render
 * and took its unsaved draft with it. These cases drive the real page and the
 * real store, so they exercise the same unmount path a browser would.
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

function filterButton(label: string): HTMLButtonElement {
	const button = [...knowledgeSection().querySelectorAll("button")].find((b) =>
		b.textContent?.trim().startsWith(label) && b.hasAttribute("aria-pressed"));
	if (!button) throw new Error(`no filter button ${label}`);
	return button as HTMLButtonElement;
}

function rowFor(name: string): HTMLElement | undefined {
	return [...knowledgeSection().querySelectorAll("button[aria-expanded]")]
		.find((button) => button.textContent?.includes(name)) as HTMLElement | undefined;
}

function visibleRowCount(): number {
	const toggle = knowledgeSection().querySelector("h4")?.closest("button");
	return [...knowledgeSection().querySelectorAll("button[aria-expanded]")].filter((b) => b !== toggle).length;
}

/**
 * Scoped to the knowledge section: the profile page has several other 保存 and
 * 取消 buttons, and an unscoped role lookup would pick the wrong one.
 */
function sectionButton(label: RegExp): HTMLButtonElement {
	const button = [...knowledgeSection().querySelectorAll("button")]
		.find((b) => label.test(b.textContent?.trim() ?? ""));
	if (!button) throw new Error(`no ${label} button in the knowledge section`);
	return button as HTMLButtonElement;
}

function saveButton(): HTMLButtonElement {
	return sectionButton(/^(保存|Save)$/);
}

function cancelButton(): HTMLButtonElement {
	return sectionButton(/^(取消|Cancel)$/);
}

async function openDirtyEditor(name: string, text = "未保存草稿", currentDiagnosis = "诊断文本") {
	expandKnowledgeSection();
	const row = rowFor(name)!;
	fireEvent.click(row);
	// Scope to this row: with two editors open, a global 编辑 lookup is ambiguous.
	const edit = [...row.parentElement!.querySelectorAll("button")]
		.filter((button) => button.textContent?.trim() === "编辑").pop();
	fireEvent.click(edit!);
	fireEvent.change(screen.getByDisplayValue(currentDiagnosis), { target: { value: text } });
}

/** Drive a real store refresh with the given server payload. */
async function refreshWith(states: KnowledgeState[]) {
	learnerStore.profile = profile(states);
	learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
	await act(async () => { await learnerStore.load(); });
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

describe("R1 — passive refresh must not drop a draft", () => {
	it("R01 keeps the draft when a learning concept refreshes to stable", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		// Select the filter first (nothing is dirty yet), then start editing.
		fireEvent.click(filterButton("需要关注"));
		expect(visibleRowCount()).toBe(1);
		await openDirtyEditor("同义替换", "刷新前的草稿");

		// The server now classifies the concept as stable: it no longer matches.
		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "stable" }),
		]);

		// The editor and its words survive the passive change.
		expect(screen.getByDisplayValue("刷新前的草稿")).toBeTruthy();
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("R02 keeps the draft when a review_due concept refreshes to unknown", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "连接词逻辑", state_label: "review_due" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("待复习"));
		await openDirtyEditor("连接词逻辑", "待复习草稿");

		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "连接词逻辑", state_label: "unknown" }),
		]);

		expect(screen.getByDisplayValue("待复习草稿")).toBeTruthy();
		expect(filterButton("待复习").getAttribute("aria-pressed")).toBe("true");
	});

	it("R03 keeps the editor when the refresh still matches the filter", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "仍匹配草稿");

		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "fragile" }),
		]);

		expect(screen.getByDisplayValue("仍匹配草稿")).toBeTruthy();
		expect(visibleRowCount()).toBe(1);
	});

	it("R04 keeps the filter and draft when the refresh fails", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "失败刷新草稿");

		learnerApi.getLearnerProfile.mockRejectedValue(new Error("网络中断"));
		await act(async () => { await learnerStore.load(); });

		expect(screen.getByDisplayValue("失败刷新草稿")).toBeTruthy();
		expect(filterButton("需要关注").getAttribute("aria-pressed")).toBe("true");
	});

	it("R06 does not count a protected row as a filter result", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "受保护草稿");

		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "stable" }),
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);

		// The filter still reports one match, while two rows are on screen.
		expect(filterButton("需要关注").textContent).toContain("1");
		expect(filterButton("稳定").textContent).toContain("1");
		expect(visibleRowCount()).toBe(2);
	});

	it("R07 removes the protected row after the edit ends", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "受保护草稿");
		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "stable" }),
		]);
		expect(visibleRowCount()).toBe(1);

		// Cancelling is an exit; the row no longer matches, so it leaves.
		vi.spyOn(window, "confirm").mockReturnValue(true);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));

		await waitFor(() => expect(visibleRowCount()).toBe(0));
	});

	it("R08 keeps two protected rows, each exactly once", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "甲项", state_label: "learning", diagnosis: "甲诊断" }),
			knowledge({ concept_id: "c2", concept_name: "乙项", state_label: "fragile", diagnosis: "乙诊断" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("甲项", "甲草稿", "甲诊断");
		// The first editor stays open; open the second one as well.
		const row = rowFor("乙项")!;
		fireEvent.click(row);
		const editButtons = [...row.parentElement!.querySelectorAll("button")]
			.filter((button) => button.textContent?.trim() === "编辑");
		fireEvent.click(editButtons[editButtons.length - 1]!);
		fireEvent.change(screen.getByDisplayValue("乙诊断"), { target: { value: "乙草稿" } });

		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "甲项", state_label: "stable", diagnosis: "甲诊断" }),
			knowledge({ concept_id: "c2", concept_name: "乙项", state_label: "stable", diagnosis: "乙诊断" }),
		]);

		const names = [...knowledgeSection().querySelectorAll("button[aria-expanded] div > div")]
			.map((node) => node.textContent)
			.filter((text) => text === "甲项" || text === "乙项");
		expect(names).toEqual(["甲项", "乙项"]);
		expect(screen.getByDisplayValue("甲草稿")).toBeTruthy();
		expect(screen.getByDisplayValue("乙草稿")).toBeTruthy();
	});

	it("R09 keeps the draft when the concept disappears from the latest profile", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "将消失的草稿");

		// The concept is gone from the server's latest answer.
		await refreshWith([
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);

		expect(screen.getByDisplayValue("将消失的草稿")).toBeTruthy();
		expect(screen.getByText(/不在最新档案中|状态已变化/)).toBeTruthy();
		// It is not counted as a match.
		expect(filterButton("需要关注").textContent).toContain("1");
	});

	it("R10 keeps an editor when the whole list becomes empty", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		await openDirtyEditor("同义替换", "空档案前的草稿");

		await refreshWith([]);

		expect(screen.getByDisplayValue("空档案前的草稿")).toBeTruthy();
		expect(screen.queryByText("暂未追踪任何概念。")).toBeNull();
	});
});

describe("R1 — save lifecycle (G09 / R11–R16)", () => {
	it("R11/G09 removes the row and updates counts after an async save changes the state", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		let resolveSave: (state: KnowledgeState) => void = () => {};
		learnerApi.updateKnowledge.mockImplementationOnce(() => new Promise((resolve) => {
			resolveSave = (state) => resolve(state);
		}));
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "保存后的诊断");

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1));

		// The request carries the learner's words, not just some patch.
		expect(learnerApi.updateKnowledge).toHaveBeenCalledWith("c1", expect.objectContaining({
			diagnosis: "保存后的诊断",
		}));

		// While the request is open the editor is still mounted and the filter
		// is blocked, exactly as before.
		expect(screen.getByRole("slider")).toBeTruthy();
		expect(filterButton("需要关注").getAttribute("aria-pressed")).toBe("true");

		await act(async () => {
			resolveSave(knowledge({
				concept_id: "c1", concept_name: "同义替换", state_label: "stable", diagnosis: "保存后的诊断",
			}));
		});

		// The save landed, the editor closed, and the row left the filter.
		await waitFor(() => expect(visibleRowCount()).toBe(0));
		expect(filterButton("稳定").textContent).toContain("1");
		expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1);

		// F07: the row in 稳定 must show what was actually saved, in reading
		// mode. Asserting only the concept name would pass even if the saved
		// diagnosis never made it back into the list.
		fireEvent.click(filterButton("稳定"));
		expect(visibleRowCount()).toBe(1);
		expect(screen.getByText("同义替换")).toBeTruthy();

		const row = rowFor("同义替换")!;
		fireEvent.click(row);
		expect(screen.getByText("保存后的诊断")).toBeTruthy();
		expect(screen.queryByRole("slider")).toBeNull();
		expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1);
	});

	it("R12 returns to reading mode when the saved state still matches", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		learnerApi.updateKnowledge.mockResolvedValue(
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning", diagnosis: "新诊断" }),
		);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "新诊断");

		fireEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(visibleRowCount()).toBe(1);
		expect(screen.getByText("新诊断")).toBeTruthy();
	});

	it("R13 keeps the draft when a save fails after the state changed", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		learnerApi.updateKnowledge.mockRejectedValueOnce(new Error("网络中断"));
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "失败草稿");

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await screen.findByRole("alert");
		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "stable" }),
		]);

		expect(screen.getByDisplayValue("失败草稿")).toBeTruthy();
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("R14 refuses a filter switch while the save is in flight", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		learnerApi.updateKnowledge.mockImplementationOnce(() => new Promise(() => {}));
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "保存中草稿");

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalled());
		fireEvent.click(filterButton("稳定"));

		expect(confirm).not.toHaveBeenCalled();
		expect(filterButton("需要关注").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("R16 sends exactly one write for one save", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		await openDirtyEditor("同义替换", "一次写入");

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());

		expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1);
	});
});

describe("R1 — active switch and draft policy (R17–R22)", () => {
	it("R17 keeps a draft whose concept still matches after a confirmed switch", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ProfilePage />);
		await openDirtyEditor("同义替换", "仍匹配草稿");

		fireEvent.click(filterButton("需要关注"));

		expect(filterButton("需要关注").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByDisplayValue("仍匹配草稿")).toBeTruthy();
		expect(screen.getByRole("slider")).toBeTruthy();
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
	});

	it("R19 keeps the matching draft and drops only the non-matching one", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "甲项", state_label: "learning", diagnosis: "甲诊断" }),
			knowledge({ concept_id: "c2", concept_name: "乙项", state_label: "stable", diagnosis: "乙诊断" }),
		]);
		vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ProfilePage />);
		expandKnowledgeSection();
		await openDirtyEditor("甲项", "甲草稿", "甲诊断");
		const row = rowFor("乙项")!;
		fireEvent.click(row);
		const editButtons = [...row.parentElement!.querySelectorAll("button")]
			.filter((button) => button.textContent?.trim() === "编辑");
		fireEvent.click(editButtons[editButtons.length - 1]!);
		fireEvent.change(screen.getByDisplayValue("乙诊断"), { target: { value: "乙草稿" } });

		fireEvent.click(filterButton("稳定"));

		// A (learning) is gone; B (stable) kept its draft and its editor.
		expect(screen.queryByDisplayValue("甲草稿")).toBeNull();
		expect(screen.getByDisplayValue("乙草稿")).toBeTruthy();
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("R20 keeps both drafts when the switch is cancelled", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "甲项", state_label: "learning", diagnosis: "甲诊断" }),
			knowledge({ concept_id: "c2", concept_name: "乙项", state_label: "stable", diagnosis: "乙诊断" }),
		]);
		vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		expandKnowledgeSection();
		await openDirtyEditor("甲项", "甲草稿", "甲诊断");
		const row = rowFor("乙项")!;
		fireEvent.click(row);
		const editButtons = [...row.parentElement!.querySelectorAll("button")]
			.filter((button) => button.textContent?.trim() === "编辑");
		fireEvent.click(editButtons[editButtons.length - 1]!);
		fireEvent.change(screen.getByDisplayValue("乙诊断"), { target: { value: "乙草稿" } });

		fireEvent.click(filterButton("稳定"));

		expect(filterButton("全部").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByDisplayValue("甲草稿")).toBeTruthy();
		expect(screen.getByDisplayValue("乙草稿")).toBeTruthy();
	});

	it("R22 keeps a non-all filter and its draft when a course switch is refused", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		coursesApi.listCourses.mockResolvedValue([{
			course_id: "course_a", title: "同义替换", description: "", status: "in_progress",
			created_at: "", updated_at: "", counts: { goals: 0, plans: 0, tasks: 0, sessions: 0, sources: 0 },
		}]);
		vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "课程切换前草稿");

		const trigger = screen.getByLabelText("选择学习档案范围");
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		fireEvent.click(await screen.findByRole("option", { name: "同义替换" }));

		expect(coursesStore.selectedCourseId).toBeNull();
		expect(filterButton("需要关注").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByDisplayValue("课程切换前草稿")).toBeTruthy();
	});
});

describe("R1 — empty states and guard regressions (R23–R30)", () => {
	it("R23 shows the profile empty state when the all-courses list is empty", async () => {
		learnerStore.profile = profile([]);
		render(<ProfilePage />);
		expandKnowledgeSection();

		expect(screen.getByText("暂未追踪任何概念。")).toBeTruthy();
		// No filter row over an empty list.
		expect([...knowledgeSection().querySelectorAll("button[aria-pressed]")]).toHaveLength(0);
	});

	it("R24 shows the course empty state when the course list is empty", async () => {
		coursesStore.selectCourse("course_a");
		render(<ProfilePage />);
		await screen.findByRole("heading", { name: "知识掌握" });

		const section = screen.getByRole("heading", { name: "知识掌握" }).closest("section")!;
		expect(section.textContent).toContain("还没有");
		expect([...section.querySelectorAll("button[aria-pressed]")]).toHaveLength(0);
		// The course view also must not offer filters over an empty list.
		expect(section.textContent).not.toContain("按知识状态筛选");
	});

	it("R24b keeps the filter row on a non-empty course list", async () => {
		coursesStore.selectCourse("course_a");
		coursesApi.getCourseLearner.mockResolvedValue(courseView([
			{ concept_id: "a1", concept_name: "课程A概念", state_label: "learning" },
		]));
		render(<ProfilePage />);
		await screen.findByRole("heading", { name: "知识掌握" });

		const section = screen.getByRole("heading", { name: "知识掌握" }).closest("section")!;
		expect([...section.querySelectorAll("button[aria-pressed]")]).toHaveLength(6);
	});

	it("R25 keeps zero-count filters selectable on a non-empty profile", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "stable" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();

		const reviewChip = filterButton("待复习");
		expect(reviewChip.textContent).toContain("0");
		expect(reviewChip.disabled).toBe(false);
		fireEvent.click(reviewChip);
		expect(filterButton("待复习").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("当前筛选下没有知识点，可选择其他状态。")).toBeTruthy();
	});

	it("R27 keeps protection working across a language switch", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "切换语言后的草稿");

		await act(async () => { await i18n.changeLanguage("en"); });
		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "stable" }),
		]);

		expect(screen.getByDisplayValue("切换语言后的草稿")).toBeTruthy();
		expect(screen.getByText(/state has changed/)).toBeTruthy();
	});
});

/**
 * E4.9i-P2-4-R2 — a concept the latest profile no longer contains cannot be
 * saved.
 *
 * R1 kept the editor mounted and said so, but left the save control live, so a
 * draft could still be PATCHed at a concept the server had already dropped.
 * These cases pin the double guard: the control is disabled *and* the submit
 * path refuses, so neither a click nor a stray call reaches the store.
 */
describe("R2 — a concept that left the profile cannot be saved (S01–S12)", () => {
	/** Open the editor on 同义替换, then refresh so only 虚拟语气 is left. */
	async function openThenLoseConcept(draft = "消失前的草稿") {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", draft);

		await refreshWith([
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);
	}

	it("S01–S04 keeps the draft, disables save, sends no write and says saving is unavailable", async () => {
		await openThenLoseConcept();

		// S01 — the unsaved words are still there.
		expect(screen.getByDisplayValue("消失前的草稿")).toBeTruthy();
		// S02 — the control is disabled.
		expect(saveButton().disabled).toBe(true);
		// S03 — and a click does not reach the store.
		fireEvent.click(saveButton());
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
		// S04 — the notice states that saving is unavailable.
		expect(screen.getByText(/暂时无法保存|Saving is unavailable/)).toBeTruthy();
	});

	it("S05 keeps the editor when the learner declines to discard the draft", async () => {
		await openThenLoseConcept();
		vi.spyOn(window, "confirm").mockReturnValue(false);

		fireEvent.click(cancelButton());

		expect(screen.getByDisplayValue("消失前的草稿")).toBeTruthy();
		expect(screen.getByRole("slider")).toBeTruthy();
	});

	it("S06 closes the editor safely when the learner confirms the discard", async () => {
		await openThenLoseConcept();
		vi.spyOn(window, "confirm").mockReturnValue(true);

		fireEvent.click(cancelButton());

		await waitFor(() => expect(screen.queryByDisplayValue("消失前的草稿")).toBeNull());
		expect(screen.queryByRole("slider")).toBeNull();
		// Discarding never writes anything.
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
	});

	it("S07–S08 restores saving and the draft when the concept comes back", async () => {
		await openThenLoseConcept();
		expect(saveButton().disabled).toBe(true);

		// The same concept_id is in the latest profile again.
		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);

		// S08 — the draft was never reset to the new server values.
		expect(screen.getByDisplayValue("消失前的草稿")).toBeTruthy();
		// S07 — saving is allowed again, and works.
		expect(saveButton().disabled).toBe(false);
		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1));
		expect(learnerApi.updateKnowledge).toHaveBeenCalledWith("c1", expect.objectContaining({
			diagnosis: "消失前的草稿",
		}));
	});

	it("S09–S11 lets an in-flight save finish without a second request or a re-created record", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);
		let resolveSave: (state: KnowledgeState) => void = () => {};
		learnerApi.updateKnowledge.mockImplementationOnce(() => new Promise((resolve) => {
			resolveSave = (state) => resolve(state);
		}));
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "在途草稿");

		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1));

		// The concept disappears while the request is open.
		await refreshWith([
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);

		// S09 — the editor was not unmounted by the refresh.
		expect(screen.getByDisplayValue("在途草稿")).toBeTruthy();
		expect(screen.getByRole("slider")).toBeTruthy();

		await act(async () => {
			resolveSave(knowledge({
				concept_id: "c1", concept_name: "同义替换", state_label: "learning", diagnosis: "在途草稿",
			}));
		});

		// S11 — the request ended safely, once, and the row is gone rather than
		// resurrected from a response for a concept the profile no longer has.
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("同义替换")).toBeNull();
	});

	it("S10 keeps the draft and blocks a retry when the in-flight save fails", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);
		let rejectSave: (err: Error) => void = () => {};
		learnerApi.updateKnowledge.mockImplementationOnce(() => new Promise((_resolve, reject) => {
			rejectSave = reject;
		}));
		render(<ProfilePage />);
		expandKnowledgeSection();
		fireEvent.click(filterButton("需要关注"));
		await openDirtyEditor("同义替换", "失败在途草稿");

		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1));
		await refreshWith([
			knowledge({ concept_id: "c2", concept_name: "虚拟语气", state_label: "learning" }),
		]);

		await act(async () => { rejectSave(new Error("网络中断")); });
		await screen.findByRole("alert");

		// The learner's words survive the failure...
		expect(screen.getByDisplayValue("失败在途草稿")).toBeTruthy();
		// ...and there is no way to send the same doomed request again.
		expect(saveButton().disabled).toBe(true);
		fireEvent.click(saveButton());
		expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1);
	});

	it("S12 keeps the draft and blocks saving when the whole list becomes empty", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		await openDirtyEditor("同义替换", "空档案草稿");

		await refreshWith([]);

		expect(screen.getByDisplayValue("空档案草稿")).toBeTruthy();
		expect(saveButton().disabled).toBe(true);
		fireEvent.click(saveButton());
		expect(learnerApi.updateKnowledge).not.toHaveBeenCalled();
	});
});

describe("R2 — a save that still has a record behind it is unchanged (S17–S18)", () => {
	it("S17 saves an ordinary concept exactly as before", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		await openDirtyEditor("同义替换", "正常草稿");

		const save = saveButton();
		expect(save.disabled).toBe(false);
		fireEvent.click(save);

		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1));
		expect(learnerApi.updateKnowledge).toHaveBeenCalledWith("c1", expect.objectContaining({
			diagnosis: "正常草稿",
		}));
	});

	it("S18 still saves when a refresh changed the state but kept the record", async () => {
		learnerStore.profile = profile([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "learning" }),
		]);
		render(<ProfilePage />);
		expandKnowledgeSection();
		await openDirtyEditor("同义替换", "状态变化草稿");

		await refreshWith([
			knowledge({ concept_id: "c1", concept_name: "同义替换", state_label: "stable" }),
		]);

		const save = saveButton();
		expect(save.disabled).toBe(false);
		fireEvent.click(save);
		await waitFor(() => expect(learnerApi.updateKnowledge).toHaveBeenCalledTimes(1));
	});
});
