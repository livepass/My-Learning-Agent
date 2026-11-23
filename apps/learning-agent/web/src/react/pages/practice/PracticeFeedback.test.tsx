// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n/index.js";
import type { PublicAssessment } from "../../../api/learning.js";
import { PracticeFeedback } from "./PracticeFeedback.js";

/**
 * E4.9h-P2-1 — the scored feedback block.
 *
 * Display only: the page chooses which assessment applies. These cases pin the
 * rendering rules, including that nothing appears without an assessment.
 */

const assessment: PublicAssessment = {
	result: "partial",
	score: 0.75,
	feedback: "你正确指出了求值时机，但漏了包装函数仍会调用原函数。",
	criteria: [
		{ criterion_id: "timing", judgment: "met", explanation: "说明定义时求值。" },
		{ criterion_id: "call-path", judgment: "partially_met", explanation: "未区分两件事。" },
	],
};

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("PracticeFeedback — rendering", () => {
	it("renders nothing without an assessment", () => {
		render(<PracticeFeedback assessment={null} />);

		expect(document.querySelector(".mla-practice-feedback")).toBeNull();
		expect(screen.queryByText("评分反馈")).toBeNull();
	});

	it("T11 shows the feedback text, the score and every criterion", () => {
		render(<PracticeFeedback assessment={assessment} />);

		expect(screen.getByText("评分反馈")).toBeTruthy();
		expect(screen.getByText("你正确指出了求值时机，但漏了包装函数仍会调用原函数。")).toBeTruthy();
		// Score is shown as a rounded percentage.
		expect(screen.getByText(/75/)).toBeTruthy();

		const items = screen.getAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]!.textContent).toContain("timing");
		expect(items[0]!.textContent).toContain("说明定义时求值。");
		expect(items[1]!.textContent).toContain("call-path");
	});

	it("explains an uncertain result instead of inventing a score", () => {
		render(<PracticeFeedback assessment={{
			result: "unknown",
			unknown_reason: "答案与题目不匹配。",
			feedback: "无法给出可靠评分。",
			criteria: [],
		}} />);

		expect(screen.getByText(/答案与题目不匹配。/)).toBeTruthy();
		// No score line when the server did not send one.
		expect(screen.queryByText(/\/ 100/)).toBeNull();
	});

	it("omits the score line when the server sent no score", () => {
		render(<PracticeFeedback assessment={{ ...assessment, score: undefined }} />);

		expect(screen.getByText("评分反馈")).toBeTruthy();
		expect(screen.queryByText(/75/)).toBeNull();
	});

	it("renders a score of zero rather than hiding it", () => {
		render(<PracticeFeedback assessment={{ ...assessment, score: 0 }} />);

		// A zero is a real result; `typeof === "number"` keeps it visible.
		expect(screen.getByText(/0/)).toBeTruthy();
	});

	it("T15 renders in English", async () => {
		render(<PracticeFeedback assessment={assessment} />);
		await i18n.changeLanguage("en");

		expect(screen.getByText("Scoring feedback")).toBeTruthy();
	});

	it("keeps long feedback and criterion text unwrapped in the DOM", () => {
		const long = "长".repeat(300);
		render(<PracticeFeedback assessment={{
			...assessment,
			feedback: long,
			criteria: [{ criterion_id: "c", judgment: "met", explanation: long }],
		}} />);

		// The text is not truncated by the component; wrapping is CSS's job.
		expect(screen.getByText(long)).toBeTruthy();
	});
});
