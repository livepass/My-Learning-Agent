import { describe, expect, it } from "vitest";
import type { KnowledgeState } from "../../types/learner.js";
import {
	DEFAULT_KNOWLEDGE_FILTER,
	KNOWLEDGE_FILTERS,
	countKnowledgeFilters,
	filterKnowledgeStates,
	type KnowledgeFilter,
} from "./knowledge-filter.js";
import { deriveProfileOverview } from "./profile-overview.js";
import type { LearnerProfile } from "../../types/learner.js";

/**
 * E4.9i-P2-4 — the six filters, tested without React.
 *
 * Each case pins one of the boundaries the phase must not cross: the label
 * decides membership, never `mastery` or a review date; counts describe the
 * whole list; and the server's order survives.
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

const profile = (states: KnowledgeState[]): LearnerProfile => ({
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-01T00:00:00.000Z",
	goals: [],
	knowledge_states: states,
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
});

const ids = (states: KnowledgeState[]) => states.map((state) => state.concept_id);

const mixed = [
	knowledge({ concept_id: "stable1", state_label: "stable" }),
	knowledge({ concept_id: "learning1", state_label: "learning" }),
	knowledge({ concept_id: "fragile1", state_label: "fragile" }),
	knowledge({ concept_id: "review1", state_label: "review_due" }),
	knowledge({ concept_id: "misc1", state_label: "misconception" }),
	knowledge({ concept_id: "unknown1", state_label: "unknown" }),
	knowledge({ concept_id: "missing1" }),
	knowledge({ concept_id: "bogus1", state_label: "brand_new_state" as never }),
];

describe("filterKnowledgeStates", () => {
	it("T01 all returns the complete list", () => {
		expect(ids(filterKnowledgeStates(mixed, "all"))).toEqual(ids(mixed));
	});

	it("T02 needs_attention includes exactly the four weak labels", () => {
		expect(ids(filterKnowledgeStates(mixed, "needs_attention"))).toEqual([
			"learning1", "fragile1", "review1", "misc1",
		]);
	});

	it("T03 review_due matches only review_due", () => {
		expect(ids(filterKnowledgeStates(mixed, "review_due"))).toEqual(["review1"]);
	});

	it("T04 misconception matches only misconception", () => {
		expect(ids(filterKnowledgeStates(mixed, "misconception"))).toEqual(["misc1"]);
	});

	it("T05 stable matches only stable", () => {
		expect(ids(filterKnowledgeStates(mixed, "stable"))).toEqual(["stable1"]);
	});

	it("T06 unknown matches the explicit unknown label", () => {
		expect(ids(filterKnowledgeStates(mixed, "unknown"))).toEqual(["unknown1", "missing1", "bogus1"]);
	});

	it("T07 a missing or unrecognised label falls into unknown, not needs_attention", () => {
		const result = filterKnowledgeStates(mixed, "unknown");
		expect(ids(result)).toContain("missing1");
		expect(ids(result)).toContain("bogus1");
		expect(ids(filterKnowledgeStates(mixed, "needs_attention"))).not.toContain("missing1");
	});

	it("T08 mastery does not affect membership", () => {
		const states = [
			knowledge({ concept_id: "low-learning", state_label: "learning", mastery: 0.01 }),
			knowledge({ concept_id: "high-stable", state_label: "stable", mastery: 0.99 }),
		];
		expect(ids(filterKnowledgeStates(states, "needs_attention"))).toEqual(["low-learning"]);
		expect(ids(filterKnowledgeStates(states, "stable"))).toEqual(["high-stable"]);
	});

	it("T09 review_due_at does not affect membership", () => {
		const states = [
			knowledge({ concept_id: "past-date-learning", state_label: "learning", review_due_at: "2020-01-01T00:00:00.000Z" }),
			knowledge({ concept_id: "no-date-review", state_label: "review_due" }),
		];
		expect(ids(filterKnowledgeStates(states, "review_due"))).toEqual(["no-date-review"]);
	});

	it("T10 handles an empty array", () => {
		for (const filter of KNOWLEDGE_FILTERS) {
			expect(filterKnowledgeStates([], filter)).toEqual([]);
		}
		expect(countKnowledgeFilters([])).toEqual({
			all: 0, needs_attention: 0, review_due: 0, misconception: 0, stable: 0, unknown: 0,
		});
	});

	it("T11 keeps the original order", () => {
		expect(ids(filterKnowledgeStates(mixed, "needs_attention"))).toEqual([
			"learning1", "fragile1", "review1", "misc1",
		]);
	});

	it("T12 does not mutate or reorder the input", () => {
		const input = mixed.slice();
		const snapshot = JSON.stringify(input);
		filterKnowledgeStates(input, "needs_attention");
		filterKnowledgeStates(input, "all");
		expect(JSON.stringify(input)).toBe(snapshot);
	});

	it("returns a new array even for `all`", () => {
		const result = filterKnowledgeStates(mixed, "all");
		expect(result).not.toBe(mixed);
		expect(result).toEqual(mixed);
	});
});

describe("countKnowledgeFilters", () => {
	it("T13 counts match what each filter selects", () => {
		const counts = countKnowledgeFilters(mixed);
		for (const filter of KNOWLEDGE_FILTERS) {
			expect(counts[filter], filter).toBe(filterKnowledgeStates(mixed, filter).length);
		}
	});

	it("T14 counts match the overview's own classification", () => {
		const counts = countKnowledgeFilters(mixed);
		const overview = deriveProfileOverview(profile(mixed));
		expect(counts.all).toBe(overview.totalConcepts);
		expect(counts.needs_attention).toBe(overview.weakCount);
		expect(counts.review_due).toBe(overview.reviewDueStates);
		expect(counts.misconception).toBe(overview.misconceptionStateCount);
		expect(counts.stable).toBe(overview.stableCount);
		expect(counts.unknown).toBe(overview.unknownCount);
	});

	it("keeps every key present, in the documented order", () => {
		expect(Object.keys(countKnowledgeFilters([]))).toEqual([...KNOWLEDGE_FILTERS]);
	});

	it("defaults to `all`", () => {
		expect(DEFAULT_KNOWLEDGE_FILTER).toBe<KnowledgeFilter>("all");
	});

	it("does not mutate the input", () => {
		const snapshot = JSON.stringify(mixed);
		countKnowledgeFilters(mixed);
		expect(JSON.stringify(mixed)).toBe(snapshot);
	});
});
