import { describe, expect, it } from "vitest";
import type { KnowledgeState } from "../types/learner.js";
import { isActionableReviewDue } from "./review-eligibility.js";

/**
 * E4.9i-P2-7 (T04) — the display layer must not turn a *state label* into a
 * formal review entitlement.
 *
 * `isActionableReviewDue` is the client's copy of the server's `reviewable()`
 * gate (`courses/daily-plan.ts:140`). It answers one question — "is this
 * stored record an actual review task?" — and the Today page uses it to decide
 * whether an entry may appear. `state_label: "review_due"` alone never answers
 * that question, and `review_due_at` alone never does either.
 *
 * The server rule, verified in `src/courses/daily-plan.test.ts`, is:
 *   evidence ≥ 1, origin === "derived", provenance_unknown !== true,
 *   review_due_at parses and is not in the future.
 *
 * Note the shape of that rule: `state_label` is **not** part of it. A
 * `learning` state with a due date and derived evidence is reviewable, and a
 * `review_due` state without evidence is not. These cases pin both directions
 * so no surface can infer eligibility from the badge.
 */

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-28T10:00:00.000Z");

function state(overrides: Partial<KnowledgeState> = {}): KnowledgeState {
	return {
		concept_id: "concept_01",
		concept_name: "同义替换",
		domain: "cet4",
		mastery: 0.5,
		confidence: 0.5,
		stability: 0.5,
		evidence_ids: ["e1"],
		diagnosis: "",
		next_actions: [],
		origin: "derived",
		state_label: "review_due",
		review_due_at: "2026-11-20T00:00:00.000Z",
		...overrides,
	};
}

describe("P2-7 T04 — formal review eligibility is not the badge", () => {
	it("V01 — review_due without usable evidence is not actionable", () => {
		expect(isActionableReviewDue(state({ evidence_ids: [] }), NOW)).toBe(false);
		// Blank ids do not count, matching the server's evidenceCount().
		expect(isActionableReviewDue(state({ evidence_ids: [""] }), NOW)).toBe(false);
		expect(isActionableReviewDue(state({ evidence_ids: ["  "] }), NOW)).toBe(false);
	});

	it("V02 — review_due from a non-derived origin is not actionable", () => {
		expect(isActionableReviewDue(state({ origin: "manual" }), NOW)).toBe(false);
		expect(isActionableReviewDue(state({ origin: "legacy" }), NOW)).toBe(false);
		expect(isActionableReviewDue(state({ origin: undefined }), NOW)).toBe(false);
	});

	it("V03 — provenance_unknown blocks the claim even with derived evidence", () => {
		expect(isActionableReviewDue(state({ provenance_unknown: true }), NOW)).toBe(false);
		// Only a literal `true` blocks; absent/false is the normal derived case.
		expect(isActionableReviewDue(state({ provenance_unknown: false }), NOW)).toBe(true);
		expect(isActionableReviewDue(state({ provenance_unknown: undefined }), NOW)).toBe(true);
	});

	it("V04 — a missing or unparsable date is not actionable", () => {
		expect(isActionableReviewDue(state({ review_due_at: undefined }), NOW)).toBe(false);
		expect(isActionableReviewDue(state({ review_due_at: "" }), NOW)).toBe(false);
		expect(isActionableReviewDue(state({ review_due_at: "not-a-date" }), NOW)).toBe(false);
	});

	it("V05 — a future date is not due, and equality is due", () => {
		expect(isActionableReviewDue(state({ review_due_at: "2026-12-01T00:00:00.000Z" }), NOW)).toBe(false);
		expect(isActionableReviewDue(state({ review_due_at: "2026-11-28T10:00:00.000Z" }), NOW)).toBe(true);
	});

	it("V06 — a record that satisfies every rule is actionable", () => {
		expect(isActionableReviewDue(state(), NOW)).toBe(true);
	});

	it("V07 — learning with an overdue date is reviewable, so the badge is not the gate", () => {
		// This is the server's rule, not a display choice: `state_label` is absent
		// from `reviewable()`. The all-courses tally still counts this concept as
		// 学习中 (P2-7 S12), which is why the two numbers must never be conflated.
		expect(isActionableReviewDue(state({ state_label: "learning" }), NOW)).toBe(true);
	});

	it("V08 — a stable state can be due while a review_due state cannot", () => {
		// The pair that makes "badge = eligibility" visibly wrong in both
		// directions.
		expect(isActionableReviewDue(state({ state_label: "stable" }), NOW)).toBe(true);
		expect(isActionableReviewDue(state({ state_label: "review_due", evidence_ids: [] }), NOW)).toBe(false);
	});
});
