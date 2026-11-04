/**
 * Practice-page review intent carried by the URL.
 *
 * `?page=practice&intent=review&review_concept_id=<id>&session=<id>` only names
 * what the learner asked to do. It is never proof that the concept is still due,
 * has a trusted name, or that a question was generated: the server's L1 profile
 * and the checkpoint remain authoritative and are re-read on entry and again
 * before generating.
 */

export const REVIEW_INTENT = "review";
export const REVIEW_INTENT_PARAM = "intent";
export const REVIEW_CONCEPT_PARAM = "review_concept_id";
export const REVIEW_QUESTION_PARAM = "review_question_id";

const CONCEPT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ReviewIntent {
	conceptId: string;
	/** A session the learner was in when starting; still needs a checkpoint check. */
	sessionId?: string;
	/** Present once the review question was generated; ties the badge to that question. */
	questionId?: string;
}

export function isSafeReviewConceptId(value: unknown): value is string {
	return typeof value === "string" && CONCEPT_ID.test(value);
}

export function isSafeReviewSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID.test(value);
}

/** Parse a search string; null means "not a valid review entry" (normal practice). */
export function parseReviewIntent(search: string): ReviewIntent | null {
	const params = new URLSearchParams(search);
	if (params.get(REVIEW_INTENT_PARAM) !== REVIEW_INTENT) return null;
	const conceptId = params.get(REVIEW_CONCEPT_PARAM)?.trim();
	if (!conceptId || !isSafeReviewConceptId(conceptId)) return null;
	const sessionId = params.get("session")?.trim();
	const questionId = params.get(REVIEW_QUESTION_PARAM)?.trim();
	return {
		conceptId,
		...(sessionId && isSafeReviewSessionId(sessionId) ? { sessionId } : {}),
		...(questionId && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(questionId) ? { questionId } : {}),
	};
}

export function reviewIntentFromLocation(): ReviewIntent | null {
	if (typeof window === "undefined") return null;
	return parseReviewIntent(window.location.search);
}
