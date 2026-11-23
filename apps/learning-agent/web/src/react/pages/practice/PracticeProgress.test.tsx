// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n/index.js";
import {
	PracticeProgress,
	derivePracticeProgress,
	type PracticeProgressInput,
	type PracticeProgressState,
} from "./PracticeProgress.js";

/**
 * E4.9h-P2-2 — 提交答案 → AI 评分 → 记录证据.
 *
 * The pure mapping is tested on its own because every product rule lives
 * there: a request is never success, a failed score is never a score, and the
 * two intermediate recording stages are never "recorded".
 */

const input = (overrides: Partial<PracticeProgressInput> = {}): PracticeProgressInput => ({
	stage: undefined,
	hasAttempt: false,
	submitting: false,
	evaluating: false,
	finalizing: false,
	submitFailed: false,
	evaluateFailed: false,
	finalizeFailed: false,
	...overrides,
});

const states = (state: PracticeProgressState) => [state.submit, state.evaluate, state.record];

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("derivePracticeProgress — submit", () => {
	it("T01 marks all three steps unfinished before an answer exists", () => {
		const state = derivePracticeProgress(input());
		expect(state.submit).toBe("active");
		expect(state.evaluate).toBe("pending");
		expect(state.record).toBe("pending");
	});

	it("T02 shows only the first step working while the save is in flight", () => {
		const state = derivePracticeProgress(input({ submitting: true }));
		expect(state.submit).toBe("working");
		expect(state.evaluate).toBe("pending");
		expect(state.record).toBe("pending");
	});

	it("T03 completes only the first step once the server saved the answer", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "answer_saved" }));
		expect(states(state)).toEqual(["done", "active", "pending"]);
	});

	it("T04 keeps the answer saved when the attempt view has not refreshed yet", () => {
		// `pending_attempt_id` is written before `currentAttempt` is re-read, so
		// `hasAttempt` is true while `stage` is still undefined. The progress must
		// not fall back to "not submitted".
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: undefined }));
		expect(state.submit).toBe("done");
		expect(state.evaluate).toBe("active");
	});

	it("marks the first step failed, not done, when the save failed", () => {
		const state = derivePracticeProgress(input({ submitFailed: true }));
		expect(state.submit).toBe("failed");
		// A failed step is not advertised as done, and the next one is not
		// presented as the current action.
		expect(state.evaluate).toBe("pending");
		expect(state.record).toBe("pending");
	});
});

describe("derivePracticeProgress — evaluation", () => {
	it("T05 shows the second step working while scoring", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "answer_saved", evaluating: true }));
		expect(states(state)).toEqual(["done", "working", "pending"]);
	});

	it("T05b treats the server's own evaluating stage as working", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "evaluating" }));
		expect(states(state)).toEqual(["done", "working", "pending"]);
	});

	it("T06 completes the first two steps and leaves evidence pending", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "evaluated" }));
		expect(states(state)).toEqual(["done", "done", "active"]);
	});

	it("T07 marks the second step failed and never completes the third", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "evaluation_failed" }));
		expect(states(state)).toEqual(["done", "failed", "pending"]);
	});

	it("T08 keeps a failed retry as working, not as a fresh failure", () => {
		const state = derivePracticeProgress(input({
			hasAttempt: true, stage: "evaluation_failed", evaluating: true,
		}));
		expect(states(state)).toEqual(["done", "working", "pending"]);
	});

	it("T09 never paints an exhausted retry as scored", () => {
		// The retry limit is the server's (`retryable`), which this component does
		// not read. An exhausted failure is still a failure.
		const state = derivePracticeProgress(input({
			hasAttempt: true, stage: "evaluation_failed", evaluateFailed: true,
		}));
		expect(states(state)).toEqual(["done", "failed", "pending"]);
	});
});

