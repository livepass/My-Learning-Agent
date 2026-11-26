// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { LearnerProfilePanel } from "../LearnerProfilePanel.js";
import { learnerStore } from "../../stores/learner-store.js";
import type { LearnerProfile, LearningGoal } from "../../types/learner.js";

/**
 * E4.9i-P2-6 (T08 D) — an anomalous stored priority must not be rewritten by
 * merely opening, editing or cancelling the goal editor.
 *
 * The bug this pins: the edit form drives a 0–100 slider from `priority * 100`.
 * A stored `3` puts the value at 300, and while the browser clamps the *thumb*
 * to 100 it fires no change event — but the old label read `300%`, and any
 * subsequent save could refresh manual.priority even if its value stayed 3.
 * These tests check that untouched priority is ABSENT from PATCH, not merely
 * equal to its prior value; explicit actions are the only source of changes.
 */

const learnerApi = vi.hoisted(() => ({
	getLearnerProfile: vi.fn(),
	patchLearnerProfile: vi.fn(),
	updateGoal: vi.fn(),
	deleteGoal: vi.fn(),
	createGoal: vi.fn(),
	getLearningRecommendations: vi.fn(),
}));

vi.mock("../../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learner.js")>("../../api/learner.js");
	return { ...actual, ...learnerApi };
});

const goal = (patch: Partial<LearningGoal> = {}): LearningGoal => ({
	goal_id: "g1",
	title: "掌握 Rust 所有权",
	type: "skill",
	status: "active",
	priority: 0.5,
	success_criteria: [],
	...patch,
} as LearningGoal);

const profile = (goals: LearningGoal[]): LearnerProfile => ({
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-01T00:00:00.000Z",
	goals,
	knowledge_states: [],
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
});

function stubRadixSelect() {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => undefined;
	Element.prototype.releasePointerCapture = () => undefined;
	Element.prototype.scrollIntoView = () => undefined;
}

/** The goal card's edit form is the only slider in this panel. */
function prioritySlider(): HTMLInputElement {
	return screen.getByRole("slider") as HTMLInputElement;
}

function openGoalEditor() {
	const edit = screen.getAllByRole("button", { name: /^(编辑|Edit)$/ })[0];
	fireEvent.click(edit);
}

/**
 * The goal card's own save/cancel buttons.
 *
 * The panel has several sections with their own 保存/取消 pairs, so the lookup
 * is scoped to the card that holds the priority slider rather than to the page.
 */
function formButton(label: RegExp): HTMLButtonElement {
	const slider = prioritySlider();
	const card = slider.closest(".rounded-xl") ?? document.body;
	const button = [...card.querySelectorAll("button")]
		.find((b) => label.test(b.textContent?.trim() ?? ""));
	if (!button) throw new Error(`no ${label} button in the goal form`);
	return button as HTMLButtonElement;
}

const saveButton = () => formButton(/^(保存|Save)$/);
const cancelButton = () => formButton(/^(取消|Cancel)$/);

beforeEach(async () => {
	vi.clearAllMocks();
	stubRadixSelect();
	learnerStore.profile = null;
	learnerStore.isSaving = false;
	learnerStore.isLoading = false;
	learnerApi.getLearningRecommendations.mockResolvedValue({ recommendations: [], generated_at: "" });
	learnerApi.getLearnerProfile.mockImplementation(async () => learnerStore.profile ?? profile([]));
	learnerApi.updateGoal.mockImplementation(async (goalId: string, patch: Partial<LearningGoal>) => {
		const stored = learnerStore.profile?.goals.find((g) => g.goal_id === goalId);
		return { ...(stored ?? goal()), ...patch, goal_id: goalId };
	});
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("D — reading an anomalous priority", () => {
	it("shows 0, 50 and 100 percent for normal values", async () => {
		for (const [value, expected] of [[0, "0%"], [0.5, "50%"], [1, "100%"]] as const) {
			learnerStore.profile = profile([goal({ priority: value })]);
			const { unmount } = render(<LearnerProfilePanel />);
			// The card prefixes the value with the field name (「· 优先级 50%」).
			await waitFor(() => expect(screen.getByText(new RegExp(`优先级 ${expected}$`))).toBeTruthy());
			unmount();
		}
	});

	it("shows an out-of-range value as an anomaly with its raw value, not 300%", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常 · 原始值 3/)).toBeTruthy());
		expect(screen.queryByText(/300%/)).toBeNull();
		// Not silently clamped either.
		expect(screen.queryByText(/优先级 100%/)).toBeNull();
	});

	it("shows a negative value as an anomaly", async () => {
		learnerStore.profile = profile([goal({ priority: -0.2 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常 · 原始值 -0\.2$/)).toBeTruthy());
		expect(screen.queryByText(/优先级 0%/)).toBeNull();
	});

	it("shows an unusable value as unavailable", async () => {
		learnerStore.profile = profile([goal({ priority: NaN })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级不可用/)).toBeTruthy());
		expect(screen.queryByText(/NaN%/)).toBeNull();
	});
});

