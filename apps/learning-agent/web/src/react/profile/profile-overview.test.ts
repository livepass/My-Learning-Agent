import { describe, expect, it } from "vitest";
import type { KnowledgeState, LearnerProfile, Misconception } from "../../types/learner.js";
import { deriveProfileOverview } from "./profile-overview.js";

/**
 * E4.9i-P2-3 — the derivation rules, tested without React.
 *
 * The overview must never infer a state from `mastery`, a review date or an
 * evidence count. Every case below pins one of those boundaries, because the
 * numbers here feed both the four original tiles and the conclusion sentence.
 */

const knowledge = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
	concept_name: patch.concept_id,
	domain: "cet4",
	mastery: 0.5,
	confidence: 0.5,
	stability: 0.5,
	evidence_ids: [],
	diagnosis: "",
	next_actions: [],
	...patch,
});

const misconception = (patch: Partial<Misconception> & { misconception_id: string }): Misconception => ({
	concept_id: "c1",
	description: "误区",
	status: "active",
	severity: 0.5,
	confidence: 0.5,
	first_seen_at: "2026-11-01T00:00:00.000Z",
	last_seen_at: "2026-11-01T00:00:00.000Z",
	evidence_ids: [],
	repair_strategy: "",
	...patch,
});

const profile = (patch: Partial<LearnerProfile> = {}): LearnerProfile => ({
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-01T00:00:00.000Z",
	goals: [],
	knowledge_states: [],
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
	...patch,
});

