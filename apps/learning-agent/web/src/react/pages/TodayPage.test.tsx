import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayPage } from "./TodayPage.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import type { RecommendationSnapshot } from "../../types/learner.js";

const api = vi.hoisted(() => ({
	getLearnerProfile: vi.fn(),
	getLearningRecommendations: vi.fn(),
}));

vi.mock("../../api/learner.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learner.js")>("../../api/learner.js");
	return { ...actual, ...api };
});

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../shell/navigation.js", () => ({ navigate: nav.navigate }));

const profile = (overrides: Record<string, unknown> = {}) => ({
	learner_id: "default",
	version: 3,
	updated_at: "2026-11-03T00:00:00.000Z",
	goals: [],
	knowledge_states: [],
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
	...overrides,
});

const recommendation = (overrides: Record<string, unknown> = {}) => ({
	concept_id: "concept_a",
	concept_name: "Python 闭包",
	name_available: true,
	action: "review" as const,
	suggested_kind: "free_recall" as const,
	reason_code: "review_due" as const,
	reason: "这条知识点的复习时间已到，建议先用自由回忆检索一次。",
	also_matches: [],
	evidence_basis: {
		state_label: "review_due" as const,
		review_due_at: "2026-11-02T00:00:00.000Z",
		evidence_count: 2,
		has_active_misconception: false,
		provenance_limited: false,
		exposure_only: false,
	},
	...overrides,
});

const snapshot = (recommendations: unknown[]): RecommendationSnapshot => ({
	as_of: "2026-11-03T12:00:00.000Z",
	generated_at: "2026-11-03T12:00:00.000Z",
	profile_version: 3,
	recommendations: recommendations as RecommendationSnapshot["recommendations"],
	status: recommendations.length > 0 ? "ok" : "empty",
	...(recommendations.length === 0 ? { empty_reason: "no_knowledge_evidence" as const } : {}),
	limit: 3,
});

beforeEach(() => {
	vi.clearAllMocks();
	learnerStore.profile = null;
	learnerStore.recommendations = null;
	learnerStore.recommendationsError = null;
	learnerStore.error = null;
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	sessionsStore.sessions = [];
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("today page recommendations (C4-B)", () => {
	it("shows the name, action, reason and evidence basis, and only navigates on click", async () => {
		api.getLearnerProfile.mockResolvedValue(profile());
		api.getLearningRecommendations.mockResolvedValue(snapshot([recommendation()]));

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("Python 闭包")).toBeTruthy());
		expect(screen.getAllByText("到期复习").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText(/复习时间已到/)).toBeTruthy();
		expect(screen.getByText("可追溯证据 2 条")).toBeTruthy();
		expect(screen.getByText("建议题型：自由回忆")).toBeTruthy();
		// Opening the page must not navigate anywhere by itself.
		expect(nav.navigate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /前往练习页/ }));
		expect(nav.navigate).toHaveBeenCalledWith("practice", { history: "push" });
	});

	it("routes a learn recommendation to AI learning instead of practice", async () => {
		api.getLearnerProfile.mockResolvedValue(profile());
		api.getLearningRecommendations.mockResolvedValue(snapshot([
			recommendation({
				action: "learn", suggested_kind: undefined, reason_code: "active_misconception",
				reason: "学习档案中有一条仍在活跃状态的误区记录。",
				evidence_basis: {
					state_label: "misconception", evidence_count: 1,
					has_active_misconception: true, provenance_limited: false, exposure_only: false,
				},
			}),
		]));

		render(<TodayPage />);
		await waitFor(() => expect(screen.getByText("学习与澄清")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /前往 AI 学习/ }));

		expect(nav.navigate).toHaveBeenCalledWith("learn", { history: "push" });
	});

	it("renders the explicit empty state when there is no reliable evidence", async () => {
		api.getLearnerProfile.mockResolvedValue(profile());
		api.getLearningRecommendations.mockResolvedValue(snapshot([]));

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText(/目前没有足够的可靠学习记录/)).toBeTruthy());
		expect(screen.queryByRole("button", { name: /前往练习页/ })).toBeNull();
	});

	it("does not present a machine identity as a topic", async () => {
		api.getLearnerProfile.mockResolvedValue(profile());
		api.getLearningRecommendations.mockResolvedValue(snapshot([recommendation({
			concept_id: "concept_45125622e640",
			concept_name: undefined,
			name_available: false,
			reason: "这个知识点已开始学习但证据还不充分。",
			reason_code: "learning_needs_diagnosis",
			action: "diagnose",
			suggested_kind: "free_recall",
		})]));

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText("知识点名称待确认")).toBeTruthy());
		expect(screen.queryByText(/concept_45125622e640/)).toBeNull();
		expect(screen.getByText(/需要重新确认主题/)).toBeTruthy();
	});

	it("shows an explicit error instead of a fabricated recommendation list", async () => {
		api.getLearnerProfile.mockResolvedValue(profile());
		api.getLearningRecommendations.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }));

		render(<TodayPage />);

		await waitFor(() => expect(screen.getByText(/学习档案暂时不可用/)).toBeTruthy());
		expect(screen.queryByText("Python 闭包")).toBeNull();
		expect(screen.queryByRole("button", { name: /前往练习页/ })).toBeNull();
	});
});
