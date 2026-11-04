import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { RecommendationSnapshot } from "../types/learner.js";
import { learnerStore } from "./learner-store.js";

const api = vi.hoisted(() => ({
	getLearnerProfile: vi.fn(),
	getLearningRecommendations: vi.fn(),
}));

vi.mock("../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../api/learner.js")>("../api/learner.js");
	return { ...actual, ...api };
});

const snapshot = (overrides: Partial<RecommendationSnapshot> = {}): RecommendationSnapshot => ({
	as_of: "2026-11-03T12:00:00.000Z",
	generated_at: "2026-11-03T12:00:00.000Z",
	profile_version: 4,
	recommendations: [{
		concept_id: "concept_a",
		concept_name: "Python 闭包",
		name_available: true,
		action: "diagnose",
		suggested_kind: "free_recall",
		reason_code: "learning_needs_diagnosis",
		reason: "这个知识点已开始学习但证据还不充分。",
		also_matches: [],
		evidence_basis: {
			state_label: "learning", evidence_count: 1,
			has_active_misconception: false, provenance_limited: false, exposure_only: false,
		},
	}],
	status: "ok",
	limit: 3,
	...overrides,
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	learnerStore.recommendations = null;
	learnerStore.recommendationsError = null;
	learnerStore.conceptRecommendation = null;
	learnerStore.conceptRecommendationConceptId = null;
	learnerStore.conceptRecommendationError = null;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("learner store recommendations (C4-B)", () => {
	it("stores the read-only snapshot and only the newest request wins", async () => {
		const older = deferred<RecommendationSnapshot>();
		const newer = deferred<RecommendationSnapshot>();
		api.getLearningRecommendations
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);

		const first = learnerStore.loadRecommendations();
		const second = learnerStore.loadRecommendations();
		expect(learnerStore.recommendationsLoading).toBe(true);

		newer.resolve(snapshot({ profile_version: 9 }));
		await second;
		older.resolve(snapshot({ profile_version: 2 }));
		await first;

		expect(learnerStore.recommendations?.profile_version).toBe(9);
		expect(learnerStore.recommendationsLoading).toBe(false);
	});

	it("keeps an explicit error and does not fabricate a list", async () => {
		api.getLearningRecommendations.mockRejectedValue(new ApiError(503, "PROFILE_UNAVAILABLE"));

		await learnerStore.loadRecommendations();

		expect(learnerStore.recommendations).toBeNull();
		expect(learnerStore.recommendationsError).toContain("学习档案暂时不可用");
		expect(learnerStore.recommendationsLoading).toBe(false);
	});

	it("passes a custom limit through to the API", async () => {
		api.getLearningRecommendations.mockResolvedValue(snapshot({ limit: 1 }));
		await learnerStore.loadRecommendations(1);
		expect(api.getLearningRecommendations).toHaveBeenCalledWith(1);
		expect(learnerStore.recommendations?.limit).toBe(1);
	});
});

describe("recommendation failures and concept scope", () => {
	it("clears a previously successful snapshot when the next read fails", async () => {
		api.getLearningRecommendations.mockResolvedValueOnce(snapshot());
		await learnerStore.loadRecommendations();
		expect(learnerStore.recommendations?.status).toBe("ok");

		api.getLearningRecommendations.mockRejectedValueOnce(new ApiError(503, "PROFILE_UNAVAILABLE"));
		await learnerStore.loadRecommendations();

		expect(learnerStore.recommendations).toBeNull();
		expect(learnerStore.recommendationsError).toContain("学习档案暂时不可用");
	});

	it("replaces a previous success with a real empty result", async () => {
		api.getLearningRecommendations.mockResolvedValueOnce(snapshot());
		await learnerStore.loadRecommendations();

		api.getLearningRecommendations.mockResolvedValueOnce(snapshot({
			recommendations: [], status: "empty", empty_reason: "no_actionable_state",
		}));
		await learnerStore.loadRecommendations();

		expect(learnerStore.recommendations?.status).toBe("empty");
		expect(learnerStore.recommendations?.recommendations).toEqual([]);
		expect(learnerStore.recommendationsError).toBeNull();
	});

	it("does not let an older success revive a result invalidated by a newer failure", async () => {
		const older = deferred<RecommendationSnapshot>();
		const newer = deferred<RecommendationSnapshot>();
		api.getLearningRecommendations
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);

		const first = learnerStore.loadRecommendations();
		const second = learnerStore.loadRecommendations();

		newer.reject(new ApiError(503, "PROFILE_UNAVAILABLE"));
		await second;
		older.resolve(snapshot({ profile_version: 99 }));
		await first;

		expect(learnerStore.recommendations).toBeNull();
		expect(learnerStore.recommendationsError).toContain("学习档案暂时不可用");
		expect(learnerStore.recommendationsLoading).toBe(false);
	});

	it("shows a recovered snapshot after a failure", async () => {
		api.getLearningRecommendations.mockRejectedValueOnce(new ApiError(503, "PROFILE_UNAVAILABLE"));
		await learnerStore.loadRecommendations();
		expect(learnerStore.recommendationsError).toBeTruthy();

		api.getLearningRecommendations.mockResolvedValueOnce(snapshot({ profile_version: 12 }));
		await learnerStore.loadRecommendations();

		expect(learnerStore.recommendations?.profile_version).toBe(12);
		expect(learnerStore.recommendationsError).toBeNull();
	});

	it("reads a concept-scoped snapshot and drops the previous concept immediately", async () => {
		const previous = snapshot({ concept_id: "concept_a" });
		learnerStore.conceptRecommendation = previous;
		api.getLearningRecommendations.mockResolvedValue(snapshot({ concept_id: "concept_b" }));

		const pending = learnerStore.loadConceptRecommendation("concept_b");
		expect(learnerStore.conceptRecommendation).toBeNull();
		expect(learnerStore.conceptRecommendationLoading).toBe(true);
		await pending;

		expect(api.getLearningRecommendations).toHaveBeenLastCalledWith(3, "concept_b");
		expect(learnerStore.conceptRecommendation?.concept_id).toBe("concept_b");
		expect(learnerStore.conceptRecommendationConceptId).toBe("concept_b");
		expect(learnerStore.conceptRecommendationError).toBeNull();
	});

	it("rejects a scoped response that belongs to another concept", async () => {
		api.getLearningRecommendations.mockResolvedValue(snapshot({ concept_id: "concept_other" }));

		await learnerStore.loadConceptRecommendation("concept_a");

		expect(learnerStore.conceptRecommendation).toBeNull();
		expect(learnerStore.conceptRecommendationError).toContain("不一致");
	});

	it("drops a late scoped response for a concept the learner already left", async () => {
		const older = deferred<RecommendationSnapshot>();
		const newer = deferred<RecommendationSnapshot>();
		api.getLearningRecommendations
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);

		const first = learnerStore.loadConceptRecommendation("concept_a");
		const second = learnerStore.loadConceptRecommendation("concept_b");
		newer.resolve(snapshot({ concept_id: "concept_b" }));
		await second;
		older.resolve(snapshot({ concept_id: "concept_a" }));
		await first;

		expect(learnerStore.conceptRecommendation?.concept_id).toBe("concept_b");
		expect(learnerStore.conceptRecommendationConceptId).toBe("concept_b");
	});

	it("clears concept advice on failure instead of keeping the last concept's card", async () => {
		learnerStore.conceptRecommendation = snapshot({ concept_id: "concept_a" });
		api.getLearningRecommendations.mockRejectedValue(new ApiError(503, "PROFILE_UNAVAILABLE"));

		await learnerStore.loadConceptRecommendation("concept_a");

		expect(learnerStore.conceptRecommendation).toBeNull();
		expect(learnerStore.conceptRecommendationError).toContain("学习档案暂时不可用");
	});
});
