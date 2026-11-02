import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { learningStore } from "./learning-store.js";

const api = vi.hoisted(() => ({
	getLearningState: vi.fn(),
	initLearning: vi.fn(),
	pauseLearning: vi.fn(),
	resumeLearning: vi.fn(),
}));

vi.mock("../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../api/learning.js")>("../api/learning.js");
	return { ...actual, ...api };
});

const checkpoint = (revision: number, status: "active" | "paused" = "active") => ({
	revision, status, step: "awaiting_answer" as const, updated_at: "2026-11-02T00:00:00.000Z",
});

beforeEach(() => {
	vi.clearAllMocks();
	learningStore.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("learning store", () => {
	it("loads the public state without initialising a missing record", async () => {
		api.getLearningState.mockResolvedValue({ exists: false });
		await learningStore.load("s1.jsonl");
		expect(api.getLearningState).toHaveBeenCalledWith("s1.jsonl");
		// Entering a page must never create the record implicitly.
		expect(api.initLearning).not.toHaveBeenCalled();
		expect(learningStore.state).toEqual({ exists: false });
	});

	it("initialises only when explicitly asked", async () => {
		learningStore.sessionId = "s1.jsonl";
		api.initLearning.mockResolvedValue(checkpoint(1));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(1) });
		await learningStore.init("goal-1");
		expect(api.initLearning).toHaveBeenCalledWith("s1.jsonl", "goal-1");
		expect(learningStore.state?.checkpoint?.revision).toBe(1);
	});

	it("pauses and resumes with the current checkpoint revision", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(3) };
		api.pauseLearning.mockResolvedValue(checkpoint(4, "paused"));
		await learningStore.pause();
		expect(api.pauseLearning).toHaveBeenCalledWith("s1.jsonl", 3);
		expect(learningStore.state?.checkpoint?.status).toBe("paused");

		api.resumeLearning.mockResolvedValue(checkpoint(5));
		await learningStore.resume();
		expect(api.resumeLearning).toHaveBeenCalledWith("s1.jsonl", 4);
		expect(learningStore.state?.checkpoint?.status).toBe("active");
	});

	it("reports a conflict and reloads the newest revision instead of clobbering it", async () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(2) };
		api.pauseLearning.mockRejectedValue(new ApiError(409, "learning_conflict", { revision: 5 }));
		api.getLearningState.mockResolvedValue({ exists: true, checkpoint: checkpoint(5) });

		await learningStore.pause();
		expect(learningStore.error).toContain("已被更新");
		expect(api.getLearningState).toHaveBeenCalledWith("s1.jsonl");
		expect(learningStore.state?.checkpoint?.revision).toBe(5);
	});

	it("maps storage failures to non-leaking messages", async () => {
		api.getLearningState.mockRejectedValue(new ApiError(503, "learning_read_only"));
		await learningStore.load("s1.jsonl");
		expect(learningStore.error).toContain("不可写");
		expect(learningStore.state).toBeNull();

		api.getLearningState.mockRejectedValue(new ApiError(404, "Session not found"));
		await learningStore.load("s2.jsonl");
		expect(learningStore.error).toContain("不存在");
	});

	it("clears state when no session is open", () => {
		learningStore.sessionId = "s1.jsonl";
		learningStore.state = { exists: true, checkpoint: checkpoint(1) };
		learningStore.clear();
		expect(learningStore.state).toBeNull();
		expect(learningStore.sessionId).toBeNull();
	});
});
