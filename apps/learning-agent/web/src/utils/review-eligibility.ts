import type { KnowledgeState } from "../types/learner.js";

/**
 * Whether a stored `review_due_at` is a real review task.
 *
 * Mirrors the server's recommendation rule: the date must parse, must not be in
 * the future, and the state must be projection-derived with at least one
 * traceable evidence id. A leftover timestamp on a legacy/manual state, or a
 * date without any evidence, is not a review obligation and must not appear as
 * one on the today page.
 */
export function isActionableReviewDue(state: KnowledgeState, nowMs: number): boolean {
	if (!state.review_due_at) return false;
	const due = Date.parse(state.review_due_at);
	if (!Number.isFinite(due) || due > nowMs) return false;
	if (state.origin !== "derived" || state.provenance_unknown === true) return false;
	const evidence = Array.isArray(state.evidence_ids)
		? state.evidence_ids.filter((id) => typeof id === "string" && id.trim().length > 0).length
		: 0;
	return evidence > 0;
}
