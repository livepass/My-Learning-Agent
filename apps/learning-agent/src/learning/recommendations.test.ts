import { describe, expect, it } from "vitest";
import {
	buildRecommendationSnapshot,
	hasUsableKnowledgeEvidence,
	recommendNextLearningActions,
	type LearningRecommendation,
} from "./recommendations.js";
import type { KnowledgeState, LearnerProfile, Misconception } from "../memory/learner/types.js";

/**
 * C4-B rules are pure: fixed profile + asOf + options must produce identical
 * output, and every recommendation must cite a stored L1 fact. These tests pin
 * the priority order, the provenance downgrade and the "no fabrication" cases.
 */

const AS_OF = new Date("2026-11-03T12:00:00.000Z");

function state(overrides: Partial<KnowledgeState> = {}): KnowledgeState {
	return {
		concept_id: "concept_a",
		concept_name: "Python 闭包",
		domain: "programming",
		mastery: 0.5,
		confidence: 0.5,
		stability: 0.5,
		evidence_ids: ["ev_1"],
		diagnosis: "",
		next_actions: [],
		origin: "derived",
		state_label: "fragile",
		...overrides,
	};
}

function misconception(overrides: Partial<Misconception> = {}): Misconception {
	return {
		misconception_id: "m1",
		concept_id: "concept_a",
		description: "认为闭包保存值的副本",
		status: "active",
		severity: 0.6,
		confidence: 0.5,
		first_seen_at: "2026-10-01T00:00:00.000Z",
		last_seen_at: "2026-10-20T00:00:00.000Z",
		evidence_ids: ["ev_1"],
		repair_strategy: "对比值绑定与变量绑定",
		...overrides,
	};
}

function profile(states: KnowledgeState[], misconceptions: Misconception[] = []): LearnerProfile {
	return {
		learner_id: "default",
		version: 7,
		updated_at: "2026-11-01T00:00:00.000Z",
		goals: [],
		knowledge_states: states,
		misconceptions,
		preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
		profile_summary: "",
		projection: { applied_seq: 12, rule_version: 2 },
	};
}

const ids = (items: LearningRecommendation[]) => items.map((item) => item.concept_id);

