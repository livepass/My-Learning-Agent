import type { TFunction } from "i18next";
import type { LearningRecommendation } from "../../types/learner.js";

/**
 * E4.9e — localized explanation for a learning recommendation.
 *
 * `LearningRecommendation.reason_code` names the rule that fired; the prose
 * `reason` is the server's Chinese sentence. Rendering from the code keeps the
 * text in the learner's language without touching the rule, its priority, the
 * evidence basis or the review eligibility.
 *
 * `exposure_only` is part of the *meaning* of `learning_needs_diagnosis`: a
 * concept with only exposure has not produced independent recall evidence yet,
 * so it gets its own wording. The branch is preserved exactly as the server
 * decided it.
 */
export function recommendationReasonText(t: TFunction, item: LearningRecommendation): string {
	switch (item.reason_code) {
		case "active_misconception":
			return t("today.recommendation.reason.active_misconception");
		case "review_due": {
			const date = item.evidence_basis.review_due_at;
			return date
				? t("today.recommendation.reason.review_due", { date: date.slice(0, 10) })
				: t("today.recommendation.reason.review_dueOverdue");
		}
		case "fragile_evidence":
			return t("today.recommendation.reason.fragile_evidence");
		case "learning_needs_diagnosis":
			return item.evidence_basis.exposure_only
				? t("today.recommendation.reason.learning_exposureOnly")
				: t("today.recommendation.reason.learning_needs_diagnosis");
		case "stable_transfer":
			return t("today.recommendation.reason.stable_transfer");
		default:
			// A rule this build does not know: fall back to the server sentence
			// rather than inventing a meaning.
			return item.reason;
	}
}
