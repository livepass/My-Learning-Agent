import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnPage } from "./LearnPage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { chatStore } from "../../stores/chat-store.js";
import type { LearningState } from "../../api/learning.js";

vi.mock("../MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));

const api = vi.hoisted(() => ({
	getLearningState: vi.fn(),
	initLearning: vi.fn(),
	pauseLearning: vi.fn(),
	resumeLearning: vi.fn(),
}));

vi.mock("../../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learning.js")>("../../api/learning.js");
	return { ...actual, ...api };
});

const question = {
	question_id: "q1", question_version: "1", concept_id: "closure", goal_id: "g1",
	prompt: "请解释闭包与词法作用域的关系。", kind: "free_recall" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	sessionsStore.sessions = [];
	sessionsStore.currentSessionId = "s1.jsonl";
	sessionsStore.pendingNewSession = false;
	sessionsStore.openingSessionId = null;
	learningStore.clear();
	learningStore.sessionId = "s1.jsonl";
	chatStore.streamingError = "";
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	sessionsStore.currentSessionId = null;
	sessionsStore.pendingNewSession = false;
	sessionsStore.openingSessionId = null;
	chatStore.streamingError = "";
});

describe("learn page learning state", () => {
	it("shows the current question and the pause action, without private scoring material", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 4, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z", question: { question_id: "q1", question_version: "1" } },
			questions: [question],
			pending_action: "evaluate",
		});

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByText("请解释闭包与词法作用域的关系。")).toBeTruthy());
		expect(screen.getByRole("button", { name: /暂停学习/ })).toBeTruthy();
		expect(screen.getByText(/等待评分（评分尚未开放）/)).toBeTruthy();

		// No private material may reach the DOM.
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("reference_answer");
		expect(text).not.toContain("rubric");
		expect(text).not.toContain("hints");
	});

	it("offers an explicit initialise action for a missing record and never auto-initialises", async () => {
		api.getLearningState.mockResolvedValue({ exists: false });

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByRole("button", { name: "初始化学习记录" })).toBeTruthy());
		expect(api.initLearning).not.toHaveBeenCalled();

		api.initLearning.mockResolvedValue({ revision: 1, status: "active", step: "conversation", updated_at: "2026-11-02T00:00:00.000Z" });
		fireEvent.click(screen.getByRole("button", { name: "初始化学习记录" }));
		await waitFor(() => expect(api.initLearning).toHaveBeenCalledWith("s1.jsonl", undefined));
	});

	it("cannot resume a completed checkpoint", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 9, status: "completed", step: "feedback", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
		});

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByText("检查点已完成，不能恢复。")).toBeTruthy());
		expect(screen.queryByRole("button", { name: /继续学习/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /暂停学习/ })).toBeNull();
	});

	it("surfaces a conversation that cannot be opened instead of failing silently", async () => {
		api.getLearningState.mockResolvedValue({ exists: false });
		chatStore.streamingError = "无法打开会话：Session not found";

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("无法打开会话"));
	});

	it("never paints a previous session's checkpoint after a fast switch", async () => {
		const first = deferred<LearningState>();
		const second = deferred<LearningState>();
		api.getLearningState.mockImplementation((id: string) => (id === "s1.jsonl" ? first.promise : second.promise));

		render(<LearnPage />);

		// Switch to s2 while s1 is still in flight, then let s2 answer first.
		act(() => {
			sessionsStore.selectSession("s2.jsonl");
		});
		second.resolve({
			exists: true,
			checkpoint: { revision: 2, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z", question: { question_id: "q2", question_version: "1" } },
			questions: [{ ...question, question_id: "q2", prompt: "第二段会话的题目。" }],
		});

		await waitFor(() => expect(screen.getByText("第二段会话的题目。")).toBeTruthy());

		// The stale s1 answer must not replace it.
		first.resolve({
			exists: true,
			checkpoint: { revision: 9, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z", question: { question_id: "q1", question_version: "1" } },
			questions: [question],
		});
		await waitFor(() => expect(screen.queryByText("请解释闭包与词法作用域的关系。")).toBeNull());
		expect(screen.getByText("第二段会话的题目。")).toBeTruthy();
		expect(screen.getByText(/#2/)).toBeTruthy();
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

describe("learn page conversation resume", () => {
	const meta = (id: string, updatedAt: string, archived = false) => ({
		id,
		name: id,
		createdAt: "2026-11-02T02:32:07.000Z",
		updatedAt,
		messageCount: 2,
		preview: "你好",
		channels: ["web" as const],
		origin: "web" as const,
		archived,
	});

	it("resumes the newest conversation instead of waiting for a new one", async () => {
		sessionsStore.currentSessionId = null;
		sessionsStore.sessions = [
			meta("old.jsonl", "2026-11-02T02:32:13.376Z"),
			meta("new.jsonl", "2026-11-04T08:02:46.698Z"),
		];
		const open = vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);

		render(<LearnPage />);

		await waitFor(() => expect(open).toHaveBeenCalledWith("new.jsonl", { historyMode: "replace" }));
	});

	it("skips archived conversations and does nothing when none can be resumed", async () => {
		sessionsStore.currentSessionId = null;
		sessionsStore.sessions = [meta("archived.jsonl", "2026-11-04T08:02:46.698Z", true)];
		const open = vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);

		render(<LearnPage />);

		await waitFor(() => expect(sessionsStore.load).toHaveBeenCalled());
		expect(open).not.toHaveBeenCalled();
	});

	it("never overrides an explicit new-conversation choice", async () => {
		sessionsStore.currentSessionId = null;
		sessionsStore.pendingNewSession = true;
		sessionsStore.sessions = [meta("old.jsonl", "2026-11-02T02:32:13.376Z")];
		const open = vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);

		render(<LearnPage />);

		await waitFor(() => expect(sessionsStore.load).toHaveBeenCalled());
		expect(open).not.toHaveBeenCalled();
		// The explicit choice survives a re-render with a populated list.
		expect(sessionsStore.pendingNewSession).toBe(true);
	});
});

describe("learn page session delete", () => {
	const meta = (id: string, updatedAt = "2026-11-04T08:02:46.698Z") => ({
		id,
		name: id,
		createdAt: "2026-11-02T02:32:07.000Z",
		updatedAt,
		messageCount: 2,
		preview: "你好",
		channels: ["web" as const],
		origin: "web" as const,
	});

	it("deletes a conversation only after an explicit confirmation", async () => {
		sessionsStore.sessions = [meta("old.jsonl"), meta("new.jsonl")];
		const open = vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);
		const remove = vi.spyOn(sessionsStore, "deleteSession").mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);

		fireEvent.click(await screen.findByRole("button", { name: "删除会话：old.jsonl" }));

		await waitFor(() => expect(remove).toHaveBeenCalledWith("old.jsonl"));
		expect(window.confirm).toHaveBeenCalledTimes(1);
		// Deleting must not also open the row it belongs to.
		expect(open).not.toHaveBeenCalled();
	});

	it("leaves the conversation alone when the confirmation is dismissed", async () => {
		sessionsStore.sessions = [meta("old.jsonl")];
		const remove = vi.spyOn(sessionsStore, "deleteSession").mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(false);

		render(<LearnPage />);

		fireEvent.click(await screen.findByRole("button", { name: "删除会话：old.jsonl" }));

		expect(remove).not.toHaveBeenCalled();
		expect(screen.getByText("old.jsonl")).toBeTruthy();
	});

	it("reports a failed delete and keeps the row", async () => {
		sessionsStore.sessions = [meta("old.jsonl")];
		vi.spyOn(sessionsStore, "deleteSession").mockRejectedValue(new Error("Session not found"));
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);

		fireEvent.click(await screen.findByRole("button", { name: "删除会话：old.jsonl" }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("删除失败"));
		expect(screen.getByText("old.jsonl")).toBeTruthy();
	});
});
