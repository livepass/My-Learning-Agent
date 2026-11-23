// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/index.js";
import type { PublicLearningQuestion } from "../../../api/learning.js";
import { PracticeQuestionCard, type PracticeQuestionCardProps } from "./PracticeQuestionCard.js";

/**
 * E4.9h-P2-1 — the question region.
 *
 * It renders the *inside* of the page's practice card, so these cases also
 * assert that it does not introduce a second card surface.
 */

const question: PublicLearningQuestion = {
	question_id: "q_1",
	question_version: "v2",
	concept_id: "concept_closure",
	prompt: "请解释闭包捕获的是变量还是值。",
	kind: "application",
};

function card(overrides: Partial<PracticeQuestionCardProps> = {}) {
	const props: PracticeQuestionCardProps = {
		question,
		reviewActive: false,
		sourceLabel: null,
		checkpointRevision: 3,
		loading: false,
		noSessionCopy: "",
		noRecord: false,
		onInit: vi.fn(),
		initBusy: false,
		children: <div data-testid="answer-slot">answer</div>,
		...overrides,
	};
	render(<PracticeQuestionCard {...props} />);
	return props;
}

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("PracticeQuestionCard — content", () => {
	it("renders the prompt verbatim and keeps the answer slot inside", () => {
		card();

		expect(screen.getByText("请解释闭包捕获的是变量还是值。")).toBeTruthy();
		// Prompt and answer belong to one card: the answer arrives as children.
		expect(screen.getByTestId("answer-slot")).toBeTruthy();
	});

	it("T04 shows exactly the source the page passed in", () => {
		card({ sourceLabel: "来自资料库" });
		expect(screen.getByText("来自资料库")).toBeTruthy();

		cleanup();
		card({ sourceLabel: "来自模型知识" });
		expect(screen.getByText("来自模型知识")).toBeTruthy();

		cleanup();
		card({ sourceLabel: null });
		expect(screen.queryByText(/来自资料库|来自模型知识/)).toBeNull();
	});

	it("shows the question kind", () => {
		card();
		expect(screen.getByText("应用")).toBeTruthy();
	});

	it("T05 shows the review badge only for a server-confirmed review question", () => {
		card({ reviewActive: false });
		expect(screen.queryByText("复习")).toBeNull();

		cleanup();
		card({ reviewActive: true });
		expect(screen.getByText("复习")).toBeTruthy();
		expect(screen.getByText(/先独立作答，提交后再看评分；本次作答会作为复习记录保存/)).toBeTruthy();
	});

	it("T06 collapses technical identity by default and expands on demand", () => {
		card();

		const details = document.querySelector("details.mla-practice-meta") as HTMLDetailsElement;
		expect(details).toBeTruthy();
		expect(details.open).toBe(false);

		fireEvent.click(screen.getByText("题目信息"));
		expect(details.open).toBe(true);
		expect(details.textContent).toContain("q_1");
		expect(details.textContent).toContain("v2");
		expect(details.textContent).toContain("concept_closure");
	});

	it("does not wrap itself in a card surface", () => {
		card();

		// The page owns the outer <Card variant="practice">; a nested surface
		// here would change the DOM the existing CSS targets.
		expect(document.querySelector(".mla-practice-card")).toBeNull();
		expect(document.querySelector(".mla-practice-head")).toBeTruthy();
	});
});

describe("PracticeQuestionCard — empty states", () => {
	it("explains that no conversation is open", () => {
		card({ question: null, noSessionCopy: "选择课程并开始一段学习对话后，这里会显示题目。", children: null });

		expect(screen.getByText(/选择课程并开始一段学习对话后/)).toBeTruthy();
		expect(screen.queryByTestId("answer-slot")).toBeNull();
	});

	it("shows the loading copy while the state is being read", () => {
		card({ question: null, loading: true, children: null });

		expect(screen.getByText("正在读取学习状态…")).toBeTruthy();
	});

	it("offers an explicit initialise action when there is no record", () => {
		const props = card({ question: null, noRecord: true, children: null });

		expect(screen.getByText(/还没有学习检查点/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "初始化学习记录" }));
		expect(props.onInit).toHaveBeenCalledTimes(1);
	});

	it("disables the initialise action while it is running", () => {
		card({ question: null, noRecord: true, initBusy: true, children: null });

		expect((screen.getByRole("button", { name: "初始化学习记录" }) as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("PracticeQuestionCard — i18n", () => {
	it("T15 renders in English", async () => {
		card({ sourceLabel: "From library", reviewActive: true });
		await i18n.changeLanguage("en");

		expect(screen.getByText("Current question")).toBeTruthy();
		expect(screen.getByText("Review")).toBeTruthy();
	});
});
