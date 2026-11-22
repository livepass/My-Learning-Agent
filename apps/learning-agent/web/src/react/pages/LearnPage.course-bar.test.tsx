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
import type { LearningState } from "../../api/learning.js";

vi.mock("../MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));

const learningApi = vi.hoisted(() => ({
	getLearningState: vi.fn(),
	initLearning: vi.fn(),
	pauseLearning: vi.fn(),
	resumeLearning: vi.fn(),
}));
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

	it("opens and closes the learning-context sheet from the bar button", async () => {
		render(<LearnPage />);

		const barButton = await screen.findByRole("button", { name: "学习状态" });
		await waitFor(() => expect(barButton.getAttribute("aria-expanded")).toBe("false"));
		// E4.9g-P2-3: the sheet starts closed and owns its own open state; the
		// old inline 展开/收起学习状态 toggle no longer exists.
		expect(screen.queryByRole("button", { name: /展开学习状态|收起学习状态/ })).toBeNull();
		expect(screen.queryByRole("region", { name: "学习上下文" })).toBeNull();

		fireEvent.click(barButton);
		await waitFor(() => expect(screen.getByRole("region", { name: "学习上下文" })).toBeTruthy());
		expect(barButton.getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(barButton);
		await waitFor(() => expect(screen.queryByRole("region", { name: "学习上下文" })).toBeNull());
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

/**
 * E4.9g-P2-2-R1 — the bar must never show the course the page had selected
 * before the switch. These cases hold the server context back on purpose, which
 * is exactly the window where the old fallback painted A under B.
 */
describe("learn course bar — binding transitions", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((res) => { resolve = res; });
		return { promise, resolve };
	}

	const englishSession = () => session({
		id: "s2.jsonl",
		name: "英语写作",
		course: { course_id: "course_english", title: "英语学术写作", archived: false, task_id: null },
	});

	const englishContext = () => ({
		session_id: "s2.jsonl",
		unclassified: false,
		binding: {
			binding_id: "b2",
			course_id: "course_english",
			session_id: "s2.jsonl",
			task_id: "task_en",
			origin: "task",
			created_at: "2026-11-02T00:00:00.000Z",
		},
		course: { ...english, description: "" },
		task: {
			task_id: "task_en",
			title: "搭建论证结构",
			status: "in_progress",
			stage_id: "stage_en",
			plan_id: "plan_en",
			estimated_minutes: 30,
			concept_ids: [],
		},
		source_ids: [],
		goal_ids: [],
	});

	const englishDetail = () => courseDetail({
		course: { ...english, description: "" },
		counts: english.counts,
		stages: [{
			stage_id: "stage_en",
			course_id: "course_english",
			plan_id: "plan_en",
			title: "第二阶段：论点与证据",
			description: "",
			order: 0,
			created_at: "",
			updated_at: "",
		}],
	});

	const openWithPendingContext = async () => {
		// The workbench still names course A: this is the stale value the old
		// `selectedCourse` fallback would have painted under conversation B.
		learnWorkbenchStore.courseId = "course_python";
		sessionsStore.sessions = [session(), englishSession()] as never;
		sessionsStore.currentSessionId = "s2.jsonl";
		setUrl("page=learn&course=course_python&session=s2.jsonl");
		coursesApi.getSessionCourseContext.mockReturnValue(new Promise(() => undefined));

		render(<LearnPage />);

		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByText("英语学术写作")).toBeTruthy());
		return bar;
	};

	it("does not show the previous course while B's context is still loading", async () => {
		const bar = await openWithPendingContext();

		// The conversation's own binding names B; A must not leak in any form.
		expect(within(bar).getByText("英语学术写作")).toBeTruthy();
		expect(within(bar).queryByText("Python 编程")).toBeNull();
		expect(within(bar).queryByText("理解装饰器的求值顺序")).toBeNull();
		expect(within(bar).queryByText(/阶段：/)).toBeNull();

		// The plan entry points at the bound course, never at the stale selection.
		fireEvent.click(within(bar).getByRole("button", { name: "课程计划" }));
		await waitFor(() => expect(window.location.search).toContain("course=course_english"));
	});

	it("switches to B's task and stage once the server context arrives", async () => {
		const contextRequest = deferred<ReturnType<typeof englishContext>>();
		learnWorkbenchStore.courseId = "course_python";
		sessionsStore.sessions = [session(), englishSession()] as never;
		sessionsStore.currentSessionId = "s2.jsonl";
		setUrl("page=learn&course=course_python&session=s2.jsonl");
		coursesApi.getSessionCourseContext.mockReturnValue(contextRequest.promise);
		coursesApi.getCourse.mockResolvedValue(englishDetail());

		render(<LearnPage />);
		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByText("英语学术写作")).toBeTruthy());

		await act(async () => {
			contextRequest.resolve(englishContext());
			await Promise.resolve();
		});

		await waitFor(() => expect(within(bar).getByText("搭建论证结构")).toBeTruthy());
		expect(within(bar).getByText("阶段：第二阶段：论点与证据")).toBeTruthy();
		expect(within(bar).queryByText("理解装饰器的求值顺序")).toBeNull();
	});

	it("keeps an unclassified conversation unbound even with a stale course selected", async () => {
		learnWorkbenchStore.courseId = "course_python";
		sessionsStore.sessions = [session({ course: null })] as never;
		sessionsStore.currentSessionId = "s1.jsonl";
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
		// No fallback to the course that was selected before this conversation.
		expect(within(bar).queryByText("Python 编程")).toBeNull();
		expect(within(bar).queryByText("当前任务")).toBeNull();
		expect(screen.queryByRole("button", { name: "课程计划" })).toBeNull();
		expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
	});

	it("prefers the server binding over the cached session meta", async () => {
		// The session list still says Python, but the server binding is the
		// authority and says English. The two must never be mixed in the bar.
		sessionsStore.sessions = [session()] as never;
		sessionsStore.currentSessionId = "s1.jsonl";
		coursesApi.getSessionCourseContext.mockResolvedValue(englishContext());
		coursesApi.getCourse.mockResolvedValue(englishDetail());

		render(<LearnPage />);

		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByText("英语学术写作")).toBeTruthy());
		expect(within(bar).queryByText("Python 编程")).toBeNull();
		expect(within(bar).getByText("搭建论证结构")).toBeTruthy();
		expect(within(bar).queryByText("理解装饰器的求值顺序")).toBeNull();

		// The actions follow the same server answer, not the cached meta.
		fireEvent.click(within(bar).getByRole("button", { name: "课程计划" }));
		await waitFor(() => expect(window.location.search).toContain("course=course_english"));
	});
});

