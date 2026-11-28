// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import { LearnerProfilePanel } from "../LearnerProfilePanel.js";
import { learnerStore } from "../../stores/learner-store.js";
import type { LearnerProfile, LearningGoal } from "../../types/learner.js";

/**
 * E4.9i-P2-6 (T08 D) / E4.9i-P2-6-R1 (F01) — an anomalous stored priority must
 * not be rewritten by merely opening, editing or cancelling the goal editor,
 * and an untouched priority must not be sent at all.
 *
 * The bug this pins: the edit form drives a 0–100 slider from `priority * 100`.
 * A stored `3` puts the value at 300, and while the browser clamps the *thumb*
 * to 100 it fires no change event — so the old label read `300%`, and a save
 * wrote back whatever the slider thought. P2-6 stopped the value from changing
 * on screen, but still re-sent it, and the server treats the *presence* of
 * `priority` as "a human set this field" (`server/routes/learner.ts`). The
 * request body is therefore the thing under test here, not just the stored
 * value: a title-only save must not contain `priority` at all.
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

function titleInput(): HTMLInputElement {
	return document.querySelector("input:not([type=range])") as HTMLInputElement;
}

/** The status <Select> is the second combobox in the editor (type is first). */
function statusTrigger(): HTMLElement {
	const combos = screen.getAllByRole("combobox");
	return combos[1] as HTMLElement;
}

async function chooseStatus(label: string) {
	fireEvent.keyDown(statusTrigger(), { key: "ArrowDown" });
	const option = await screen.findByRole("option", { name: label });
	fireEvent.click(option);
}

const sentPatch = (callIndex = 0) => learnerApi.updateGoal.mock.calls[callIndex][1] as Partial<LearningGoal>;

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

describe("F01 — an untouched priority is not sent", () => {
	it("opening the editor leaves the stored value untouched", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();
		expect(learnerStore.profile!.goals[0].priority).toBe(3);
		// The slider parks at the end of its track; the draft still holds 3.
		expect(prioritySlider().value).toBe("100");
	});

	it("editing only the title omits priority from the PATCH", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();

		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		const sent = sentPatch();
		// The key must be absent, not equal to the old value: the server stamps
		// ownership from the key's presence, so `priority: 3` would still count
		// as a human edit.
		expect(Object.keys(sent)).not.toContain("priority");
		expect(sent.title).toBe("改过的标题");
		expect(learnerStore.profile!.goals[0].priority).toBe(3);
	});

	it("editing only the status omits priority from the PATCH", async () => {
		learnerStore.profile = profile([goal({ priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级 50%$/)).toBeTruthy());
		openGoalEditor();

		await chooseStatus("已暂停");
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		const sent = sentPatch();
		expect(Object.keys(sent)).not.toContain("priority");
		expect(sent.status).toBe("paused");
	});

	it("a title-only edit on a normal goal does not send priority either", async () => {
		learnerStore.profile = profile([goal({ priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级 50%$/)).toBeTruthy());
		openGoalEditor();

		fireEvent.change(titleInput(), { target: { value: "新的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(Object.keys(sentPatch())).toEqual(["title"]);
	});

	it("a title-only edit on a negative anomaly does not send priority", async () => {
		learnerStore.profile = profile([goal({ priority: -0.2 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常 · 原始值 -0\.2$/)).toBeTruthy());
		openGoalEditor();

		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(Object.keys(sentPatch())).not.toContain("priority");
	});

	it("a goal whose priority is missing saves a title without inventing one", async () => {
		const missing = goal();
		delete (missing as Partial<LearningGoal>).priority;
		learnerStore.profile = profile([missing]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级不可用/)).toBeTruthy());
		openGoalEditor();

		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(Object.keys(sentPatch())).not.toContain("priority");
	});

	it("a goal whose priority is invalid saves a title without inventing one", async () => {
		learnerStore.profile = profile([goal({ priority: NaN })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级不可用/)).toBeTruthy());
		openGoalEditor();

		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(Object.keys(sentPatch())).not.toContain("priority");
	});

	it("saving with nothing changed issues no request at all", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();

		fireEvent.click(saveButton());
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(learnerApi.updateGoal).not.toHaveBeenCalled();
	});
});