describe("rule selection", () => {
	it("prefers handling an active misconception", () => {
		const result = recommendNextLearningActions(profile([state()], [misconception()]), AS_OF);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			concept_id: "concept_a", action: "learn", reason_code: "active_misconception",
			name_available: true, concept_name: "Python 闭包",
			evidence_basis: { has_active_misconception: true, provenance_limited: false, evidence_count: 1 },
		});
		expect(result[0].suggested_kind).toBeUndefined();
		expect(result[0].reason).toContain("误区");
	});

	it("prefers a due review over a fragile label and explains both conditions", () => {
		const result = recommendNextLearningActions(profile([
			state({ review_due_at: "2026-11-02T00:00:00.000Z", state_label: "fragile" }),
		]), AS_OF);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			action: "review", suggested_kind: "free_recall", reason_code: "review_due",
			also_matches: ["fragile_evidence"],
			evidence_basis: { review_due_at: "2026-11-02T00:00:00.000Z" },
		});
	});

	it("treats the exact due instant as due", () => {
		const result = recommendNextLearningActions(profile([
			state({ review_due_at: AS_OF.toISOString(), state_label: "stable" }),
		]), AS_OF);

		expect(result[0]?.reason_code).toBe("review_due");
	});

	it("never claims a future review is due", () => {
		const result = recommendNextLearningActions(profile([
			state({ review_due_at: "2026-11-04T00:00:00.000Z", state_label: "review_due" }),
		]), AS_OF);

		expect(result).toEqual([]);
	});

	it("never claims an invalid timestamp is due", () => {
		const result = recommendNextLearningActions(profile([
			state({ review_due_at: "not-a-date", state_label: "review_due" }),
		]), AS_OF);

		expect(result).toEqual([]);
	});

	it("maps a fragile evidenced state to practice", () => {
		const result = recommendNextLearningActions(profile([state({ state_label: "fragile" })]), AS_OF);

		expect(result[0]).toMatchObject({ action: "practice", suggested_kind: "application", reason_code: "fragile_evidence" });
	});

	it("maps a learning state to a diagnostic recall", () => {
		const result = recommendNextLearningActions(profile([
			state({ state_label: "learning", retrieval_count: 2, exposure_count: 2 }),
		]), AS_OF);

		expect(result[0]).toMatchObject({ action: "diagnose", suggested_kind: "free_recall", reason_code: "learning_needs_diagnosis" });
		expect(result[0].evidence_basis.exposure_only).toBe(false);
	});

	it("says when a learning state only has exposure records", () => {
		const result = recommendNextLearningActions(profile([
			state({ state_label: "learning", retrieval_count: 0, exposure_count: 3 }),
		]), AS_OF);

		expect(result[0]).toMatchObject({ action: "diagnose", reason_code: "learning_needs_diagnosis" });
		expect(result[0].evidence_basis.exposure_only).toBe(true);
		expect(result[0].reason).toContain("接触记录");
	});

	it("maps a stable evidenced state to low-priority transfer", () => {
		const result = recommendNextLearningActions(profile([state({ state_label: "stable" })]), AS_OF);

		expect(result[0]).toMatchObject({ action: "transfer", suggested_kind: "transfer", reason_code: "stable_transfer" });
		expect(result[0].reason).toContain("不代表已经永久掌握");
	});

	it("does not recommend an unknown state with no evidence", () => {
		const result = recommendNextLearningActions(profile([
			state({ state_label: "unknown", evidence_ids: [], mastery: 0.9, confidence: 0.9 }),
		]), AS_OF);

		expect(result).toEqual([]);
	});

	it("does not treat legacy or unknown-origin numbers as a reliable basis", () => {
		const legacy = state({ state_label: "stable", origin: "legacy", mastery: 0.95, confidence: 0.9 });
		const unknownOrigin = state({ concept_id: "concept_b", state_label: "stable", origin: undefined });
		expect(recommendNextLearningActions(profile([legacy, unknownOrigin]), AS_OF)).toEqual([]);

		// An explicit active misconception is still a real record and may be surfaced,
		// with the provenance limitation attached.
		const withMisconception = recommendNextLearningActions(profile([legacy], [misconception()]), AS_OF);
		expect(withMisconception[0]).toMatchObject({ action: "learn", reason_code: "active_misconception" });
		expect(withMisconception[0].evidence_basis.provenance_limited).toBe(true);
	});

	it("does not use a legacy due time or manual numbers as a reliable basis", () => {
		const legacyDue = state({
			state_label: "stable", origin: "legacy",
			review_due_at: "2026-10-01T00:00:00.000Z",
		});
		const manual = state({
			concept_id: "concept_manual", state_label: "fragile", origin: "manual",
		});
		expect(recommendNextLearningActions(profile([legacyDue, manual]), AS_OF)).toEqual([]);
	});

	it("skips states without a usable concept id", () => {
		const result = recommendNextLearningActions(profile([
			state({ concept_id: "", state_label: "fragile" }),
			state({ concept_id: "concept_ok", state_label: "fragile" }),
		]), AS_OF);

		expect(ids(result)).toEqual(["concept_ok"]);
	});

	it("does not turn a bare due timestamp into a review task", () => {
		const result = recommendNextLearningActions(profile([
			state({ state_label: "stable", review_due_at: "2026-11-01T00:00:00.000Z", evidence_ids: [] }),
		]), AS_OF);

		expect(result).toEqual([]);
	});

	it("still prefers an explicit active misconception when no evidence exists", () => {
		const result = recommendNextLearningActions(profile([
			state({ state_label: "stable", evidence_ids: [], review_due_at: "2026-11-01T00:00:00.000Z" }),
		], [misconception()]), AS_OF);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			action: "learn", reason_code: "active_misconception",
			evidence_basis: { has_active_misconception: true, evidence_count: 0 },
		});
	});

	it("requires both trusted provenance and evidence for a due review", () => {
		const legacy = state({
			origin: "legacy", review_due_at: "2026-11-01T00:00:00.000Z",
			evidence_ids: ["ev_1"], state_label: "stable",
		});
		const manual = state({
			concept_id: "concept_manual", origin: "manual",
			review_due_at: "2026-11-01T00:00:00.000Z", evidence_ids: ["ev_2"], state_label: "stable",
		});
		expect(recommendNextLearningActions(profile([legacy, manual]), AS_OF)).toEqual([]);

		const trusted = recommendNextLearningActions(profile([
			state({ review_due_at: "2026-11-01T00:00:00.000Z", evidence_ids: ["ev_3"], state_label: "stable" }),
		]), AS_OF);
		expect(trusted[0]).toMatchObject({ action: "review", reason_code: "review_due" });
	});

	it("does not recommend a label without any stored evidence", () => {
		const result = recommendNextLearningActions(profile([
			state({ state_label: "fragile", evidence_ids: [] }),
			state({ concept_id: "concept_b", state_label: "stable", evidence_ids: [] }),
		]), AS_OF);

		expect(result).toEqual([]);
	});
});

