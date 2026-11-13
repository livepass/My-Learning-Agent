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

/**
 * E4.8b — the AI learning page opens as a conversation-style home.
 *
 * These cases pin the acceptance list: welcome + course cards first, the
 * composer locked until a course is chosen, the course's own greeting and quick
 * starts after choosing, and the course-scoped conversation list only once a
 * conversation is actually open.
 */

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

const course = (
	id: string,
	title: string,
	status: "in_progress" | "paused" | "completed" | "archived" = "in_progress",
	sessions = 0,
) => ({
	course_id: id,
	title,
	description: "",
	status,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 0, tasks: 0, sessions, sources: 0 },
});

const sessionMeta = (id: string, options: { courseId?: string | null; updatedAt?: string } = {}) => ({
	id,
	name: id,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: options.updatedAt ?? "2026-11-02T00:00:00.000Z",
	messageCount: 2,
	preview: "上次的问题",
	channels: ["web" as const],
	origin: "web" as const,
	archived: false,
	course: options.courseId === null
		? null
		: { course_id: options.courseId ?? "course_python", title: "Python 编程", archived: false, task_id: null },
	daily_visible: true,
});

function setUrl(query: string) {
	window.history.replaceState(null, "", `/?${query}`);
}

const composer = () => screen.getByRole("textbox", { name: "学习问题" }) as HTMLTextAreaElement;

