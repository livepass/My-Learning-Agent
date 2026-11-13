// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnPage } from "./LearnPage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { chatStore } from "../../stores/chat-store.js";
import { coursesStore } from "../../stores/courses-store.js";

/**
 * E4.5d: the AI learning page names the course task it belongs to, and the URL
 * decides which conversation is open — a course-task entry is never replaced by
 * "the most recent conversation".
 */

vi.mock("../MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));

const learningApi = vi.hoisted(() => ({
	getLearningState: vi.fn(),
	initLearning: vi.fn(),
}));
vi.mock("../../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learning.js")>("../../api/learning.js");
	return { ...actual, ...learningApi };
});

const coursesApi = vi.hoisted(() => ({
	getSessionCourseContext: vi.fn(),
	getCourse: vi.fn(),
}));
vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...coursesApi };
});

function setUrl(query: string) {
	window.history.replaceState(null, "", `/?${query}`);
}

beforeEach(() => {
	vi.clearAllMocks();
	coursesStore.reset();
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);
	sessionsStore.sessions = [];
	sessionsStore.currentSessionId = null;
	sessionsStore.pendingNewSession = false;
	sessionsStore.openingSessionId = null;
	learningStore.clear();
	chatStore.streamingError = "";
	learningApi.getLearningState.mockResolvedValue({ exists: false });
	coursesApi.getSessionCourseContext.mockResolvedValue({
		session_id: "s_python.jsonl",
		unclassified: true,
		binding: null,
		course: null,
		task: null,
		source_ids: [],
		goal_ids: [],
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	sessionsStore.currentSessionId = null;
	sessionsStore.pendingNewSession = false;
	sessionsStore.openingSessionId = null;
	setUrl("page=today");
});

describe("learn page — course context", () => {
	it("shows the course, task and stage above the chat", async () => {
		setUrl("page=learn&session=s_python.jsonl");
		sessionsStore.currentSessionId = "s_python.jsonl";
		learningStore.sessionId = "s_python.jsonl";
		coursesApi.getSessionCourseContext.mockResolvedValue({
			session_id: "s_python.jsonl",
			unclassified: false,
			binding: {
				binding_id: "b1", course_id: "course_python", session_id: "s_python.jsonl",
				task_id: "task_1", origin: "task", created_at: "2026-11-02T00:00:00.000Z",
			},
			course: {
				course_id: "course_python", title: "Python 编程", description: "",
				status: "in_progress", created_at: "", updated_at: "",
			},
			task: {
				task_id: "task_1", title: "理解装饰器的求值顺序", status: "in_progress",
				stage_id: "stage_1", plan_id: "plan_1", estimated_minutes: 25, concept_ids: [],
			},
			source_ids: [],
			goal_ids: [],
		});
		coursesApi.getCourse.mockResolvedValue({
			course: {
				course_id: "course_python", title: "Python 编程", description: "",
				status: "in_progress", created_at: "", updated_at: "",
			},
			counts: { goals: 0, plans: 1, tasks: 1, sessions: 1, sources: 0 },
			goals: [], plans: [], sessions: [], sources: [],
			stages: [{
				stage_id: "stage_1", course_id: "course_python", plan_id: "plan_1",
				title: "第一阶段：函数与作用域", description: "", order: 0, created_at: "", updated_at: "",
			}],
			tasks: [],
		});

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByLabelText("当前课程任务")).toBeTruthy());
		const strip = screen.getByLabelText("当前课程任务");
		expect(strip.textContent).toContain("Python 编程");
		expect(strip.textContent).toContain("理解装饰器的求值顺序");
		expect(strip.textContent).toContain("第一阶段：函数与作用域");
		// Entering the page is not a completion action.
		expect(screen.queryByRole("button", { name: /完成任务|标记完成/ })).toBeNull();
	});

	it("shows no strip for an unclassified conversation", async () => {
		setUrl("page=learn&session=legacy.jsonl");
		sessionsStore.currentSessionId = "legacy.jsonl";
		learningStore.sessionId = "legacy.jsonl";
		coursesApi.getSessionCourseContext.mockResolvedValue({
			session_id: "legacy.jsonl", unclassified: true, binding: null,
			course: null, task: null, source_ids: [], goal_ids: [],
		});

		render(<LearnPage />);

		await waitFor(() => expect(coursesApi.getSessionCourseContext).toHaveBeenCalledWith("legacy.jsonl", expect.anything()));
		expect(screen.queryByLabelText("当前课程任务")).toBeNull();
	});

	it("never overrides a session named by the URL with the most recent conversation", async () => {
		setUrl("page=learn&session=s_math.jsonl");
		sessionsStore.sessions = [{
			id: "s_python.jsonl",
			name: "Python 学习",
			updatedAt: "2026-11-05T00:00:00.000Z",
			archived: false,
		} as never];

		render(<LearnPage />);

		// E4.8b: with no conversation open the page is the welcome home; the
		// session list (and its 本次学习 panel) only appears once one is open.
		await waitFor(() => expect(screen.getByRole("heading", { name: "你想学习什么？" })).toBeTruthy());
		// The URL wins: no auto-open of the newest session.
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
	});
});