/**
 * E4.9g-P2-2-R2 — one permission authority.
 *
 * These cases pin the three states that used to disagree: what the bar shows,
 * whether the composer accepts a message, and whether the checkpoint panel
 * offers initialise / pause / resume. Every one of them is decided from the
 * server's answer for the *open conversation*, never from the cached session
 * list or the course the page had selected before.
 */
describe("learn page — conversation permission authority", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((res) => { resolve = res; });
		return { promise, resolve };
	}

	const englishContext = () => ({
		session_id: "s2.jsonl",
		unclassified: false,
		binding: {
			binding_id: "b2",
			course_id: "course_english",
			session_id: "s2.jsonl",
			task_id: "task_en",
			origin: "task",
			created_at: "2026-11-02T00:00:00.000Z",
		},
		course: { ...english, description: "" },
		task: {
			task_id: "task_en",
			title: "搭建论证结构",
			status: "in_progress",
			stage_id: "stage_en",
			plan_id: "plan_en",
			estimated_minutes: 30,
			concept_ids: [],
		},
		source_ids: [],
		goal_ids: [],
	});

	const englishDetail = () => courseDetail({
		course: { ...english, description: "" },
		counts: english.counts,
		stages: [{
			stage_id: "stage_en",
			course_id: "course_english",
			plan_id: "plan_en",
			title: "第二阶段：论点与证据",
			description: "",
			order: 0,
			created_at: "",
			updated_at: "",
		}],
	});

	const unclassifiedContext = (sessionId: string) => ({
		session_id: sessionId,
		unclassified: true,
		binding: null,
		course: null,
		task: null,
		source_ids: [],
		goal_ids: [],
	});

	/** The composer only exists when the conversation accepts a write. */
	const expectNoComposer = () => {
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
		expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
	};

	const expandStatus = async () => {
		const expand = screen.queryByRole("button", { name: "展开学习状态" });
		if (expand) fireEvent.click(expand);
	};

	it("T01 — server unclassified overrides a cached course binding", async () => {
		// The cache still says "bound to Python"; the server says no binding.
		sessionsStore.sessions = [session()] as never;
		sessionsStore.currentSessionId = "s1.jsonl";
		coursesApi.getSessionCourseContext.mockResolvedValue(unclassifiedContext("s1.jsonl"));
		learningApi.getLearningState.mockResolvedValue({ exists: false });

		render(<LearnPage />);

		const bar = await screen.findByLabelText("课程栏");
		await waitFor(() => expect(within(bar).getByText("未归类对话")).toBeTruthy());
		await waitFor(() => expect(screen.getByText(/未归类历史，仅供查看/)).toBeTruthy());

		// No write path: no composer, no course actions, no checkpoint init.
		expectNoComposer();
		expect(screen.queryByRole("button", { name: "课程计划" })).toBeNull();
		expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
		await expandStatus();
		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
		expect(learningApi.initLearning).not.toHaveBeenCalled();
		expect(coursesApi.startCourseLearning).not.toHaveBeenCalled();
	});

	it("T02 — a server-paused course blocks sending even when the cache says in_progress", async () => {
		// The cached row and the cached context both say in_progress; only the
		// server answer knows the course was paused.
		sessionsStore.sessions = [session()] as never;
		sessionsStore.currentSessionId = "s1.jsonl";
		coursesApi.listCourses.mockResolvedValue([{ ...python, status: "in_progress" }, english]);
		coursesApi.getSessionCourseContext.mockResolvedValue({
			...context(),
			course: { ...python, description: "", status: "paused" },
		});

		render(<LearnPage />);

		expect(await screen.findByText("课程已暂停")).toBeTruthy();
		expectNoComposer();

		fireEvent.click(screen.getByRole("button", { name: "继续课程" }));
		await waitFor(() => expect(coursesApi.resumeCourse).toHaveBeenCalledWith("course_python"));
	});

	it("T03 — a server binding to course B never inherits course A's permission", async () => {
		// Cached session and URL both name Python; the server binding is English.
		sessionsStore.sessions = [session()] as never;
		sessionsStore.currentSessionId = "s1.jsonl";
		coursesApi.listCourses.mockResolvedValue([python, english]);
		coursesApi.getSessionCourseContext.mockResolvedValue(englishContext());
		coursesApi.getCourse.mockResolvedValue(englishDetail());

		render(<LearnPage />);

		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByText("英语学术写作")).toBeTruthy());
		expect(within(bar).queryByText("Python 编程")).toBeNull();

		// The plan entry follows B, not the stale A selection.
		fireEvent.click(within(bar).getByRole("button", { name: "课程计划" }));
		await waitFor(() => expect(window.location.search).toContain("course=course_english"));
		expect(window.location.search).not.toContain("course=course_python");

		// And the composer is open for B, the course the server actually bound.
		expect(screen.getByRole("textbox", { name: "学习问题" })).toBeTruthy();
	});

	it("T04 — a bound in-progress course still accepts a normal conversation", async () => {
		render(<LearnPage />);

		await screen.findByLabelText("当前课程任务");
		const composer = screen.getByRole("textbox", { name: "学习问题" }) as HTMLTextAreaElement;
		expect(composer.disabled).toBe(false);
		expect(screen.queryByText(/正在确认课程权限/)).toBeNull();

		fireEvent.change(composer, { target: { value: "继续讲装饰器" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith("继续讲装饰器"));
	});

	it("T05 — an archived conversation stays read-only even when its course is in progress", async () => {
		sessionsStore.sessions = [session({ archived: true, daily_visible: false })] as never;
		sessionsStore.currentSessionId = "s1.jsonl";
		// The server binding itself says the course is fine.
		coursesApi.getSessionCourseContext.mockResolvedValue(context());

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByText(/该会话已归档，本次会话仅供查看/)).toBeTruthy());
		expectNoComposer();
		await expandStatus();
		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
		expect(screen.queryByRole("button", { name: /暂停学习/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /继续学习/ })).toBeNull();
	});

	it("T06 — a delayed context never opens writes on the previous course", async () => {
		const pending = deferred<ReturnType<typeof englishContext>>();
		learnWorkbenchStore.courseId = "course_python";
		sessionsStore.sessions = [session(), session({
			id: "s2.jsonl",
			name: "英语写作",
			course: { course_id: "course_english", title: "英语学术写作", archived: false, task_id: null },
		})] as never;
		sessionsStore.currentSessionId = "s2.jsonl";
		setUrl("page=learn&course=course_python&session=s2.jsonl");
		coursesApi.getSessionCourseContext.mockReturnValue(pending.promise);

		render(<LearnPage />);

		// Until the server answers, the bar names B (from its own metadata) but
		// nothing claims a write permission: the composer is closed.
		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByText("英语学术写作")).toBeTruthy());
		expect(within(bar).queryByText("Python 编程")).toBeNull();
		expectNoComposer();

		await act(async () => {
			pending.resolve(englishContext());
			await Promise.resolve();
		});

		await waitFor(() => expect(screen.getByRole("textbox", { name: "学习问题" })).toBeTruthy());
		expect(screen.queryByText(/正在确认课程权限/)).toBeNull();
	});

	it("T07 — a completed course cannot continue and offers no resume entry", async () => {
		sessionsStore.sessions = [session()] as never;
		sessionsStore.currentSessionId = "s1.jsonl";
		coursesApi.getSessionCourseContext.mockResolvedValue({
			...context(),
			course: { ...python, description: "", status: "completed" },
		});

		render(<LearnPage />);

		expect(await screen.findByText("课程已完成")).toBeTruthy();
		expectNoComposer();
		// "Continue course" is the paused-course action; completed has no way back.
		expect(screen.queryByRole("button", { name: "继续课程" })).toBeNull();
		await expandStatus();
		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
		expect(screen.queryByRole("button", { name: /暂停学习/ })).toBeNull();
	});

	/**
	 * "New conversation" is a write inside a course, in both the bar and the
	 * sidebar. It used to be gated on `barCourse.status` / `selectedCourse`
	 * alone, so a paused, completed or unconfirmed course still offered it.
	 */
	it("offers no new-conversation entry unless the server confirms an in-progress course", async () => {
		// Confirmed in-progress: the bar entry exists (the sidebar has its own).
		render(<LearnPage />);
		const bar = await screen.findByLabelText("当前课程任务");
		await waitFor(() => expect(within(bar).getByRole("button", { name: "新建对话" })).toBeTruthy());
		expect(screen.getAllByRole("button", { name: "新建对话" }).length).toBeGreaterThan(0);
		cleanup();

		// Each scenario starts from a fresh store: a cached context for the same
		// session is not re-read, so reusing one store would test the cache.
		const reopen = async (answer: unknown, expectedCopy: RegExp) => {
			cleanup();
			coursesStore.reset();
			sessionsStore.sessions = [session()] as never;
			sessionsStore.currentSessionId = "s1.jsonl";
			coursesApi.getSessionCourseContext.mockResolvedValue(answer);
			render(<LearnPage />);
			await screen.findByText(expectedCopy);
			expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
		};

		// Server says paused, cache still says in_progress.
		await reopen(
			{ ...context(), course: { ...python, description: "", status: "paused" } },
			/课程已暂停/,
		);
		// Server says completed.
		await reopen(
			{ ...context(), course: { ...python, description: "", status: "completed" } },
			/课程已完成/,
		);
		// Server says unclassified while the cache still names Python.
		await reopen(unclassifiedContext("s1.jsonl"), /未归类历史，仅供查看/);
	});

	it("keeps checkpoint writes available for a bound in-progress course", async () => {
		learningApi.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 4, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
			pending_action: null,
		});

		render(<LearnPage />);

		// E4.9g-P2-3: checkpoint actions live in the sheet, which starts closed.
		fireEvent.click(await screen.findByRole("button", { name: "学习状态" }));
		await waitFor(() => expect(screen.getByRole("button", { name: /暂停学习/ })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /暂停学习/ }));
		// The write carries the session and the revision it was read at.
		await waitFor(() => expect(learningApi.pauseLearning).toHaveBeenCalledWith("s1.jsonl", 4));
	});
});