beforeEach(() => {
	vi.clearAllMocks();
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
	learningApi.getLearningState.mockResolvedValue({ exists: false });
	coursesApi.getSessionCourseContext.mockResolvedValue({
		session_id: "", unclassified: true, binding: null, course: null, task: null, source_ids: [], goal_ids: [],
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	setUrl("page=today");
	appStore.chatDraft = "";
	sessionsStore.currentSessionId = null;
});

describe("learn welcome home (E4.8b)", () => {
	it("greets the learner and lists every non-archived course as a card", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([
			course("course_python", "Python 编程", "in_progress", 3),
			course("course_math", "高等数学", "paused"),
			course("course_done", "算法基础", "completed"),
			course("course_old", "旧课程", "archived"),
		]);

		render(<LearnPage />);

		expect(await screen.findByRole("heading", { name: "你想学习什么？" })).toBeTruthy();
		expect(screen.getByText("先选择一门课程，再开始本次 AI 学习。")).toBeTruthy();

		const python = screen.getByRole("button", { name: "选择课程：Python 编程" });
		expect(python.textContent).toContain("进行中");
		expect(python.textContent).toContain("3 个对话");
		expect(screen.getByRole("button", { name: "选择课程：高等数学" }).textContent).toContain("已暂停");
		expect(screen.getByRole("button", { name: "选择课程：算法基础" }).textContent).toContain("已完成");
		// Archived courses never lead the welcome home.
		expect(screen.queryByRole("button", { name: "选择课程：旧课程" })).toBeNull();
		expect(screen.getByRole("button", { name: /归档课程 1 门/ })).toBeTruthy();
		// The creation entry sits after the course cards.
		expect(screen.getByRole("button", { name: /创建课程/ })).toBeTruthy();
		// No course/conversation sidebar before a conversation is open.
		expect(screen.queryByRole("complementary", { name: "课程与学习对话" })).toBeNull();
	});

	it("keeps the composer disabled and refuses to send until a course is chosen", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);

		render(<LearnPage />);

		await screen.findByRole("heading", { name: "你想学习什么？" });
		expect(composer().disabled).toBe(true);
		expect(composer().placeholder).toBe("请先选择一门课程，再开始本次 AI 学习");
		fireEvent.change(composer(), { target: { value: "绕过课程直接提问" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));

		expect(appStore.chatDraft).toBe("");
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
		expect(chatStore.send).not.toHaveBeenCalled();
	});

	it("activates the composer and shows quick starts after choosing a course", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学")]);

		render(<LearnPage />);
		fireEvent.click(await screen.findByRole("button", { name: "选择课程：高等数学" }));

		expect(await screen.findByRole("heading", { name: "你想在「高等数学」中学习什么？" })).toBeTruthy();
		expect(composer().disabled).toBe(false);
		expect(composer().placeholder).toBe("在「高等数学」中输入你的问题");
		for (const label of ["讲解知识点", "制定学习计划", "开始练习", "根据资料提问", "复习薄弱点"]) {
			expect(screen.getByRole("button", { name: label })).toBeTruthy();
		}
		// A quick start only fills the composer; it never creates a conversation.
		fireEvent.click(screen.getByRole("button", { name: "讲解知识点" }));
		expect(appStore.chatDraft).toContain("高等数学");
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
		expect(sessionsStore.currentSessionId).toBeNull();
	});

	it("creates the course-bound conversation on the first send from the welcome home", async () => {
		setUrl("page=learn");
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
		fireEvent.click(await screen.findByRole("button", { name: "选择课程：Python 编程" }));
		fireEvent.change(await screen.findByRole("textbox", { name: "学习问题" }), { target: { value: "讲讲闭包" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));

		await waitFor(() => expect(coursesApi.startCourseLearning).toHaveBeenCalledWith(
			"course_python",
			{ task_id: null, request_id: expect.any(String) },
		));
		await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith("讲讲闭包"));
	});

	it("shows the course conversation list only after a conversation is open", async () => {
		setUrl("page=learn&course=course_python");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		sessionsStore.sessions = [
			sessionMeta("python-old.jsonl"),
			sessionMeta("math.jsonl", { courseId: "course_math" }),
		] as never;

		render(<LearnPage />);

		// Welcome: the list is collapsed behind its own toggle, and B's
		// conversation is never part of A's list.
		fireEvent.click(await screen.findByRole("button", { name: /继续之前的对话/ }));
		expect(await screen.findByText("python-old.jsonl")).toBeTruthy();
		expect(screen.queryByText("math.jsonl")).toBeNull();
		expect(screen.queryByRole("complementary", { name: "课程与学习对话" })).toBeNull();
		expect(screen.queryByRole("complementary", { name: "本次学习状态" })).toBeNull();

		// Opening a conversation switches to the course layout.
		fireEvent.click(screen.getByText("python-old.jsonl"));

		expect(await screen.findByRole("complementary", { name: "课程与学习对话" })).toBeTruthy();
		expect(screen.getByRole("complementary", { name: "本次学习状态" })).toBeTruthy();
		expect(screen.queryByRole("heading", { name: "你想学习什么？" })).toBeNull();
	});

	it("explains a paused course instead of offering a chat", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学", "paused")]);

		render(<LearnPage />);
		fireEvent.click(await screen.findByRole("button", { name: "选择课程：高等数学" }));

		expect(await screen.findByText("课程已暂停")).toBeTruthy();
		expect(screen.getByRole("button", { name: "继续课程" })).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
		// No quick starts while the course cannot accept new learning.
		expect(screen.queryByRole("button", { name: "讲解知识点" })).toBeNull();
	});

	it("keeps a completed course read-only", async () => {
		setUrl("page=learn");
		coursesApi.listCourses.mockResolvedValue([course("course_done", "算法基础", "completed")]);

		render(<LearnPage />);
		fireEvent.click(await screen.findByRole("button", { name: "选择课程：算法基础" }));

		expect(await screen.findByText("课程已完成")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
		expect(screen.queryByRole("button", { name: "讲解知识点" })).toBeNull();
	});

	it("returns to the course picker without deleting the open conversation", async () => {
		setUrl("page=learn&course=course_python&session=python-old.jsonl");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程")]);
		sessionsStore.sessions = [sessionMeta("python-old.jsonl")] as never;
		sessionsStore.currentSessionId = "python-old.jsonl";

		render(<LearnPage />);
		fireEvent.click(await screen.findByRole("button", { name: "返回课程选择" }));

		expect(await screen.findByRole("heading", { name: "你想学习什么？" })).toBeTruthy();
		expect(sessionsStore.currentSessionId).toBeNull();
		// Leaving the conversation is not a delete: the row stays in the list.
		expect(sessionsStore.sessions.some((session) => session.id === "python-old.jsonl")).toBe(true);
	});
});