describe("deriveProfileOverview", () => {
	it("T01 returns all-zero counts for an empty profile", () => {
		const overview = deriveProfileOverview(profile());
		expect(overview).toMatchObject({
			activeGoals: 0,
			totalConcepts: 0,
			reviewDueStates: 0,
			openMisconceptions: 0,
			weakCount: 0,
			stableCount: 0,
			unknownCount: 0,
			misconceptionStateCount: 0,
		});
		expect(overview.weakConcepts).toEqual([]);
		expect(overview.labelCounts).toEqual({
			unknown: 0, learning: 0, fragile: 0, review_due: 0, stable: 0, misconception: 0,
		});
	});

	it("T02 all stable states produce no weak concept", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "stable" }),
				knowledge({ concept_id: "b", state_label: "stable" }),
			],
		}));
		expect(overview.stableCount).toBe(2);
		expect(overview.weakCount).toBe(0);
		expect(overview.weakConcepts).toEqual([]);
	});

	it("T03 every learning state enters the weak set", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "learning" }),
				knowledge({ concept_id: "b", state_label: "learning" }),
				knowledge({ concept_id: "c", state_label: "learning" }),
			],
		}));
		expect(overview.weakCount).toBe(3);
		expect(overview.weakConcepts.map((state) => state.concept_id)).toEqual(["a", "b", "c"]);
	});

	it("T04 counts a fragile / review_due / misconception mix by the four weak labels", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [
				knowledge({ concept_id: "f", state_label: "fragile" }),
				knowledge({ concept_id: "r", state_label: "review_due" }),
				knowledge({ concept_id: "m", state_label: "misconception" }),
				knowledge({ concept_id: "s", state_label: "stable" }),
			],
		}));
		expect(overview.weakCount).toBe(3);
		expect(overview.reviewDueStates).toBe(1);
		expect(overview.misconceptionStateCount).toBe(1);
		expect(overview.stableCount).toBe(1);
		expect(overview.labelCounts).toEqual({
			unknown: 0, learning: 0, fragile: 1, review_due: 1, stable: 1, misconception: 1,
		});
	});

	it("T05 a missing state_label counts as insufficient evidence", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [knowledge({ concept_id: "a" })],
		}));
		expect(overview.unknownCount).toBe(1);
		expect(overview.weakCount).toBe(0);
	});

	it("T06 an unrecognised state_label degrades to insufficient evidence", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "brand_new_state" as never }),
				knowledge({ concept_id: "b", state_label: "" as never }),
				knowledge({ concept_id: "c", state_label: null as never }),
			],
		}));
		expect(overview.unknownCount).toBe(3);
		expect(overview.weakCount).toBe(0);
	});

	it("T07 very low mastery on a stable state still reads stable", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [knowledge({ concept_id: "a", state_label: "stable", mastery: 0.02 })],
		}));
		expect(overview.stableCount).toBe(1);
		expect(overview.weakCount).toBe(0);
	});

	it("T08 very high mastery on a review_due state still reads review_due", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [knowledge({ concept_id: "a", state_label: "review_due", mastery: 0.98 })],
		}));
		expect(overview.reviewDueStates).toBe(1);
		expect(overview.stableCount).toBe(0);
	});

	it("T09 a past review_due_at with state_label=learning adds no review-due count", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [knowledge({
				concept_id: "a",
				state_label: "learning",
				review_due_at: "2020-01-01T00:00:00.000Z",
			})],
		}));
		expect(overview.reviewDueStates).toBe(0);
		expect(overview.weakCount).toBe(1);
	});

	it("T10 review_due without a date still counts as the review_due classification", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [knowledge({ concept_id: "a", state_label: "review_due" })],
		}));
		expect(overview.reviewDueStates).toBe(1);
		expect(overview.weakConcepts).toHaveLength(1);
	});

	it("T11 counts active and repairing misconception records, ignoring resolved and stale", () => {
		const overview = deriveProfileOverview(profile({
			misconceptions: [
				misconception({ misconception_id: "m1", status: "active" }),
				misconception({ misconception_id: "m2", status: "repairing" }),
				misconception({ misconception_id: "m3", status: "resolved" }),
				misconception({ misconception_id: "m4", status: "stale" }),
			],
		}));
		expect(overview.openMisconceptions).toBe(2);
	});

	it("T12 misconception states and misconception records are counted separately", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "misconception" }),
				knowledge({ concept_id: "b", state_label: "learning" }),
			],
			// Two records for concept a, none for concept b: the record count must
			// not leak into the state count, nor the other way round.
			misconceptions: [
				misconception({ misconception_id: "m1", concept_id: "a", status: "active" }),
				misconception({ misconception_id: "m2", concept_id: "a", status: "repairing" }),
			],
		}));
		expect(overview.misconceptionStateCount).toBe(1);
		expect(overview.openMisconceptions).toBe(2);
	});

	it("counts only active goals", () => {
		const overview = deriveProfileOverview(profile({
			goals: [
				{ goal_id: "g1", title: "a", type: "skill", priority: 0.5, status: "active", success_criteria: [], source: "user_declared", updated_at: "" },
				{ goal_id: "g2", title: "b", type: "skill", priority: 0.5, status: "paused", success_criteria: [], source: "user_declared", updated_at: "" },
				{ goal_id: "g3", title: "c", type: "skill", priority: 0.5, status: "active", success_criteria: [], source: "user_declared", updated_at: "" },
			],
		}));
		expect(overview.activeGoals).toBe(2);
	});

	it("keeps the server's array order in weakConcepts and does not rank by mastery", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [
				knowledge({ concept_id: "low", state_label: "learning", mastery: 0.1 }),
				knowledge({ concept_id: "high", state_label: "fragile", mastery: 0.9 }),
				knowledge({ concept_id: "mid", state_label: "review_due", mastery: 0.5 }),
			],
		}));
		expect(overview.weakConcepts.map((state) => state.concept_id)).toEqual(["low", "high", "mid"]);
	});

	it("does not mutate the profile it receives", () => {
		const input = profile({
			knowledge_states: [knowledge({ concept_id: "a", state_label: "learning" })],
		});
		const snapshot = JSON.stringify(input);
		deriveProfileOverview(input);
		expect(JSON.stringify(input)).toBe(snapshot);
	});

	it("keeps the label tally equal to the total concept count", () => {
		const overview = deriveProfileOverview(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "learning" }),
				knowledge({ concept_id: "b", state_label: "stable" }),
				knowledge({ concept_id: "c" }),
				knowledge({ concept_id: "d", state_label: "nope" as never }),
			],
		}));
		const sum = Object.values(overview.labelCounts).reduce((total, value) => total + value, 0);
		expect(sum).toBe(overview.totalConcepts);
		expect(overview.totalConcepts).toBe(4);
	});
});