describe("priority, ordering and deduplication", () => {
	it("orders by fixed rule priority regardless of array order", () => {
		const result = recommendNextLearningActions(profile([
			state({ concept_id: "misconception", state_label: "learning", retrieval_count: 1 }),
			state({ concept_id: "stable", state_label: "stable" }),
			state({ concept_id: "learning", state_label: "learning", retrieval_count: 1 }),
			state({ concept_id: "fragile", state_label: "fragile" }),
			state({ concept_id: "due", state_label: "stable", review_due_at: "2026-11-01T00:00:00.000Z" }),
		], [misconception({ concept_id: "misconception" })]), AS_OF, { limit: 4 });

		expect(ids(result)).toEqual(["misconception", "due", "fragile", "learning"]);
	});

	it("orders due reviews from the earliest due date", () => {
		const result = recommendNextLearningActions(profile([
			state({ concept_id: "later", review_due_at: "2026-11-03T00:00:00.000Z", state_label: "stable" }),
			state({ concept_id: "earlier", review_due_at: "2026-10-01T00:00:00.000Z", state_label: "stable" }),
		]), AS_OF);

		expect(ids(result)).toEqual(["earlier", "later"]);
	});

	it("uses a stable tiebreak for same-priority items, then concept_id", () => {
		const states = [
			state({ concept_id: "c", state_label: "fragile", last_evidence_at: "2026-11-01T00:00:00.000Z" }),
			state({ concept_id: "a", state_label: "fragile", last_evidence_at: "2026-11-02T00:00:00.000Z" }),
			state({ concept_id: "b", state_label: "fragile", last_evidence_at: "2026-11-01T00:00:00.000Z" }),
		];
		const first = recommendNextLearningActions(profile(states), AS_OF);
		const second = recommendNextLearningActions(profile([...states].reverse()), AS_OF);

		expect(ids(first)).toEqual(["a", "b", "c"]);
		expect(second).toEqual(first);
	});

	it("keeps only one primary recommendation per concept", () => {
		const result = recommendNextLearningActions(profile([
			state({ review_due_at: "2026-11-01T00:00:00.000Z", state_label: "fragile" }),
			state({ review_due_at: "2026-11-02T00:00:00.000Z", state_label: "fragile" }),
		]), AS_OF);

		expect(result).toHaveLength(1);
		expect(result[0].reason_code).toBe("review_due");
	});

	it("limits the result deterministically", () => {
		const states = Array.from({ length: 6 }, (_, index) => state({
			concept_id: `concept_${index}`,
			state_label: "fragile",
			last_evidence_at: `2026-11-0${index + 1}T00:00:00.000Z`,
		}));

		expect(recommendNextLearningActions(profile(states), AS_OF)).toHaveLength(3);
		expect(recommendNextLearningActions(profile(states), AS_OF, { limit: 1 })).toHaveLength(1);
		expect(recommendNextLearningActions(profile(states), AS_OF, { limit: 99 })).toHaveLength(6);
	});

	it("returns nothing for an invalid asOf instead of guessing the clock", () => {
		expect(recommendNextLearningActions(profile([state()]), new Date("invalid"))).toEqual([]);
	});

	it("never mutates the profile", () => {
		const input = profile([state({ state_label: "fragile" })], [misconception()]);
		const before = JSON.stringify(input);
		recommendNextLearningActions(input, AS_OF);
		expect(JSON.stringify(input)).toBe(before);
	});
});