/**
 * E4.9g-P2-3 — the learning context as an on-demand sheet.
 *
 * T01–T06, T12 and T14 are interaction rules; the permission cases (T10/T11)
 * are the P2-2-R2 authority seen through the sheet, and must not regress.
 */
describe("learn page — learning-context sheet", () => {
	const sheetRegion = () => screen.queryByRole("region", { name: "学习上下文" });
	const openSheet = async () => {
		fireEvent.click(await screen.findByRole("button", { name: "学习状态" }));
		await waitFor(() => expect(sheetRegion()).toBeTruthy());
		return sheetRegion()!;
	};

	it("T01 — starts closed even when a real checkpoint exists", async () => {
		learningApi.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 5, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
			pending_action: null,
		});

		render(<LearnPage />);

		await screen.findByLabelText("当前课程任务");
		// The old fixed column opened itself for a real checkpoint; an overlay
		// must not cover the chat on arrival.
		expect(sheetRegion()).toBeNull();
		expect(screen.queryByText("本次学习")).toBeNull();
		expect(screen.getByRole("button", { name: "学习状态" }).getAttribute("aria-expanded")).toBe("false");
	});

	it("T02 — the bar button opens the sheet with the current conversation's context", async () => {
		render(<LearnPage />);

		const region = await openSheet();

		expect(within(region).getByText("Python 编程")).toBeTruthy();
		expect(screen.getByRole("button", { name: "学习状态" }).getAttribute("aria-expanded")).toBe("true");
	});

	it("T03 — the close button closes the sheet and returns focus to the bar button", async () => {
		render(<LearnPage />);
		const barButton = await screen.findByRole("button", { name: "学习状态" });
		// Focus the trigger first, the way a keyboard user would: the sheet
		// restores whatever had focus when it opened.
		barButton.focus();
		fireEvent.click(barButton);
		await waitFor(() => expect(sheetRegion()).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: "关闭学习上下文" }));

		await waitFor(() => expect(sheetRegion()).toBeNull());
		expect(document.activeElement).toBe(barButton);
		expect(barButton.getAttribute("aria-expanded")).toBe("false");
	});

	it("T04 — Escape closes the sheet", async () => {
		render(<LearnPage />);
		await openSheet();

		fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });

		await waitFor(() => expect(sheetRegion()).toBeNull());
	});

	it("T05 — a click outside the sheet closes it on desktop", async () => {
		render(<LearnPage />);
		await openSheet();

		fireEvent.pointerDown(document.body);

		await waitFor(() => expect(sheetRegion()).toBeNull());
	});

	it("T06 — nothing from the sheet is in the Tab order once it is closed", async () => {
		render(<LearnPage />);
		await openSheet();
		expect(screen.getByRole("button", { name: "关闭学习上下文" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "关闭学习上下文" }));

		await waitFor(() => expect(sheetRegion()).toBeNull());
		expect(screen.queryByRole("button", { name: "关闭学习上下文" })).toBeNull();
		expect(document.querySelector(".mla-sheet")).toBeNull();
	});

	it("T07 — opening the sheet never initialises the learning record", async () => {
		learningApi.getLearningState.mockResolvedValue({ exists: false });

		render(<LearnPage />);
		await openSheet();

		expect(screen.getByRole("button", { name: "初始化学习记录" })).toBeTruthy();
		expect(learningApi.initLearning).not.toHaveBeenCalled();
	});

	it("T10 — an unclassified conversation offers no checkpoint write", async () => {
		coursesApi.getSessionCourseContext.mockResolvedValue({
			session_id: "s1.jsonl", unclassified: true, binding: null,
			course: null, task: null, source_ids: [], goal_ids: [],
		});
		learningApi.getLearningState.mockResolvedValue({ exists: false });

		render(<LearnPage />);
		await screen.findByText(/未归类历史，仅供查看/);
		await openSheet();

		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
		expect(screen.queryByRole("button", { name: /暂停学习/ })).toBeNull();
		expect(learningApi.initLearning).not.toHaveBeenCalled();
	});

	it("T11 — a paused course offers no checkpoint write inside the sheet", async () => {
		coursesApi.getSessionCourseContext.mockResolvedValue({
			...context(),
			course: { ...python, description: "", status: "paused" },
		});
		learningApi.getLearningState.mockResolvedValue({ exists: false });

		render(<LearnPage />);
		await screen.findByText("课程已暂停");
		await openSheet();

		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
		expect(learningApi.initLearning).not.toHaveBeenCalled();
	});

	it("T12 — switching conversation closes the sheet instead of showing stale data", async () => {
		learningApi.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 2, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
			pending_action: null,
		});

		render(<LearnPage />);
		const region = await openSheet();
		expect(within(region).getByText("Python 编程")).toBeTruthy();

		act(() => {
			sessionsStore.selectSession("s2.jsonl");
		});

		await waitFor(() => expect(sheetRegion()).toBeNull());
	});

	it("T14 — the history drawer and the sheet are never open together", async () => {
		render(<LearnPage />);
		await openSheet();

		// Opening the history drawer closes the sheet.
		fireEvent.click(screen.getByRole("button", { name: "打开课程列表" }));
		await waitFor(() => expect(sheetRegion()).toBeNull());

		// And opening the sheet closes the drawer.
		await openSheet();
		expect(document.querySelector(".mla-learn--nav-open")).toBeNull();
	});
});

