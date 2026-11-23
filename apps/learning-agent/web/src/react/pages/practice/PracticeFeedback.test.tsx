// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n/index.js";
import type { PublicAssessment } from "../../../api/learning.js";
import { PracticeFeedback } from "./PracticeFeedback.js";

/**
 * E4.9h-P2-3 — the three-layer feedback block.
 *
 * Display only: the page chooses which assessment applies. These cases pin the
 * three reading layers (result + score, rubric dimensions, verbatim body) and
 * every boundary the server can send: zero, missing score, unknown result,
 * empty criteria and over-long text.
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

const renderFeedback = (value: PublicAssessment | null) => render(<PracticeFeedback assessment={value} />);
const overview = () => document.querySelector(".mla-practice-feedback-head") as HTMLElement;

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("PracticeFeedback — layer 1: result and score", () => {
	it("T01 renders nothing without an assessment", () => {
		renderFeedback(null);

		expect(document.querySelector(".mla-practice-feedback")).toBeNull();
		expect(screen.queryByText("评分反馈")).toBeNull();
	});

	it("T02 shows 答对 for a correct result", () => {
		renderFeedback({ ...assessment, result: "correct", score: 1 });
		expect(within(overview()).getByText("答对")).toBeTruthy();
	});

	it("T03 shows 部分答对 for a partial result", () => {
		renderFeedback(assessment);
		expect(within(overview()).getByText("部分答对")).toBeTruthy();
	});

	it("T04 shows 答错 for an incorrect result", () => {
		renderFeedback({ ...assessment, result: "incorrect", score: 0 });
		expect(within(overview()).getByText("答错")).toBeTruthy();
	});

	it("T05 shows 无法判定 for an unknown result", () => {
		renderFeedback({
			result: "unknown",
			unknown_reason: "答案与题目不匹配。",
			feedback: "无法给出可靠评分。",
			criteria: [],
		});
		expect(within(overview()).getByText("无法判定")).toBeTruthy();
		// "could not judge" is not "wrong": no danger-tone wording appears.
		expect(screen.queryByText("答错")).toBeNull();
	});

	it("T06 shows a zero score rather than hiding it", () => {
		renderFeedback({ ...assessment, result: "incorrect", score: 0 });
		// A zero is a real result; `typeof === "number"` keeps it visible.
		expect(screen.getByText("得分 0 / 100")).toBeTruthy();
	});

	it("T07 shows a full score as 100", () => {
		renderFeedback({ ...assessment, result: "correct", score: 1 });
		expect(screen.getByText("得分 100 / 100")).toBeTruthy();
	});

	it("T08 omits the score line when the server sent no score", () => {
		renderFeedback({ ...assessment, score: undefined });

		expect(screen.getByText("评分反馈")).toBeTruthy();
		expect(screen.queryByText(/\/ 100/)).toBeNull();
		expect(screen.queryByText("得分 0 / 100")).toBeNull();
	});

	it("rounds the percentage rather than re-scoring", () => {
		renderFeedback({ ...assessment, score: 0.755 });
		// 0.755 * 100 = 75.5 → 76. The component never adjusts the value itself.
		expect(screen.getByText("得分 76 / 100")).toBeTruthy();
	});
});

describe("PracticeFeedback — layer 2: rubric dimensions", () => {
	it("T09 keeps the server's criteria order and content", () => {
		renderFeedback(assessment);

		const items = screen.getAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]!.textContent).toContain("timing");
		expect(items[0]!.textContent).toContain("说明定义时求值。");
		expect(items[1]!.textContent).toContain("call-path");
		expect(items[1]!.textContent).toContain("未区分两件事。");
	});

	it("T10 shows all four judgment states", () => {
		renderFeedback({
			...assessment,
			criteria: [
				{ criterion_id: "a", judgment: "met", explanation: "a" },
				{ criterion_id: "b", judgment: "partially_met", explanation: "b" },
				{ criterion_id: "c", judgment: "not_met", explanation: "c" },
				{ criterion_id: "d", judgment: "unknown", explanation: "d" },
			],
		});

		const items = screen.getAllByRole("listitem");
		expect(items[0]!.textContent).toContain("已满足");
		expect(items[1]!.textContent).toContain("部分满足");
		expect(items[2]!.textContent).toContain("未满足");
		// `unknown` is its own word, never folded into "not met".
		expect(items[3]!.textContent).toContain("未判定");
		expect(items[3]!.textContent).not.toContain("未满足");
	});

	it("T11 renders no empty criteria list", () => {
		renderFeedback({ ...assessment, criteria: [] });

		expect(screen.queryByRole("list")).toBeNull();
		expect(screen.queryByText("评价维度")).toBeNull();
	});

	it("T14 does not let an over-long criterion id break the DOM", () => {
		const longId = "criterion_" + "x".repeat(120);
		renderFeedback({
			...assessment,
			criteria: [{ criterion_id: longId, judgment: "met", explanation: "说明。" }],
		});

		// The id is preserved verbatim; wrapping is CSS's job.
		expect(screen.getByText(longId)).toBeTruthy();
	});

	it("does not invent a criterion the server did not send", () => {
		renderFeedback({ ...assessment, criteria: [] });

		expect(screen.queryByText(/criterion/i)).toBeNull();
	});
});

describe("PracticeFeedback — layer 3: AI feedback body", () => {
	it("T12 shows the unknown reason in full", () => {
		renderFeedback({
			result: "unknown",
			unknown_reason: "答案与题目不匹配。",
			feedback: "无法给出可靠评分。",
			criteria: [],
		});

		expect(screen.getByText("无法判定的原因")).toBeTruthy();
		expect(screen.getByText("答案与题目不匹配。")).toBeTruthy();
		expect(screen.queryByText(/\/ 100/)).toBeNull();
	});

	it("T13 keeps a long feedback body in full", () => {
		const long = "长".repeat(300);
		renderFeedback({ ...assessment, feedback: long });

		// Not truncated by the component; wrapping is CSS's job.
		expect(screen.getByText(long)).toBeTruthy();
	});

	it("renders the model's own paragraph breaks", () => {
		const multi = "第一段。\n\n第二段。";
		renderFeedback({ ...assessment, feedback: multi });

		expect(screen.getByText(/第一段。\s*第二段。/)).toBeTruthy();
	});

	it("labels the body as AI feedback", () => {
		renderFeedback(assessment);
		expect(screen.getByText("AI 反馈")).toBeTruthy();
	});
});

describe("PracticeFeedback — i18n", () => {
	it("T15 renders every layer in English", async () => {
		renderFeedback(assessment);
		await i18n.changeLanguage("en");

		expect(screen.getByText("Scoring feedback")).toBeTruthy();
		expect(screen.getByText("Partially correct")).toBeTruthy();
		expect(screen.getByText("Score 75 / 100")).toBeTruthy();
		expect(screen.getByText("Rubric dimensions")).toBeTruthy();
		expect(screen.getByText("Met")).toBeTruthy();
		expect(screen.getByText("Partially met")).toBeTruthy();
		expect(screen.getByText("AI feedback")).toBeTruthy();
	});

	it("R1 counts the English unknown result badge without translating it as Can't be judged", async () => {
		await i18n.changeLanguage("en");
		renderFeedback({
			result: "unknown",
			unknown_reason: "The answer is ambiguous.",
			feedback: "The answer cannot be judged reliably.",
			criteria: [],
		});

		// Neutral badges carry only the base class: count the DOM node rather
		// than matching a historical English label or requiring a tone suffix.
		const badges = overview().querySelectorAll(".mla-badge");
		expect(badges).toHaveLength(1);
		expect(badges[0]!.textContent).toBe("Unable to judge");
		expect(badges[0]!.className).toBe("mla-badge");
		expect(screen.getAllByText("Unable to judge")).toHaveLength(1);
		expect(screen.queryByText(/Score\s+\d+\s*\/\s*100/)).toBeNull();
	});

	it("renders the four judgment words in English", async () => {
		renderFeedback({
			...assessment,
			criteria: [
				{ criterion_id: "a", judgment: "met", explanation: "a" },
				{ criterion_id: "b", judgment: "partially_met", explanation: "b" },
				{ criterion_id: "c", judgment: "not_met", explanation: "c" },
				{ criterion_id: "d", judgment: "unknown", explanation: "d" },
			],
		});
		await i18n.changeLanguage("en");

		const items = screen.getAllByRole("listitem");
		expect(items[0]!.textContent).toContain("Met");
		expect(items[1]!.textContent).toContain("Partially met");
		expect(items[2]!.textContent).toContain("Not met");
		expect(items[3]!.textContent).toContain("Not judged");
	});
});
