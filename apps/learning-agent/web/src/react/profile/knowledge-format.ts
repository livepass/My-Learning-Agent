import { currentLocale } from "../../i18n/index.js";

/**
 * Date formatting shared by both profile views (E4.9i-P2-2).
 *
 * The all-courses row used a short month/day + time string while the course
 * view used a long month/day. Both views now render the same review date, so
 * one function owns the format instead of two copies drifting apart.
 *
 * A missing or unparsable value renders as the caller's placeholder — it is
 * *not* a statement that no review is needed. That distinction belongs to the
 * server's review-eligibility check, which the UI never reproduces.
 */
export function formatReviewDate(iso: string | undefined, fallback = "-"): string {
	if (!iso) return fallback;
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return fallback;
	return new Date(time).toLocaleDateString(currentLocale(), { month: "long", day: "numeric" });
}

/** Percentage shown next to the bar; `mastery` is a reference value, not a probability. */
export function masteryPercent(mastery: number): number {
	return Math.round(mastery * 100);
}