/**
 * E4.9g-P2-4 — the sheet belongs to one conversation.
 *
 * The P2-3 version closed the sheet from an effect after `currentSessionId`
 * changed, which leaves one render where the new conversation is current but
 * the old panel is still mounted. These cases hold that window open on purpose.
 */
describe("learn page — sheet session identity", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((res) => { resolve = res; });
		return { promise, resolve };
	}

	const sheetRegion = () => screen.queryByRole("region", { name: "学习上下文" });
	const openSheet = async () => {
		fireEvent.click(await screen.findByRole("button", { name: "学习状态" }));
		await waitFor(() => expect(sheetRegion()).toBeTruthy());
	};

	it("T17a — switching conversation hides the sheet in the same render", async () => {
		learningApi.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: {
				revision: 7,
				status: "active",
				step: "awaiting_answer",
				updated_at: "2026-11-02T00:00:00.000Z",
				question: { question_id: "qa", question_version: "1" },
			},
			questions: [{ question_id: "qa", question_version: "1", concept_id: "c", prompt: "A 会话的题目。", kind: "free_recall" }],
			pending_action: null,
		});
		sessionsStore.sessions = [session(), session({
			id: "s2.jsonl",
			name: "第二段",
			course: { course_id: "course_english", title: "英语学术写作", archived: false, task_id: null },
		})] as never;
		sessionsStore.currentSessionId = "s1.jsonl";

		render(<LearnPage />);
		await openSheet();
		await waitFor(() => expect(screen.getByText("A 会话的题目。")).toBeTruthy());

		// Switch synchronously: no effect has run yet, so this is exactly the
		// frame the old boolean could not cover.
		act(() => {
			sessionsStore.selectSession("s2.jsonl");
		});

		expect(sheetRegion()).toBeNull();
		expect(screen.queryByText("A 会话的题目。")).toBeNull();
	});

	it("T17b — B's checkpoint is not shown before B's state has loaded", async () => {
		const first = deferred<LearningState>();
		const second = deferred<LearningState>();
		learningApi.getLearningState.mockImplementation((id: string) => (id === "s1.jsonl" ? first.promise : second.promise));
		sessionsStore.sessions = [session(), session({
			id: "s2.jsonl",
			name: "第二段",
			course: { course_id: "course_english", title: "英语学术写作", archived: false, task_id: null },
		})] as never;
		sessionsStore.currentSessionId = "s1.jsonl";

		render(<LearnPage />);
		first.resolve({
			exists: true,
			checkpoint: {
				revision: 3,
				status: "active",
				step: "awaiting_answer",
				updated_at: "2026-11-02T00:00:00.000Z",
				question: { question_id: "qa", question_version: "1" },
			},
			questions: [{ question_id: "qa", question_version: "1", concept_id: "c", prompt: "A 会话的题目。", kind: "free_recall" }],
		});
		await openSheet();
		await waitFor(() => expect(screen.getByText("A 会话的题目。")).toBeTruthy());

		act(() => {
			sessionsStore.selectSession("s2.jsonl");
		});
		// B is current, B's read has not answered. Nothing of A may be shown,
		// and the sheet (closed by the switch) must not reopen by itself.
		expect(sheetRegion()).toBeNull();
		expect(screen.queryByText("A 会话的题目。")).toBeNull();

		await openSheet();
		// Opened on B while B is still loading: the loading copy, not A's data.
		expect(screen.getByText("正在读取学习状态…")).toBeTruthy();
		expect(screen.queryByText("A 会话的题目。")).toBeNull();

		act(() => {
			second.resolve({ exists: false });
		});
		await waitFor(() => expect(screen.getByText(/这段会话还没有学习检查点/)).toBeTruthy());
	});

	it("T17c — a fast A → B → A does not reopen the old sheet", async () => {
		learningApi.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 2, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
			pending_action: null,
		});
		sessionsStore.sessions = [session(), session({
			id: "s2.jsonl",
			name: "第二段",
			course: { course_id: "course_english", title: "英语学术写作", archived: false, task_id: null },
		})] as never;
		sessionsStore.currentSessionId = "s1.jsonl";

		render(<LearnPage />);
		await openSheet();

		// Two separate switches, the way a learner would click them.
		act(() => {
			sessionsStore.selectSession("s2.jsonl");
		});
		act(() => {
			sessionsStore.selectSession("s1.jsonl");
		});

		// Back on A, but the learner never re-opened the sheet.
		expect(sheetRegion()).toBeNull();
	});

	it("T17d — checkpoint writes follow the open conversation only", async () => {
		learningApi.getLearningState.mockImplementation(async (id: string) => ({
			exists: true,
			checkpoint: { revision: id === "s1.jsonl" ? 5 : 8, status: "active", step: "awaiting_answer", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
			pending_action: null,
		}));
		sessionsStore.sessions = [session(), session({
			id: "s2.jsonl",
			name: "第二段",
			course: { course_id: "course_english", title: "英语学术写作", archived: false, task_id: null },
		})] as never;
		sessionsStore.currentSessionId = "s1.jsonl";

		render(<LearnPage />);
		act(() => {
			sessionsStore.selectSession("s2.jsonl");
		});
		await openSheet();
		await waitFor(() => expect(screen.getByRole("button", { name: /暂停学习/ })).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: /暂停学习/ }));

		// The write is issued for B at B's revision, never A's.
		await waitFor(() => expect(learningApi.pauseLearning).toHaveBeenCalledWith("s2.jsonl", 8));
		expect(learningApi.pauseLearning).not.toHaveBeenCalledWith("s1.jsonl", expect.anything());
	});
});
