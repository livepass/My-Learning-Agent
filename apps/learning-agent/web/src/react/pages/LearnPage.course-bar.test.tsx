// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { LearnPage } from "./LearnPage.js";
import i18n from "../../i18n/index.js";
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
	getSessionCourseContext: vi.fn(),
	getCourse: vi.fn(),
	startCourseLearning: vi.fn(),
	resumeCourse: vi.fn(),
}));
vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...coursesApi };
});

const python = {
	course_id: "course_python",
	title: "Python 编程",
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 1, sessions: 1, sources: 0 },
};

const english = {
	course_id: "course_english",
	title: "英语学术写作",
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 2, sessions: 2, sources: 0 },
};

const task = {
	task_id: "task_1",
	title: "理解装饰器的求值顺序",
	status: "in_progress" as const,
	stage_id: "stage_1",
	plan_id: "plan_1",
	estimated_minutes: 25,
	concept_ids: [],
};

const session = (overrides: Record<string, unknown> = {}) => ({
	id: "s1.jsonl",
	name: "当前学习",
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	messageCount: 2,
	preview: "继续",
	channels: ["web"],
	origin: "web",
	archived: false,
	course: { course_id: "course_python", title: "Python 编程", archived: false, task_id: null },
	daily_visible: true,
	...overrides,
});

const context = (overrides: Record<string, unknown> = {}) => ({
	session_id: "s1.jsonl",
	unclassified: false,
	binding: {
		binding_id: "b1",
		course_id: "course_python",
		session_id: "s1.jsonl",
		task_id: null,
		origin: "free_question",
		created_at: "2026-11-02T00:00:00.000Z",
	},
	course: { ...python, description: "" },
	task: null,
	source_ids: [],
	goal_ids: [],
	...overrides,
});

const courseDetail = (overrides: Record<string, unknown> = {}) => ({
	course: { ...python, description: "" },
	counts: python.counts,
	goals: [],
	plans: [],
	sessions: [],
	sources: [],
	stages: [{
		stage_id: "stage_1",
		course_id: "course_python",
		plan_id: "plan_1",
		title: "第一阶段：函数与作用域",
		description: "",
		order: 0,
		created_at: "",
		updated_at: "",
	}],
	tasks: [],
	...overrides,
});

function setUrl(query: string) {
	window.history.replaceState(null, "", `/?${query}`);
}

beforeEach(async () => {
	vi.clearAllMocks();
	coursesStore.reset();
	learnWorkbenchStore.reset();
	appStore.chatDraft = "";
	chatStore.streamingError = "";
	learningStore.clear();
	setUrl("page=learn&session=s1.jsonl");
	sessionsStore.sessions = [session()] as never;
	sessionsStore.currentSessionId = "s1.jsonl";
	sessionsStore.pendingNewSession = false;
	sessionsStore.openingSessionId = null;
	learningStore.sessionId = "s1.jsonl";
	coursesApi.listCourses.mockResolvedValue([python, english]);
	coursesApi.getSessionCourseContext.mockResolvedValue(context());
	coursesApi.getCourse.mockResolvedValue(courseDetail());
	learningApi.getLearningState.mockResolvedValue({ exists: false });
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);
	vi.spyOn(chatStore, "send").mockResolvedValue(undefined);
	await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	sessionsStore.currentSessionId = null;
	sessionsStore.pendingNewSession = false;
	sessionsStore.openingSessionId = null;
	setUrl("page=today");
	appStore.chatDraft = "";
	await i18n.changeLanguage("zh-CN");
});

describe("learn course bar — integration", () => {
	it("shows the server-bound task and stage inside the bar", async () => {
		coursesApi.getSessionCourseContext.mockResolvedValue(context({ task }));
		coursesApi.getCourse.mockResolvedValue(courseDetail());

		render(<LearnPage />);

		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByText("理解装饰器的求值顺序")).toBeTruthy());
		expect(within(bar).getByText("阶段：第一阶段：函数与作用域")).toBeTruthy();
		// Reading the page is not a completion action.
		expect(screen.queryByRole("button", { name: /完成任务|标记完成/ })).toBeNull();
	});

	it("never fabricates a task when the server context has none", async () => {
		render(<LearnPage />);

		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByText("自由学习")).toBeTruthy());
		expect(within(bar).queryByText("当前任务")).toBeNull();
		expect(within(bar).queryByText(/阶段：/)).toBeNull();
	});

	it("switches course without creating a session and clears the draft", async () => {
		render(<LearnPage />);
		const trigger = await screen.findByRole("button", { name: "切换课程" });
		appStore.chatDraft = "写给 Python 的问题";

		fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /英语学术写作/ }));

		await waitFor(() => expect(learnWorkbenchStore.courseId).toBe("course_english"));
		expect(sessionsStore.currentSessionId).toBeNull();
		expect(appStore.chatDraft).toBe("");
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
	});

	it("starts a new conversation at the course start without sending", async () => {
		render(<LearnPage />);
		const bar = await screen.findByLabelText("当前课程任务");

		fireEvent.click(within(bar).getByRole("button", { name: "新建对话" }));

		await waitFor(() => expect(sessionsStore.currentSessionId).toBeNull());
		expect(learnWorkbenchStore.courseId).toBe("course_python");
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
		expect(chatStore.send).not.toHaveBeenCalled();
		expect(await screen.findByRole("heading", { name: "你想在「Python 编程」中学习什么？" })).toBeTruthy();
	});

	it("keeps the existing status panel toggle in sync with the bar button", async () => {
		render(<LearnPage />);

		const barButton = await screen.findByRole("button", { name: "学习状态" });
		await waitFor(() => expect(barButton.getAttribute("aria-expanded")).toBe("false"));
		expect(screen.getByRole("button", { name: "展开学习状态" })).toBeTruthy();

		fireEvent.click(barButton);
		await waitFor(() => expect(screen.getByRole("button", { name: "收起学习状态" })).toBeTruthy());
		expect(barButton.getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(barButton);
		await waitFor(() => expect(screen.getByRole("button", { name: "展开学习状态" })).toBeTruthy());
		expect(barButton.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps unclassified history read-only and offers no course actions", async () => {
		sessionsStore.sessions = [session({ course: null })] as never;
		coursesApi.getSessionCourseContext.mockResolvedValue({
			session_id: "s1.jsonl",
			unclassified: true,
			binding: null,
			course: null,
			task: null,
			source_ids: [],
			goal_ids: [],
		});

		render(<LearnPage />);

		const bar = await screen.findByLabelText("课程栏");
		await waitFor(() => expect(within(bar).getByText("未归类对话")).toBeTruthy());
		expect(within(bar).getByText("未归类")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "课程计划" })).toBeNull();
		expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
	});

	it("keeps an archived conversation read-only", async () => {
		sessionsStore.sessions = [session({ archived: true, daily_visible: false })] as never;

		render(<LearnPage />);

		await screen.findByLabelText("当前课程任务");
		expect(await screen.findByText(/该会话已归档，本次会话仅供查看/)).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
	});

	it("switches the course bar copy with the language", async () => {
		render(<LearnPage />);
		const bar = await screen.findByLabelText("当前课程任务");

		await act(async () => {
			await i18n.changeLanguage("en");
		});

		expect(within(bar).getByRole("button", { name: "Course plan" })).toBeTruthy();
		expect(within(bar).getByRole("button", { name: "Learning status" })).toBeTruthy();
		expect(within(bar).getByRole("button", { name: "New conversation" })).toBeTruthy();
		expect(within(bar).getByText("Free learning")).toBeTruthy();

		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(screen.getByRole("button", { name: "课程计划" })).toBeTruthy();
	});
});