describe("F01 — an actively changed priority is sent", () => {
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
		expect(sentPatch().priority).toBe(0.4);
	});

	it("accepts 0 and 0.4 as chosen values by moving the slider", async () => {
		// One value per render: reusing a mounted panel across iterations would
		// test the store's update path, not the editor's send rule.
		//
		// 1 is deliberately absent here. For a stored `3` the thumb already sits
		// at 100, so assigning 100 is not a change and the browser fires nothing —
		// that endpoint is reached through the explicit button instead, covered by
		// 「the endpoint button makes 100% an explicit choice」.
		for (const [sliderValue, expected] of [["0", 0], ["40", 0.4]] as const) {
			cleanup();
			learnerStore.profile = profile([goal({ priority: 3 })]);
			learnerApi.updateGoal.mockClear();
			render(<LearnerProfilePanel />);
			await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
			openGoalEditor();

			fireEvent.change(prioritySlider(), { target: { value: sliderValue } });
			fireEvent.click(saveButton());
			await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(1));
			expect(sentPatch().priority, sliderValue).toBe(expected);
		}
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
		expect(sentPatch().priority).toBe(0.8);
	});

	it("the endpoint button makes 100% an explicit choice on an anomalous goal", async () => {
		// The thumb already sits at 100 for `priority = 3`, so clicking the track's
		// end fires no `change`; without an explicit action the user could never
		// pick that endpoint as the new value.
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();

		const endpoint = screen.getByRole("button", { name: /将优先级设为 100%/ });
		fireEvent.click(endpoint);
		expect(screen.getByText(/优先级 100%$/)).toBeTruthy();
		expect(screen.queryByText(/优先级异常/)).toBeNull();

		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch().priority).toBe(1);
	});

	it("the endpoint button makes 0% an explicit choice on a negative anomaly", async () => {
		learnerStore.profile = profile([goal({ priority: -0.2 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();

		fireEvent.click(screen.getByRole("button", { name: /将优先级设为 0%/ }));
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch().priority).toBe(0);
	});

	it("the endpoint button is absent for a normal priority", async () => {
		learnerStore.profile = profile([goal({ priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级 50%$/)).toBeTruthy());
		openGoalEditor();
		expect(screen.queryByRole("button", { name: /将优先级设为/ })).toBeNull();
	});
});

describe("F01 — cancel, failure and passive updates", () => {
	it("cancelling keeps the original value and sends nothing", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();
		fireEvent.change(titleInput(), { target: { value: "临时改的标题" } });
		fireEvent.change(prioritySlider(), { target: { value: "20" } });
		fireEvent.click(cancelButton());
		expect(learnerStore.profile!.goals[0].priority).toBe(3);
		expect(learnerApi.updateGoal).not.toHaveBeenCalled();
		expect(screen.getByText(/优先级异常 · 原始值 3/)).toBeTruthy();
	});

	it("reopening the editor resets the touch state", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();
		// Touch the priority, then cancel: the next session must not inherit it.
		fireEvent.change(prioritySlider(), { target: { value: "20" } });
		fireEvent.click(cancelButton());

		openGoalEditor();
		fireEvent.change(titleInput(), { target: { value: "只改标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(Object.keys(sentPatch())).not.toContain("priority");
	});

	it("a failed save keeps the draft and the chosen priority", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		learnerApi.updateGoal.mockRejectedValueOnce(new Error("服务端暂时不可用"));
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();

		fireEvent.change(titleInput(), { target: { value: "没保存的标题" } });
		fireEvent.change(prioritySlider(), { target: { value: "40" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(screen.getByText(/服务端暂时不可用/)).toBeTruthy());
		expect((titleInput() as HTMLInputElement).value).toBe("没保存的标题");
		expect(prioritySlider().value).toBe("40");
		// The store still holds the server's value.
		expect(learnerStore.profile!.goals[0].priority).toBe(3);
	});

	it("a priority updated on the server while editing is not overwritten by a title save", async () => {
		learnerStore.profile = profile([goal({ priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级 50%$/)).toBeTruthy());
		openGoalEditor();
		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });

		// The server (another tab, or the projection) moves the priority to 0.9.
		learnerStore.profile = profile([goal({ priority: 0.9 })]);
		learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
		await act(async () => { await learnerStore.load(); });

		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		// The save carries the title only; the newer priority is left alone.
		expect(Object.keys(sentPatch())).toEqual(["title"]);
	});

	it("an anomalous priority updated on the server while editing is not overwritten", async () => {
		learnerStore.profile = profile([goal({ priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常/)).toBeTruthy());
		openGoalEditor();
		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });

		learnerStore.profile = profile([goal({ priority: -1 })]);
		learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
		await act(async () => { await learnerStore.load(); });

		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(Object.keys(sentPatch())).not.toContain("priority");
	});
});

/**
 * E4.9i-P2-6-R2 (T01/T02) — the editor compares the draft against the record it
 * started from, not against whatever the server holds at save time.
 *
 * The bug these pin: `goal` is the live prop and is replaced whenever the store
 * reloads, while `draft` keeps the values the user saw when they opened the
 * editor. Diffing the draft against the *new* record turns every server-side
 * change into a "user edit" — the stale draft value is re-sent, overwriting the
 * newer one and refreshing `manual.<field>` for a field the user never touched.
 *
 * Every case below therefore asserts the whole request body (or its exact key
 * set) rather than one value, because "sent the right priority" says nothing
 * about the status that came along with it.
 */

/**
 * Apply a passive server update while an editor is open.
 *
 * `load()` is the real refresh path used by the panel; pointing it at a new
 * profile is how a background update arrives. The editor must survive it with
 * its draft and its opening snapshot intact.
 */
async function passiveUpdate(patch: Partial<LearningGoal>) {
	// Start from the record already on screen so a scenario changes exactly the
	// fields it names — rebuilding from defaults would silently "update" the
	// title too and blur which field the assertion is about.
	const next = { ...(learnerStore.profile?.goals[0] ?? goal()), ...patch };
	next.success_criteria = [...next.success_criteria];
	learnerStore.profile = profile([next]);
	learnerApi.getLearnerProfile.mockResolvedValue(learnerStore.profile);
	await act(async () => { await learnerStore.load(); });
}

/** The goal as the store now holds it (i.e. the server's record). */
const storedGoal = () => learnerStore.profile!.goals[0];

describe("R2 S01-S10 — a passively updated field is not sent back", () => {
	it("S01 — the server changes the title, the user changes the priority", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ title: "学习英语（服务端更新）", priority: 0.5 });
		fireEvent.change(prioritySlider(), { target: { value: "40" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ priority: 0.4 });
		// The newer title is still the stored one: it was never submitted.
		expect(storedGoal().title).toBe("学习英语（服务端更新）");
	});

	it("S02 — the server changes the status, the user changes the priority", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ status: "paused" });
		fireEvent.change(prioritySlider(), { target: { value: "40" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ priority: 0.4 });
		expect(storedGoal().status).toBe("paused");
	});

	it("S03 — the server changes the type, the user changes the title", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语" })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ type: "exam" });
		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ title: "改过的标题" });
		expect(storedGoal().type).toBe("exam");
	});

	it("S04 — the server changes the success criteria, the user changes the title", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", success_criteria: ["旧标准"] })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ success_criteria: ["服务端新标准"] });
		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ title: "改过的标题" });
		expect(storedGoal().success_criteria).toEqual(["服务端新标准"]);
	});

	it("S05 — the server changes the priority, the user changes the title", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ priority: 0.9 });
		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ title: "改过的标题" });
		expect(storedGoal().priority).toBe(0.9);
	});

	it("S06 — several fields change on the server, the user changes only the priority", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", success_criteria: ["旧标准"] })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({
			title: "服务端标题",
			type: "exam",
			status: "paused",
			success_criteria: ["服务端新标准"],
		});
		fireEvent.change(prioritySlider(), { target: { value: "40" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ priority: 0.4 });
		const stored = storedGoal();
		expect(stored.title).toBe("服务端标题");
		expect(stored.type).toBe("exam");
		expect(stored.status).toBe("paused");
		expect(stored.success_criteria).toEqual(["服务端新标准"]);
	});

	it("S07 — every editable field changes on the server, the user saves nothing", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", success_criteria: ["旧标准"] })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({
			title: "服务端标题",
			type: "exam",
			status: "paused",
			priority: 0.8,
			success_criteria: ["服务端新标准"],
		});
		fireEvent.click(saveButton());

		// Nothing was edited, so there is nothing to save — the closing must not
		// turn the server's newer record into a "human edit" of stale values.
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(learnerApi.updateGoal).not.toHaveBeenCalled();
		const stored = storedGoal();
		expect(stored.title).toBe("服务端标题");
		expect(stored.status).toBe("paused");
		expect(stored.priority).toBe(0.8);
	});

	it("S08 — the server changes the title, the user changes the status", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语" })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ title: "服务端标题" });
		await chooseStatus("已暂停");
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ status: "paused" });
		expect(storedGoal().title).toBe("服务端标题");
	});

	it("S09 — the server changes the status, the user changes the title", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语" })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ status: "completed" });
		fireEvent.change(titleInput(), { target: { value: "改过的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ title: "改过的标题" });
		expect(storedGoal().status).toBe("completed");
	});

	it("S10 — the server changes the success criteria, the user changes the priority", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", success_criteria: ["旧标准"] })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ success_criteria: ["服务端新标准"] });
		fireEvent.change(prioritySlider(), { target: { value: "40" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ priority: 0.4 });
		expect(storedGoal().success_criteria).toEqual(["服务端新标准"]);
	});
});

