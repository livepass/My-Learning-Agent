import type { KnowledgeStateLabel } from "../../types/learner.js";
import { isWeakKnowledgeState, normalizeKnowledgeStateLabel } from "../knowledge-state.js";
import { tallyKnowledgeStates, type LabelBearingState } from "./profile-overview.js";

/**
 * The six knowledge-state filters (E4.9i-P2-4).
 *
 * A filter is a *view* over the list the server returned. It never changes a
 * state, a mastery number or a review date, and it never asks for new data.
 *
 * The classification is the one the badges and the overview already use:
 *
 * - `needs_attention` is exactly `isWeakKnowledgeState` (learning / fragile /
 *   review_due / misconception);
 * - the other four are the normalised label — a missing or unrecognised label
 *   is `unknown`, which is why `unknown` also means 「证据不足」;
 * - `mastery`, `confidence` and `review_due_at` are never consulted. A stored
 *   date that has passed does not make a concept review-due; only the server's
 *   `review_due` classification does.
 *
 * Counts come from the whole list, not the filtered result, so selecting one
 * filter never changes the numbers beside the others.
 */
export const KNOWLEDGE_FILTERS = [
	"all",
	"needs_attention",
	"review_due",
	"misconception",
	"stable",
	"unknown",
] as const;

export type KnowledgeFilter = (typeof KNOWLEDGE_FILTERS)[number];

export const DEFAULT_KNOWLEDGE_FILTER: KnowledgeFilter = "all";

/** Per-filter counts over a complete list; every key is always present. */
export type KnowledgeFilterCounts = Record<KnowledgeFilter, number>;

function matchesFilter(state: LabelBearingState, filter: KnowledgeFilter): boolean {
	if (filter === "all") return true;
	if (filter === "needs_attention") return isWeakKnowledgeState(state.state_label);
	return normalizeKnowledgeStateLabel(state.state_label) === (filter satisfies KnowledgeStateLabel);
}

/**
 * The states a filter selects, in the order they arrived.
 *
 * `filter` runs over the input; the result is a new array and the input is
 * never sorted or mutated.
 */
export function filterKnowledgeStates<T extends LabelBearingState>(
	states: readonly T[],
	filter: KnowledgeFilter,
): T[] {
	if (filter === "all") return states.slice();
	return states.filter((state) => matchesFilter(state, filter));
}

/**
 * Counts for every filter, computed from one tally.
 *
 * Built from `tallyKnowledgeStates`, the same pass `deriveProfileOverview`
 * uses, so the filter numbers and the overview numbers cannot drift apart.
 * `needs_attention` is the weak count; the rest are the normalised labels.
 */
export function countKnowledgeFilters(states: readonly LabelBearingState[]): KnowledgeFilterCounts {
	const { total, labelCounts, weakCount } = tallyKnowledgeStates(states);
	return {
		all: total,
		needs_attention: weakCount,
		review_due: labelCounts.review_due,
		misconception: labelCounts.misconception,
		stable: labelCounts.stable,
		unknown: labelCounts.unknown,
	};
}