describe("derivePracticeProgress — recording", () => {
	it("T10 shows the third step working while the record request is in flight", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "evaluated", finalizing: true }));
		expect(states(state)).toEqual(["done", "done", "working"]);
	});

	it("T11 marks the third step failed without claiming it was recorded", () => {
		const state = derivePracticeProgress(input({
			hasAttempt: true, stage: "evaluated", finalizeFailed: true,
		}));
		expect(states(state)).toEqual(["done", "done", "failed"]);
	});

	it("T12 does not treat evidence_recorded as the finished flow", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "evidence_recorded" }));
		expect(states(state)).toEqual(["done", "done", "working"]);
	});

	it("T13 does not treat profile_projected as the finished flow", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "profile_projected" }));
		expect(states(state)).toEqual(["done", "done", "working"]);
	});

	it("T14 completes all three steps only at the server's completed stage", () => {
		const state = derivePracticeProgress(input({ hasAttempt: true, stage: "completed" }));
		expect(states(state)).toEqual(["done", "done", "done"]);
	});

	it("lets the server stage win over a stale local failure flag", () => {
		const state = derivePracticeProgress(input({
			hasAttempt: true, stage: "completed", finalizeFailed: true,
		}));
		expect(states(state)).toEqual(["done", "done", "done"]);
	});
});

describe("PracticeProgress — rendering", () => {
	const renderState = (state: PracticeProgressState, recording = false) => {
		render(<PracticeProgress state={state} recording={recording} />);
	};

	it("T18 renders all three steps in order in English", async () => {
		await i18n.changeLanguage("en");
		renderState({ submit: "active", evaluate: "pending", record: "pending" });

		const list = screen.getByRole("list", { name: "Progress for this practice" });
		expect(list.textContent).toContain("Submit answer");
		expect(list.textContent).toContain("AI scoring");
		expect(list.textContent).toContain("Record evidence");
		expect(list.textContent).toContain("Not submitted");
		expect(list.textContent).toContain("Not scored");
		expect(list.textContent).toContain("Not recorded");
	});

	it("renders the Chinese labels and states", () => {
		renderState({ submit: "done", evaluate: "working", record: "pending" });

		const list = screen.getByRole("list", { name: "本次练习进度" });
		expect(list.textContent).toContain("提交答案");
		expect(list.textContent).toContain("答案已保存");
		expect(list.textContent).toContain("评分中");
		expect(list.textContent).toContain("待记录");
	});

	it("distinguishes the learner's own recording from an internal stage", () => {
		renderState({ submit: "done", evaluate: "done", record: "working" }, true);
		expect(screen.getByText("正在记录")).toBeTruthy();
		expect(screen.queryByText("记录处理中")).toBeNull();

		cleanup();
		// `evidence_recorded` / `profile_projected`: the server is still working,
		// so the copy must not claim a finished record.
		renderState({ submit: "done", evaluate: "done", record: "working" }, false);
		expect(screen.getByText("记录处理中")).toBeTruthy();
		expect(screen.queryByText("正在记录")).toBeNull();
	});

	it("marks state with more than colour: icons and the step number", () => {
		const { container } = render(
			<PracticeProgress state={{ submit: "done", evaluate: "failed", record: "pending" }} recording={false} />,
		);
		const steps = container.querySelectorAll(".mla-practice-progress-step");
		expect(steps[0]?.getAttribute("data-state")).toBe("done");
		expect(steps[1]?.getAttribute("data-state")).toBe("failed");
		expect(steps[2]?.getAttribute("data-state")).toBe("pending");
		// Done carries a check icon; pending keeps its number.
		expect(steps[0]?.querySelector("svg")).toBeTruthy();
		expect(steps[2]?.querySelector(".mla-practice-progress-dot")?.textContent).toBe("3");
	});

	it("marks the current step for assistive tech without calling it done", () => {
		renderState({ submit: "active", evaluate: "pending", record: "pending" });
		const current = screen.getByRole("listitem", { current: "step" });
		expect(current.getAttribute("data-state")).toBe("active");
	});
});
