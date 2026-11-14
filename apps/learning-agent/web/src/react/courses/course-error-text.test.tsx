// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import { useCourseErrorText, useCourseFeedbackText } from "./use-course-error-text.js";
import type { CourseErrorRef, CourseFeedback } from "../../stores/courses-store.js";

/**
 * E4.9e — store errors render in the learner's language.
 *
 * The store keeps a translation key (never a translated sentence), so an error
 * already on screen follows a language switch and the raw server sentence stays
 * a diagnostics detail instead of the text a learner reads.
 */

function Probe({ error }: { error: CourseErrorRef | null }) {
	const text = useCourseErrorText();
	return <p>{text(error)}</p>;
}

function FeedbackProbe({ feedback }: { feedback: CourseFeedback | null }) {
	const text = useCourseFeedbackText();
	return <p>{text(feedback)}</p>;
}

const ref = (over: Partial<CourseErrorRef>): CourseErrorRef => ({
	messageKey: "course.error.generic",
	message: "原始服务端信息",
	...over,
});

beforeEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("course error text", () => {
	it("renders a known error code in the current language", async () => {
		render(<Probe error={ref({ messageKey: "course.error.archived", code: "course_archived" })} />);
		expect(screen.getByText(/已归档/)).toBeTruthy();

		await i18n.changeLanguage("en");
		cleanup();
		render(<Probe error={ref({ messageKey: "course.error.archived", code: "course_archived" })} />);
		expect(screen.getByText(/archived/i)).toBeTruthy();
	});

	it("interpolates the revision of a conflict", async () => {
		render(<Probe error={ref({
			messageKey: "course.error.conflictWithRevision",
			messageParams: { revision: 7 },
		})} />);
		expect(screen.getByText(/7/)).toBeTruthy();
	});

	it("never shows the raw server sentence when a key is available", async () => {
		render(<Probe error={ref({ messageKey: "course.error.unavailable" })} />);
		expect(screen.queryByText("原始服务端信息")).toBeNull();
	});

	it("falls back to the raw message only when no key exists", () => {
		render(<Probe error={{ messageKey: "", message: "diagnostic only" }} />);
		expect(screen.getByText("diagnostic only")).toBeTruthy();
	});

	it("renders nothing for a null error", () => {
		const { container } = render(<Probe error={null} />);
		expect(container.querySelector("p")?.textContent).toBe("");
	});
});

describe("course feedback text", () => {
	it("renders a conflict with its revision in both languages", async () => {
		const feedback: CourseFeedback = {
			tone: "conflict",
			message: "原始服务端信息",
			messageKey: "course.error.conflictWithRevision",
			messageParams: { revision: 3 },
		};
		render(<FeedbackProbe feedback={feedback} />);
		expect(screen.getByText(/3/)).toBeTruthy();
		expect(screen.queryByText("原始服务端信息")).toBeNull();

		await i18n.changeLanguage("en");
		cleanup();
		render(<FeedbackProbe feedback={feedback} />);
		expect(screen.getByText(/version #3/i)).toBeTruthy();
	});
});
