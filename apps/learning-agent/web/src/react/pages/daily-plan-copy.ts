import type { TFunction } from "i18next";
import type { CourseDailyPlan } from "../../api/courses.js";

/**
 * E4.9e — localized copy for the server's rule-generated daily plan.
 *
 * The backend already ships a machine-readable `reason_code` on every item and
 * a structured `status` / `other_active_plans` on the course plan, precisely so
 * the prose never has to be the only basis. The frontend therefore renders the
 * explanation from those codes instead of showing the server's Chinese `reason`
 * / `notes` strings.
 *
 * Nothing here changes what the server decided: the item list, its order and
 * the review eligibility are untouched. Only the sentence a learner reads is
 * produced locally, which is what makes it follow a language switch.
 */

/** A task item's reason, from its `reason_code`. */
export function taskReasonText(t: TFunction, code: string | undefined): string {
	switch (code) {
		case "over_budget": return t("today.task.reason.over_budget");
		case "in_progress": return t("today.task.reason.in_progress");
		default: return t("today.task.reason.next_task");
	}
}

/** A review item's reason. Review items only ever carry `review_due`. */
export function reviewReasonText(t: TFunction): string {
	return t("today.review.reason.review_due");
}

/**
 * Course-level notes, rebuilt from structured fields.
 *
 * The server sends three kinds of note: the standing "recommendations are
 * recalculable" line, a line naming other enabled plans (with a count and the
 * active plan's title), and an all-completed line. Each maps to one key; the
 * count and plan title are interpolated, and the plan title is the learner's
 * own text, never translated.
 */
export function courseNotes(t: TFunction, plan: CourseDailyPlan): string[] {
	const notes = [t("today.plan.notes")];
	if (plan.other_active_plans > 0 && plan.plan) {
		notes.push(t("today.plan.otherActivePlans", {
			count: plan.other_active_plans,
			title: plan.plan.title,
		}));
	}
	if (plan.status === "all_completed") notes.push(t("today.plan.allCompleted"));
	return notes;
}

/** The `no_active_plan` course has its own two standing notes. */
export function courseNotesWithoutPlan(t: TFunction): string[] {
	return [t("today.plan.noActivePlan"), t("today.plan.progressVsMastery")];
}