describe("R2 S11-S18 — the snapshot's lifecycle", () => {
	it("S11 — a title restored to its opening value is not submitted", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语" })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		fireEvent.change(titleInput(), { target: { value: "临时改的标题" } });
		fireEvent.change(titleInput(), { target: { value: "学习英语" } });
		fireEvent.click(saveButton());

		// Comparing against the opening value, not against "anything typed", is
		// what makes this a no-op.
		await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
		expect(learnerApi.updateGoal).not.toHaveBeenCalled();
	});

	it("S12 — a passive update followed by cancel sends nothing", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", priority: 0.5 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ title: "服务端标题", status: "paused" });
		fireEvent.change(titleInput(), { target: { value: "临时改的标题" } });
		fireEvent.click(cancelButton());

		expect(learnerApi.updateGoal).not.toHaveBeenCalled();
		// The card shows the server's record, not the discarded draft.
		expect(await screen.findByText("服务端标题")).toBeTruthy();
		expect(screen.queryByText("临时改的标题")).toBeNull();
	});

	it("S13 — reopening after a cancel starts from the newest server record", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语" })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ title: "服务端标题" });
		fireEvent.change(titleInput(), { target: { value: "临时改的标题" } });
		fireEvent.click(cancelButton());
		await screen.findByText("服务端标题");

		openGoalEditor();
		expect(titleInput().value).toBe("服务端标题");
		await chooseStatus("已暂停");
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		// The new snapshot is the reloaded record, so the title matches it and
		// stays out of the body.
		expect(sentPatch()).toEqual({ status: "paused" });
	});

	it("S14 — after a failed save and a passive update, a retry sends only the user's field", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语" })]);
		learnerApi.updateGoal.mockRejectedValueOnce(new Error("服务端暂时不可用"));
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await chooseStatus("已暂停");
		fireEvent.click(saveButton());
		await waitFor(() => expect(screen.getByText("服务端暂时不可用")).toBeTruthy());

		// The failure keeps the snapshot and the draft; a passive update in
		// between must not turn the title into part of the retry.
		await passiveUpdate({ title: "服务端标题" });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalledTimes(2));
		expect(sentPatch(1)).toEqual({ status: "paused" });
		expect(storedGoal().title).toBe("服务端标题");
	});

	it("S15 — editing the success criteria leaves the opening array intact", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", success_criteria: ["旧标准"] })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		const originalArray = storedGoal().success_criteria;
		openGoalEditor();

		const textarea = screen.getByRole("textbox", { name: /成功标准/ });
		fireEvent.change(textarea, { target: { value: "标准一\n标准二" } });

		// Typing must not mutate the server's array through a shared reference.
		expect(originalArray).toEqual(["旧标准"]);
		expect(storedGoal().success_criteria).toEqual(["旧标准"]);

		fireEvent.click(saveButton());
		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ success_criteria: ["标准一", "标准二"] });
	});

	it("S16 — an anomalous 3 explicitly set to 1 is submitted after a passive status change", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", priority: 3 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常 · 原始值 3/)).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ status: "paused" });
		fireEvent.click(screen.getByRole("button", { name: /将优先级设为 100%/ }));
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ priority: 1 });
		expect(storedGoal().priority).toBe(1);
	});

	it("S17 — an anomalous -0.2 explicitly set to 0 is submitted", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语", priority: -0.2 })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText(/优先级异常 · 原始值 -0\.2/)).toBeTruthy());
		openGoalEditor();

		fireEvent.click(screen.getByRole("button", { name: /将优先级设为 0%/ }));
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ priority: 0 });
	});

	it("S18 — the same field changed by the user and the server follows the manual-patch rule", async () => {
		learnerStore.profile = profile([goal({ title: "学习英语" })]);
		render(<LearnerProfilePanel />);
		await waitFor(() => expect(screen.getByText("学习英语")).toBeTruthy());
		openGoalEditor();

		await passiveUpdate({ title: "服务端标题" });
		// The user edits the same field afterwards: this round declares the
		// submitted value to win (no conflict dialog, no version lock).
		fireEvent.change(titleInput(), { target: { value: "用户最后输入的标题" } });
		fireEvent.click(saveButton());

		await waitFor(() => expect(learnerApi.updateGoal).toHaveBeenCalled());
		expect(sentPatch()).toEqual({ title: "用户最后输入的标题" });
		expect(storedGoal().title).toBe("用户最后输入的标题");
	});
});
