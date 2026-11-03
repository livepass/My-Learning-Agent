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
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	learnerStore.recommendations = null;
	learnerStore.recommendationsError = null;
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
