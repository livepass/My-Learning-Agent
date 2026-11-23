// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/index.js";
import type { PublicAttemptView } from "../../../api/learning.js";
import { PracticeAnswerPanel, type PracticeAnswerPanelProps } from "./PracticeAnswerPanel.js";

/**
 * E4.9h-P2-1 — the answer region.
 *
 * These cases pin the three-step separation the product depends on: submit is
 * not evaluate, evaluate is not record, and a failure keeps the saved answer.
 */

const attempt = (overrides: Partial<PublicAttemptView> = {}): PublicAttemptView => ({
	attempt_id: "a1",
	question_id: "q1",
	question_version: "v1",
	answer: "服务端保存的答案",
	accepted_at: "2026-11-22T00:00:00.000Z",
	stage: "answer_saved",
	retryable: false,
	evaluation_attempts: 0,
	...overrides,
});

function panel(overrides: Partial<PracticeAnswerPanelProps> = {}) {
	const props: PracticeAnswerPanelProps = {
		answerRef: createRef<HTMLTextAreaElement>(),
		answer: "",
		draft: "",
		readOnly: false,
		disabled: false,
		attempt: undefined,
		hasAttempt: false,
		resultLabel: null,
		reviewActive: false,
		submitting: false,
		evaluating: false,
		finalizing: false,
		submitError: null,
		evaluateError: null,
		finalizeError: null,
		onAnswerChange: vi.fn(),
		onSubmit: vi.fn(),
		onEvaluate: vi.fn(),
		onRecord: vi.fn(),
		onViewProfile: vi.fn(),
		onBackToToday: vi.fn(),
		...overrides,
	};
	render(<PracticeAnswerPanel {...props} />);
	return props;
}

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("PracticeAnswerPanel — editing and submit", () => {
	it("T07 lets the learner edit before submitting", () => {
		const props = panel({ draft: "半句" });

		const input = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
		expect(input.disabled).toBe(false);
		fireEvent.change(input, { target: { value: "半句话" } });
		expect(props.onAnswerChange).toHaveBeenCalledWith("半句话");
	});

	it("disables submit while the draft is empty", () => {
		panel({ draft: "" });

		expect((screen.getByRole("button", { name: /提交作答/ }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("enables submit once there is a draft, and does not evaluate", () => {
		const props = panel({ draft: "一个答案" });

		const submit = screen.getByRole("button", { name: /提交作答/ }) as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
		fireEvent.click(submit);

		expect(props.onSubmit).toHaveBeenCalledTimes(1);
		// Submitting is not scoring: no evaluate call, no feedback rendered.
		expect(props.onEvaluate).not.toHaveBeenCalled();
		expect(screen.queryByText("评分反馈")).toBeNull();
	});

	it("keeps the submit action disabled while the save is in flight", () => {
		panel({ draft: "一个答案", submitting: true });

		expect((screen.getByRole("button", { name: /正在保存/ }) as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("PracticeAnswerPanel — submitted, not evaluated", () => {
	it("T08 makes a submitted answer read-only and shows no score", () => {
		panel({ answer: "服务端保存的答案", readOnly: true, hasAttempt: true, attempt: attempt() });

		const input = screen.getByLabelText("你的回答") as HTMLTextAreaElement;
		expect(input.disabled).toBe(true);
		expect(input.value).toBe("服务端保存的答案");
		// T09: nothing scored yet.
		expect(screen.queryByText("评分反馈")).toBeNull();
		expect(screen.queryByText(/\/ 100/)).toBeNull();
	});

	it("offers evaluation as its own step", () => {
		const props = panel({ answer: "a", readOnly: true, hasAttempt: true, attempt: attempt() });

		fireEvent.click(screen.getByRole("button", { name: /开始评分/ }));
		expect(props.onEvaluate).toHaveBeenCalledTimes(1);
		expect(props.onRecord).not.toHaveBeenCalled();
	});

	it("T10 keeps the saved answer when evaluation failed and offers a retry", () => {
		const props = panel({
			answer: "服务端保存的答案",
			readOnly: true,
			hasAttempt: true,
			attempt: attempt({
				stage: "evaluation_failed",
				retryable: true,
				failure: { code: "model_unavailable", message: "评分服务暂时不可用。" },
			}),
		});

		expect((screen.getByLabelText("你的回答") as HTMLTextAreaElement).value).toBe("服务端保存的答案");
		expect(screen.getByText(/评分服务暂时不可用/)).toBeTruthy();
		const retry = screen.getByRole("button", { name: /重新评分/ }) as HTMLButtonElement;
		expect(retry.disabled).toBe(false);
		fireEvent.click(retry);
		expect(props.onEvaluate).toHaveBeenCalledTimes(1);
	});

	it("does not allow a retry once the server says it is exhausted", () => {
		panel({
			answer: "a",
			readOnly: true,
			hasAttempt: true,
			attempt: attempt({ stage: "evaluation_failed", retryable: false, failure: { code: "limit", message: "已达上限。" } }),
		});

		expect((screen.getByRole("button", { name: /重新评分/ }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/评分重试次数已用尽/)).toBeTruthy();
	});
});

describe("PracticeAnswerPanel — evaluated and recorded", () => {
	it("T12 keeps recording as an independent step after scoring", () => {
		const props = panel({
			answer: "a",
			readOnly: true,
			hasAttempt: true,
			attempt: attempt({ stage: "evaluated", assessment: { result: "partial", feedback: "还行", criteria: [] } }),
			resultLabel: "部分正确",
		});

		expect(screen.getByText("部分正确")).toBeTruthy();
		// The score is visible, but evidence is NOT recorded yet.
		expect(screen.getByRole("button", { name: /记录本次学习结果/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /开始评分/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /记录本次学习结果/ }));
		expect(props.onRecord).toHaveBeenCalledTimes(1);
	});

	it("T13 shows the completed state and the profile entry", () => {
		const props = panel({
			answer: "a",
			readOnly: true,
			hasAttempt: true,
			attempt: attempt({ stage: "completed", assessment: { result: "correct", feedback: "很好", criteria: [] } }),
		});

		expect(screen.getByText(/本题已记录/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /记录本次学习结果/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /查看我的学习档案/ }));
		expect(props.onViewProfile).toHaveBeenCalledTimes(1);
	});

	it("offers the today entry for a completed review", () => {
		const props = panel({
			answer: "a",
			readOnly: true,
			hasAttempt: true,
			reviewActive: true,
			attempt: attempt({ stage: "completed", assessment: { result: "correct", feedback: "很好", criteria: [] } }),
		});

		expect(screen.getByText("本次复习作答已记录")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /返回今日学习/ }));
		expect(props.onBackToToday).toHaveBeenCalledTimes(1);
	});

	it("disables the record action while it is saving", () => {
		panel({
			answer: "a",
			readOnly: true,
			hasAttempt: true,
			finalizing: true,
			attempt: attempt({ stage: "evaluated", assessment: { result: "partial", feedback: "f", criteria: [] } }),
		});

		expect((screen.getByRole("button", { name: /正在记录/ }) as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("PracticeAnswerPanel — errors and i18n", () => {
	it("surfaces each step's own error without claiming the next step happened", () => {
		panel({ draft: "a", submitError: "提交失败：网络中断" });
		expect(screen.getByRole("alert").textContent).toContain("提交失败");

		cleanup();
		panel({ answer: "a", readOnly: true, hasAttempt: true, attempt: attempt(), evaluateError: "评分失败：服务不可用" });
		expect(screen.getByRole("alert").textContent).toContain("评分失败");

		cleanup();
		panel({
			answer: "a", readOnly: true, hasAttempt: true,
			attempt: attempt({ stage: "evaluated", assessment: { result: "partial", feedback: "f", criteria: [] } }),
			finalizeError: "记录失败：请重试",
		});
		expect(screen.getByRole("alert").textContent).toContain("记录失败");
	});

	it("T15 renders in English", async () => {
		panel({ draft: "answer" });
		await i18n.changeLanguage("en");

		expect(screen.getByLabelText("Your answer")).toBeTruthy();
		expect(screen.getByRole("button", { name: /Submit/ })).toBeTruthy();
	});
});