describe("D — editing must not rewrite the raw value", () => {
	it("opening the editor leaves the stored value untouched", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();
		expect(learnerStore.profile!.goals[0].priority).toBe(3);
		// The slider parks at the end of its track; the draft still holds 3.
		expect(prioritySlider().value).toBe("100");
	});

	it("editing only the title does not overwrite the priority", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();

		const titleInput = document.querySelector("input:not([type=range])") as HTMLInputElement;
		fireEvent.change(titleInput, { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		const sent = learnerApi.updateGoal.mock.calls[0][1];
		// A title-only save must omit priority, not send the old value.
		expect(sent).not.toHaveProperty("priority");
	});

	it("cancelling keeps the original value", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();
		fireEvent.click(cancelButton());
		expect(learnerStore.profile!.goals[0].priority).toBe(3);
		expect(learnerApi.updateGoal).not.toHaveBeenCalled();
	});

	it("moving the slider is what applies a new, valid value", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();

		fireEvent.change(prioritySlider(), { target: { value: "40" } });
		// The editor now shows the chosen value, not the anomaly.
		expect(screen.getByText(/优先级 40%$/)).toBeTruthy();
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(learnerApi.updateGoal.mock.calls[0][1].priority).toBe(0.4);
	});

	it("a normal goal edits exactly as before", async () => {
		learnerStore.profile = profile([goal({ priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级 50%$/)).toBeTruthy());
		openGoalEditor();
		expect(prioritySlider().value).toBe("50");
		fireEvent.change(prioritySlider(), { target: { value: "80" } });
		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(learnerApi.updateGoal.mock.calls[0][1].priority).toBe(0.8);
	});
});

describe("R1 F01 — explicit priority ownership", () => {
	async function mountPriority(value: unknown) {
		learnerStore.profile = profile([goal({ priority: value as number })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级/)).toBeTruthy());
		openGoalEditor();
	}
	function titleInput(): HTMLInputElement {
		return prioritySlider().closest(".rounded-xl")!.querySelector("input:not([type=range])") as HTMLInputElement;
	}
	for (const value of [3, -0.2, 0.5, undefined, null, NaN]) {
		it(`title-only edit does not submit priority for ${String(value)}`, async () => {
			await mountPriority(value);
			fireEvent.change(titleInput(), { target: { value: "新标题" } });
			fireEvent.click(saveButton());
			await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(1));
			expect(learnerApi.updateGoal.mock.calls[0][1]).not.toHaveProperty("priority");
		});
	}
	it("status-only edit omits valid stored priority", async () => {
		await mountPriority(0.5);
		const form = prioritySlider().closest(".rounded-xl")!;
		const status = [...form.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("进行中"));
		expect(status).toBeTruthy();
		fireEvent.click(status!);
		fireEvent.click(screen.getByRole("option", { name: /暂停/ }));
		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(1));
		expect(learnerApi.updateGoal.mock.calls[0][1]).toHaveProperty("status", "paused");
		expect(learnerApi.updateGoal.mock.calls[0][1]).not.toHaveProperty("priority");
	});
	for (const [raw, percent, expected] of [[3, "0", 0], [3, "40", 0.4], [-0.2, "100", 1]] as const) {
		it(`explicitly changes ${raw} to ${expected}`, async () => {
			await mountPriority(raw);
			if (percent === "0") {
				fireEvent.click(formButton(/^(设为 0%)$/));
			} else if (percent === "100") {
				fireEvent.click(formButton(/^(设为 100%)$/));
			} else {
				fireEvent.change(prioritySlider(), { target: { value: percent } });
			}
			fireEvent.click(saveButton());
			await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(1));
			expect(learnerApi.updateGoal.mock.calls[0][1].priority).toBe(expected);
		});
	}
	it("a failed explicit edit keeps its draft and can retry", async () => {
		await mountPriority(3);
		fireEvent.click(formButton(/^(设为 0%)$/));
		learnerApi.updateGoal.mockRejectedValueOnce(new Error("offline"));
		fireEvent.click(saveButton());
		await waitFor(() => expect(screen.getByText("offline")).toBeTruthy());
		expect(prioritySlider().value).toBe("0");
		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(2));
		expect(learnerApi.updateGoal.mock.calls[1][1].priority).toBe(0);
	});
	it("cancel and reopen reset explicit-edit ownership", async () => {
		await mountPriority(3);
		fireEvent.click(formButton(/^(设为 0%)$/));
		fireEvent.click(cancelButton());
		expect(learnerApi.updateGoal).not.toHaveBeenCalled();
		openGoalEditor();
		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(1));
		expect(learnerApi.updateGoal.mock.calls[0][1]).not.toHaveProperty("priority");
	});
	it("a server-side update while editing is retained when priority is untouched", async () => {
		await mountPriority(0.5);
		const latest = goal({ priority: 0.85 });
		learnerStore.profile = profile([latest]);
		learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
		await act(async () => { await learnerStore.load(); });
		fireEvent.change(titleInput(), { target: { value: "保留服务端优先级" } });
		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(1));
		expect(learnerApi.updateGoal.mock.calls[0][1]).not.toHaveProperty("priority");
		await waitFor(() => expect(learnerStore.profile!.goals[0].priority).toBe(0.85));
	});
});
