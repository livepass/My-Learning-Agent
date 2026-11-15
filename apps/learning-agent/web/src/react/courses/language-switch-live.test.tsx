// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import { useCourseErrorText, useCourseFeedbackText } from "./use-course-error-text.js";
import { recommendationReasonText } from "../pages/recommendation-copy.js";
import { taskReasonText } from "../pages/daily-plan-copy.js";
import type { CourseErrorRef, CourseFeedback } from "../../stores/courses-store.js";
import type { LearningRecommendation } from "../../types/learner.js";

/**
 * E4.9e-R1 — a language switch updates what is ALREADY on screen.
 *
 * The earlier tests unmounted and re-rendered between languages, which only
 * proves that a fresh mount picks up the new language. These cases mount once
 * and switch 中文 → English → 中文 in place, asserting the same DOM node's text
 * changes. That is the behaviour the requirement actually asks for: a learner
 * flipping the picker must see the existing message change, without repeating
 * the operation and without a reload.
 *
 * `act()` wraps each switch so React flushes the re-render caused by i18next's
 * language-changed event before the assertion runs.
 */

function ErrorProbe({ error }: { error: CourseErrorRef }) {
	const text = useCourseErrorText();
	return <p data-testid="error">{text(error)}</p>;
}

function FeedbackProbe({ feedback }: { feedback: CourseFeedback }) {
	const text = useCourseFeedbackText();
	return <p data-testid="feedback">{text(feedback)}</p>;
}

function RecommendationProbe({ item }: { item: LearningRecommendation }) {
	// The real page calls these helpers with the `t` from `useTranslation`, which
	// is what subscribes the component to language changes. Using the bound
	// instance directly would not re-render and would test nothing.
	const { t } = useTranslation();
	return <p data-testid="recommendation">{recommendationReasonText(t, item)}</p>;
}

function TaskReasonProbe({ code }: { code: string }) {
	const { t } = useTranslation();
	return <p data-testid="task">{taskReasonText(t, code)}</p>;
}

async function switchTo(language: "zh-CN" | "en"): Promise<void> {
	await act(async () => {
		await i18n.changeLanguage(language);
	});
}

const textOf = (testId: string) => screen.getByTestId(testId).textContent ?? "";

beforeEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("live language switch (no remount)", () => {
	it("updates a success message in the mounted component", async () => {
		const feedback: CourseFeedback = {
			tone: "success",
			message: "course.success.created",
			messageKey: "course.success.created",
		};
		render(<FeedbackProbe feedback={feedback} />);
		expect(textOf("feedback")).toBe("课程已创建");

		await switchTo("en");
		expect(textOf("feedback")).toBe("Course created");

		await switchTo("zh-CN");
		expect(textOf("feedback")).toBe("课程已创建");
	});

	it("updates a success message with parameters in place", async () => {
		const feedback: CourseFeedback = {
			tone: "success",
			message: "archive.feedback.courseRestored",
			messageKey: "archive.feedback.courseRestored",
			messageParams: { title: "英语四级" },
		};
		render(<FeedbackProbe feedback={feedback} />);
		const zh = textOf("feedback");
		expect(zh).toContain("英语四级");

		await switchTo("en");
		const en = textOf("feedback");
		expect(en).not.toBe(zh);
		// The learner's course title is user content: it stays verbatim.
		expect(en).toContain("英语四级");
	});

	it("updates an error in place, keeping its parameters", async () => {
		const error: CourseErrorRef = {
			messageKey: "course.error.conflictWithRevision",
			messageParams: { revision: 4 },
			message: "原始服务端信息",
		};
		render(<ErrorProbe error={error} />);
		expect(textOf("error")).toContain("4");

		await switchTo("en");
		expect(textOf("error")).toContain("4");
		expect(textOf("error")).toMatch(/version #4/i);
	});

	it("updates a recommendation reason in place", async () => {
		const item = {
			concept_id: "c1",
			concept_name: "闭包",
			name_available: true,
			action: "practice",
			reason_code: "fragile_evidence",
			reason: "服务端中文理由",
			also_matches: [],
			evidence_basis: { evidence_count: 1, exposure_only: false, provenance_limited: false },
		} as unknown as LearningRecommendation;
		render(<RecommendationProbe item={item} />);
		expect(textOf("recommendation")).toMatch(/[一-鿿]/);

		await switchTo("en");
		expect(textOf("recommendation")).not.toMatch(/[一-鿿]/);
		expect(textOf("recommendation").length).toBeGreaterThan(0);
	});

	it("updates a task reason in place", async () => {
		render(<TaskReasonProbe code="next_task" />);
		const zh = textOf("task");

		await switchTo("en");
		const en = textOf("task");
		expect(en).not.toBe(zh);
		expect(en).not.toMatch(/[一-鿿]/);
	});

	it("keeps the learner's own text untouched across a switch", async () => {
		const feedback: CourseFeedback = {
			tone: "success",
			message: "archive.feedback.sessionDeleted",
			messageKey: "archive.feedback.sessionDeleted",
			messageParams: { name: "关于闭包的讨论" },
		};
		render(<FeedbackProbe feedback={feedback} />);
		await switchTo("en");
		await waitFor(() => expect(textOf("feedback")).toContain("关于闭包的讨论"));
		// Only the surrounding system text changed.
		expect(textOf("feedback")).not.toContain("会话");
	});
});
