import type { KnowledgeState, KnowledgeStateLabel, LearnerProfile } from "../../types/learner.js";
import { isWeakKnowledgeState, normalizeKnowledgeStateLabel } from "../knowledge-state.js";

/**
 * Everything the 学习概览 renders, derived once from the stored profile
 * (E4.9i-P2-3).
 *
 * The four original stats used to be computed inline in the panel while any
 * conclusion would have been computed separately — two chances to disagree
 * about the same screen. One pure function now produces both, so the numbers
 * in the tiles and the numbers in the sentence are the same numbers.
 *
 * Rules, all of them inherited rather than invented:
 *
 * - a concept's state comes from `state_label` only, via
 *   `normalizeKnowledgeStateLabel` — never from `mastery`, `confidence`,
 *   `stability` or `review_due_at`;
 * - "needs attention" is exactly `isWeakKnowledgeState` (learning / fragile /
 *   review_due / misconception); missing or unrecognised labels are *not* weak,
 *   they are 「证据不足」;
 * - `reviewDueStates` is a tally of the server's `review_due` classification.
 *   It is not a due-review verdict — that check belongs to the daily plan;
 * - misconception *records* and `misconception` knowledge states are counted
 *   separately and never added together.
 *
 * The function is pure: no clock, no store, no request, and the profile it
 * receives is not mutated. `weakConcepts` keeps the server's array order — it
 * is a filtered view, not a ranking.
 */
export interface ProfileOverview {
	/** Goals whose `status` is `active`. */
	activeGoals: number;
	/** Number of recorded knowledge states. */
	totalConcepts: number;
	/** States classified `review_due` by the server. Not a due-review verdict. */
	reviewDueStates: number;
	/** Misconception records still `active` or `repairing`. */
	openMisconceptions: number;
	/** States satisfying `isWeakKnowledgeState`. */
	weakCount: number;
	/** States classified `stable`. */
	stableCount: number;
	/** States with a missing, empty, `unknown` or unrecognised label. */
	unknownCount: number;
	/** States classified `misconception` (a subset of `weakConcepts`). */
	misconceptionStateCount: number;
	/** Tally per normalised label; the six keys always sum to `totalConcepts`. */
	labelCounts: Record<KnowledgeStateLabel, number>;
	/** States needing attention, in the server's original order. */
	weakConcepts: KnowledgeState[];
}

function emptyLabelCounts(): Record<KnowledgeStateLabel, number> {
	return {
		unknown: 0,
		learning: 0,
		fragile: 0,
		review_due: 0,
		stable: 0,
		misconception: 0,
	};
}

export function deriveProfileOverview(profile: LearnerProfile): ProfileOverview {
	const knowledge = profile.knowledge_states;
	const labelCounts = emptyLabelCounts();
	const weakConcepts: KnowledgeState[] = [];

	for (const state of knowledge) {
		labelCounts[normalizeKnowledgeStateLabel(state.state_label)] += 1;
		if (isWeakKnowledgeState(state.state_label)) weakConcepts.push(state);
	}

	return {
		activeGoals: profile.goals.filter((goal) => goal.status === "active").length,
		totalConcepts: knowledge.length,
		// Same classification the panel counted before P2-3, now taken from the
		// shared tally so the tile and the conclusion cannot drift apart.
		reviewDueStates: labelCounts.review_due,
		openMisconceptions: profile.misconceptions.filter(
			(item) => item.status === "active" || item.status === "repairing",
		).length,
		weakCount: weakConcepts.length,
		stableCount: labelCounts.stable,
		unknownCount: labelCounts.unknown,
		misconceptionStateCount: labelCounts.misconception,
		labelCounts,
		weakConcepts,
	};
}
