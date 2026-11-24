import type { KnowledgeStateLabel } from "../types/learner.js";
import type { BadgeTone } from "./ui/index.js";

/**
 * One display vocabulary for the server's knowledge-state classification
 * (E4.9i-P2-1).
 *
 * Before this module the two profile views disagreed: the all-courses view
 * turned `mastery` into three threshold buckets of its own, while the
 * course-scoped view read `state_label`. A concept with `mastery: 0.05` and
 * `state_label: "learning"` therefore read 「待复习」 in one view and
 * 「学习中」 in the other, and the overview counted a third thing again
 * (`review_due_at <= now`).
 *
 * The rules here are deliberately narrow:
 *
 * - the label comes from `state_label` only — never from `mastery`,
 *   `review_due_at` or the number of evidence ids;
 * - a missing, empty, `unknown` or unrecognised value renders as
 *   「证据不足」 instead of leaking a raw server string into the UI;
 * - the tone is presentation only. `state_label` says nothing about whether a
 *   review is actually due: that check belongs to the server's daily-plan
 *   rules and is not reproduced here.
 */

/** Every value the server's state engine can emit. */
export const KNOWLEDGE_STATE_LABELS: readonly KnowledgeStateLabel[] = [
	"unknown",
	"learning",
	"fragile",
	"review_due",
	"stable",
	"misconception",
];

/** The four labels the product treats as needing attention. Unchanged. */
const WEAK_LABELS = new Set<KnowledgeStateLabel>(["fragile", "learning", "misconception", "review_due"]);

const LABEL_KEY: Record<KnowledgeStateLabel, string> = {
	unknown: "course.state.unknown",
	learning: "course.state.learning",
	fragile: "course.state.fragile",
	review_due: "course.state.review_due",
	stable: "course.state.stable",
	misconception: "course.state.misconception",
};

/**
 * Semantic tone per state. `unknown` is neutral on purpose: an unrecognised
 * state is missing information, not a success and not a failure.
 */
const STATE_TONE: Record<KnowledgeStateLabel, BadgeTone> = {
	unknown: "neutral",
	learning: "accent",
	fragile: "warning",
	review_due: "warning",
	stable: "success",
	misconception: "danger",
};

function isKnownLabel(value: unknown): value is KnowledgeStateLabel {
	return typeof value === "string" && (KNOWLEDGE_STATE_LABELS as readonly string[]).includes(value);
}

/**
 * Collapse anything the server can send into one of the six known labels.
 *
 * `unknown` is both a real server value and the fallback, which is intended:
 * "we have no trustworthy classification" is exactly what both mean.
 */
export function normalizeKnowledgeStateLabel(value: unknown): KnowledgeStateLabel {
	return isKnownLabel(value) ? value : "unknown";
}

/** Translation key for a state; always resolves, never a raw server string. */
export function knowledgeStateLabelKey(value: unknown): string {
	return LABEL_KEY[normalizeKnowledgeStateLabel(value)];
}

/** Badge tone for a state. */
export function knowledgeStateTone(value: unknown): BadgeTone {
	return STATE_TONE[normalizeKnowledgeStateLabel(value)];
}

/**
 * Whether a state belongs to the "needs attention" group.
 *
 * Missing/unrecognised states are *not* weak: the existing business rule only
 * ever counted the four explicit labels, and guessing weakness from an absent
 * label would invent a diagnosis.
 */
export function isWeakKnowledgeState(value: unknown): boolean {
	return isKnownLabel(value) && WEAK_LABELS.has(value);
}
