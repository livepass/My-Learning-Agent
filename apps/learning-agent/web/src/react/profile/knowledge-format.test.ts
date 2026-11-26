// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import { formatReviewDate, masteryPercent } from "./knowledge-format.js";

/**
 * E4.9i-P2-5-R1 (F03) — date and percentage rendering.
 *
 * The task book asks for date-display coverage without touching the review
 * eligibility rules. That boundary is what these cases pin: this module formats
 * a date the server already decided to send. It never decides *whether* a
 * concept is due, and a missing date is rendered as the caller's placeholder
 * rather than as "no review needed".
 */

beforeEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

describe("formatReviewDate", () => {
	it("renders a valid ISO date in the current locale", async () => {
		const text = formatReviewDate("2026-12-01T00:00:00.000Z");
		// The locale decides the exact wording, so assert the parts a reader can
		// see rather than a hardcoded string that would break on a locale bump.
		expect(text).toContain("12");
		expect(text).toMatch(/1/);
		expect(text).not.toBe("-");
	});

	it("switches language with the rest of the UI", async () => {
		const zh = formatReviewDate("2026-12-01T00:00:00.000Z");
		await i18n.changeLanguage("en");
		const en = formatReviewDate("2026-12-01T00:00:00.000Z");
		expect(en).not.toBe(zh);
		// English renders a long month name.
		expect(en).toContain("December");
	});

	it("returns the caller's placeholder for a missing date", () => {
		// "-" is the default; the course view passes "" instead. Neither claims a
		// review decision — that is the server's answer, not this function's.
		expect(formatReviewDate(undefined)).toBe("-");
		expect(formatReviewDate(undefined, "")).toBe("");
	});

	it("returns the placeholder for an unparsable value instead of NaN", () => {
		expect(formatReviewDate("not-a-date")).toBe("-");
		expect(formatReviewDate("")).toBe("-");
	});

	it("never invents a date for a concept the server left without one", () => {
		// The regression this guards: a placeholder must not become "today" or
		// some default, which would look like a real scheduled review.
		const text = formatReviewDate(undefined);
		expect(text).toBe("-");
		expect(text).not.toMatch(/\d{4}/);
	});
});

describe("masteryPercent", () => {
	it("rounds the stored ratio to a whole percentage", () => {
		expect(masteryPercent(0)).toBe(0);
		expect(masteryPercent(0.5)).toBe(50);
		expect(masteryPercent(1)).toBe(100);
	});

	it("rounds rather than truncates", () => {
		expect(masteryPercent(0.375)).toBe(38);
		expect(masteryPercent(0.004)).toBe(0);
		expect(masteryPercent(0.996)).toBe(100);
	});
});
