// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnPage } from "./LearnPage.js";
import { appStore } from "../../stores/app-store.js";
import { chatStore } from "../../stores/chat-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { learnWorkbenchStore } from "../../stores/learn-workbench-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";

vi.mock("../MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));

const learningApi = vi.hoisted(() => ({ getLearningState: vi.fn(), initLearning: vi.fn() }));
vi.mock("../../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/learning.js")>("../../api/learning.js");
	return { ...actual, ...learningApi };
});

const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	createCourse: vi.fn(),
	getSessionCourseContext: vi.fn(),
	startCourseLearning: vi.fn(),
	resumeCourse: vi.fn(),
}));
vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...coursesApi };
});

const course = (id: string, title: string, status: "in_progress" | "paused" | "completed" | "archived" = "in_progress") => ({
	course_id: id,
	title,
	description: "",
	status,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 0, tasks: 0, sessions: 0, sources: 0 },
});

const sessionMeta = (
	id: string,
	options: { courseId?: string | null; courseTitle?: string; taskId?: string | null; archived?: boolean } = {},
) => ({
	id,
	name: id,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	messageCount: 2,
	preview: "上次的问题",
	channels: ["web" as const],
	origin: "web" as const,
	archived: options.archived === true,
	course: options.courseId === null
		? null
		: {
			course_id: options.courseId ?? "course_python",
			title: options.courseTitle ?? "Python 编程",
			archived: false,
			task_id: options.taskId ?? null,
		},
	daily_visible: options.archived !== true,
});

function setUrl(query: string) {
	window.history.replaceState(null, "", `/?${query}`);
}

beforeEach(() => {
	vi.clearAllMocks();
	// jsdom has no native <dialog>; the create-course dialog needs showModal.
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value: function (this: HTMLDialogElement) { this.open = true; },
	});
	Object.defineProperty(HTMLDialogElement.prototype, "close", {
		configurable: true,
		value: function (this: HTMLDialogElement) { this.open = false; },
	});
	coursesStore.reset();
	learnWorkbenchStore.reset();
	sessionsStore.sessions = [];
	sessionsStore.currentSessionId = null;
	sessionsStore.openingSessionId = null;
	sessionsStore.pendingNewSession = false;
	learningStore.clear();
	appStore.chatDraft = "";
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(sessionsStore, "openSession").mockImplementation(async (id: string) => {
		sessionsStore.selectSession(id);
	});
	vi.spyOn(chatStore, "send").mockResolvedValue(undefined);
	coursesApi.getSessionCourseContext.mockResolvedValue({
		session_id: "", unclassified: true, binding: null, course: null, task: null, source_ids: [], goal_ids: [],
	});
	learningApi.getLearningState.mockResolvedValue({ exists: false });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	setUrl("page=today");
	appStore.chatDraft = "";
});