describe("names and public snapshot", () => {
	it("omits a machine identity instead of presenting it as a topic", () => {
		const result = recommendNextLearningActions(profile([
			state({ concept_id: "concept_45125622e640", concept_name: "concept 45125622e640" }),
			state({ concept_id: "concept_real", concept_name: "Python 闭包" }),
		]), AS_OF);

		expect(result).toHaveLength(2);
		const synthetic = result.find((item) => item.concept_id === "concept_45125622e640")!;
		expect(synthetic.concept_name).toBeUndefined();
		expect(synthetic.name_available).toBe(false);
		expect(result.find((item) => item.concept_id === "concept_real")?.concept_name).toBe("Python 闭包");
	});

	it("reports an explicit empty reason and never leaks profile text", () => {
		const empty = buildRecommendationSnapshot(profile([]), AS_OF);
		expect(empty).toMatchObject({ status: "empty", empty_reason: "no_knowledge_evidence", limit: 3 });
		expect(empty.profile_version).toBe(7);
		expect(empty.projection).toEqual({ applied_seq: 12, rule_version: 2 });

		const unactionable = buildRecommendationSnapshot(profile([state({ state_label: "unknown", evidence_ids: [] })]), AS_OF);
		expect(unactionable).toMatchObject({ status: "empty", empty_reason: "no_knowledge_evidence" });
		expect(hasUsableKnowledgeEvidence(profile([state()]))).toBe(true);

		const filled = buildRecommendationSnapshot(profile([state()], [misconception()]), AS_OF, { limit: 2 });
		expect(filled).toMatchObject({ status: "ok", limit: 2, generated_at: AS_OF.toISOString(), as_of: AS_OF.toISOString() });
		expect(JSON.stringify(filled)).not.toContain("认为闭包保存值的副本");
		expect(JSON.stringify(filled)).not.toContain("profile_summary");
	});
});

describe("concept-scoped reads", () => {
	const four = () => profile([
		state({ concept_id: "concept_1", concept_name: "主题一", state_label: "fragile", last_evidence_at: "2026-11-01T00:00:00.000Z" }),
		state({ concept_id: "concept_2", concept_name: "主题二", state_label: "fragile", last_evidence_at: "2026-11-02T00:00:00.000Z" }),
		state({ concept_id: "concept_3", concept_name: "主题三", state_label: "fragile", last_evidence_at: "2026-11-03T00:00:00.000Z" }),
		state({ concept_id: "concept_4", concept_name: "主题四", state_label: "fragile", last_evidence_at: "2026-11-04T00:00:00.000Z" }),
	]);

	it("keeps the global list at three and still answers for the fourth concept", () => {
		const global = recommendNextLearningActions(four(), AS_OF);
		expect(ids(global)).toEqual(["concept_4", "concept_3", "concept_2"]);

		const scoped = recommendNextLearningActions(four(), AS_OF, { conceptId: "concept_1" });
		expect(scoped).toHaveLength(1);
		expect(scoped[0]).toMatchObject({ concept_id: "concept_1", action: "practice" });
	});

	it("returns a real empty result for an unknown concept", () => {
		expect(recommendNextLearningActions(four(), AS_OF, { conceptId: "concept_missing" })).toEqual([]);
		const snapshot = buildRecommendationSnapshot(four(), AS_OF, { conceptId: "concept_missing" });
		expect(snapshot).toMatchObject({
			status: "empty", empty_reason: "no_knowledge_evidence", concept_id: "concept_missing",
			recommendations: [],
		});
	});

	it("echoes the scope and reports empty when the concept has no actionable rule", () => {
		const snapshot = buildRecommendationSnapshot(profile([
			state({ concept_id: "concept_quiet", state_label: "unknown", evidence_ids: [] }),
		]), AS_OF, { conceptId: "concept_quiet" });

		expect(snapshot.concept_id).toBe("concept_quiet");
		expect(snapshot.status).toBe("empty");
		expect(snapshot.recommendations).toEqual([]);
	});

	it("returns nothing for an empty concept id instead of falling back to global", () => {
		expect(recommendNextLearningActions(four(), AS_OF, { conceptId: "  " })).toEqual([]);
	});
});