describe("learn workbench — course gate", () => {
	it("asks for a course instead of offering a composer when there is none", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([]);

		render(<LearnPage />);

		expect((await screen.findAllByText("还没有课程")).length).toBeGreaterThan(0);
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
		// The empty state offers the one action that can unblock it.
		expect(screen.getAllByRole("button", { name: /创建课程/ }).length).toBeGreaterThan(0);
	});

	it("creates the first course from the empty state and selects it", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([]);
		coursesApi.createCourse.mockResolvedValue(course("course_new", "线性代数"));

		render(<LearnPage />);
		await screen.findAllByText("还没有课程");
		coursesApi.listCourses.mockResolvedValue([course("course_new", "线性代数")]);
		fireEvent.click(screen.getAllByRole("button", { name: /创建课程/ })[0]!);
		fireEvent.change(screen.getByPlaceholderText("例如：Python 编程"), { target: { value: "线性代数" } });
		const createButtons = screen.getAllByRole("button", { name: "创建课程" });
		fireEvent.click(createButtons[createButtons.length - 1]!);

		await waitFor(() => expect(coursesApi.createCourse).toHaveBeenCalledWith({ title: "线性代数", description: undefined }));
		// Creating a course selects it but never opens a chat file.
		await waitFor(() => expect(window.location.search).toContain("course=course_new"));
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.getByRole("textbox", { name: "学习问题" })).toBeTruthy());
	});

	it("does not accept a message until a course is selected", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);

		render(<LearnPage />);

		expect(await screen.findByText("先选择一门课程")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
	});

	it("opens an empty workbench on selection without creating a conversation", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学")]);

		render(<LearnPage />);
		fireEvent.click((await screen.findAllByRole("button", { name: /高等数学/ }))[0]!);

		await waitFor(() => expect(window.location.search).toContain("course=course_math"));
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
		expect(sessionsStore.currentSessionId).toBeNull();
		expect(screen.getByRole("textbox", { name: "学习问题" })).toBeTruthy();
	});

	it("creates the course-bound conversation on the first send", async () => {
		setUrl("page=learn&course=course_python");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		coursesApi.startCourseLearning.mockResolvedValue({
			request_id: "req_1",
			session: { session_id: "s_new.jsonl", active: true, created: true, resumed: false },
			course: { course_id: "course_python", title: "Python 编程", status: "in_progress" },
			task: null,
			goal_id: null,
			learning: { created: true, checkpoint: null },
			context_ready: true,
			warnings: [],
		});

		render(<LearnPage />);
		const input = await screen.findByRole("textbox", { name: "学习问题" });
		fireEvent.change(input, { target: { value: "讲讲闭包" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));

		await waitFor(() => expect(coursesApi.startCourseLearning).toHaveBeenCalledWith(
			"course_python",
			{ task_id: null, request_id: expect.any(String) },
		));
		await waitFor(() => expect(sessionsStore.openSession).toHaveBeenCalledWith("s_new.jsonl", { historyMode: "replace" }));
		// The message leaves only after the binding exists.
		await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith("讲讲闭包"));
	});

	it("clears the draft when switching courses, so it cannot be sent elsewhere", async () => {
		setUrl("page=learn&course=course_python");
		coursesApi.listCourses.mockResolvedValue([
			course("course_python", "Python 编程"),
			course("course_math", "高等数学"),
		]);

		render(<LearnPage />);
		fireEvent.change(await screen.findByRole("textbox", { name: "学习问题" }), {
			target: { value: "写给 Python 的问题" },
		});
		expect(appStore.chatDraft).toBe("写给 Python 的问题");

		fireEvent.click(screen.getAllByRole("button", { name: /高等数学/ })[0]!);

		await waitFor(() => expect(appStore.chatDraft).toBe(""));
		expect(sessionsStore.currentSessionId).toBeNull();
	});

	it("blocks a paused course and offers to resume it", async () => {
		setUrl("page=learn&course=course_math");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学", "paused")]);
		coursesApi.resumeCourse.mockResolvedValue(course("course_math", "高等数学"));

		render(<LearnPage />);

		expect(await screen.findByText("课程已暂停")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();

		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学")]);
		fireEvent.click(screen.getByRole("button", { name: "继续课程" }));
		await waitFor(() => expect(coursesApi.resumeCourse).toHaveBeenCalledWith("course_math"));
	});

	it("keeps legacy unclassified conversations reachable without rebinding them", async () => {
		setUrl("page=learn&course=course_python");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		sessionsStore.sessions = [
			sessionMeta("python.jsonl"),
			sessionMeta("legacy.jsonl", { courseId: null }),
		] as never;

		render(<LearnPage />);
		expect(await screen.findByText("python.jsonl")).toBeTruthy();
		expect(screen.queryByText("legacy.jsonl")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /未归类历史/ }));
		fireEvent.click(await screen.findByText("legacy.jsonl"));

		await waitFor(() => expect(sessionsStore.openSession).toHaveBeenCalledWith("legacy.jsonl"));
		// Opening history is not a classification: the binding stays absent.
		expect(sessionsStore.sessions.find((session) => session.id === "legacy.jsonl")?.course).toBeNull();
	});
});
