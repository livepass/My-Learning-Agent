import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnPage } from "./LearnPage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { chatStore } from "../../stores/chat-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { learnWorkbenchStore } from "../../stores/learn-workbench-store.js";
import { ApiError } from "../../api/client.js";
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

const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getSessionCourseContext: vi.fn(),
}));
vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...coursesApi };
});

/** The workbench always names a course; every conversation below belongs to it. */
const pythonCourse = {
	course_id: "course_python",
	title: "Python 编程",
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 0, tasks: 0, sessions: 0, sources: 0 },
};

function setUrl(query: string) {
	window.history.replaceState(null, "", `/?${query}`);
}

const question = {
	question_id: "q1", question_version: "1", concept_id: "closure", goal_id: "g1",
	prompt: "请解释闭包与词法作用域的关系。", kind: "free_recall" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	coursesStore.reset();
	learnWorkbenchStore.reset();
	setUrl("page=learn&course=course_python&session=s1.jsonl");
	coursesApi.listCourses.mockResolvedValue([pythonCourse]);
	coursesApi.getSessionCourseContext.mockResolvedValue({
		session_id: "s1.jsonl", unclassified: true, binding: null,
		course: null, task: null, source_ids: [], goal_ids: [],
	});
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	// The open conversation is course-bound: unclassified Web history is
	// read-only (E4.8a), and these cases exercise the learning-state panel.
	sessionsStore.sessions = [{
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
	}] as never;
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
	learnWorkbenchStore.reset();
	setUrl("page=today");
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
		expect(screen.getByText(/已保存作答，等待评分/)).toBeTruthy();

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
	const meta = (
		id: string,
		updatedAt: string,
		options: { archived?: boolean; courseId?: string | null } = {},
	) => ({
		id,
		name: id,
		createdAt: "2026-11-02T02:32:07.000Z",
		updatedAt,
		messageCount: 2,
		preview: "你好",
		channels: ["web" as const],
		origin: "web" as const,
		archived: options.archived === true,
		course: options.courseId === null
			? null
			: { course_id: options.courseId ?? "course_python", title: "Python 编程", archived: false, task_id: null },
		daily_visible: options.archived !== true,
	});

	it("does not open a conversation when the URL only names a course", async () => {
		setUrl("page=learn&course=course_python");
		sessionsStore.currentSessionId = null;
		sessionsStore.sessions = [
			meta("old.jsonl", "2026-11-02T02:32:13.376Z"),
			meta("new.jsonl", "2026-11-04T08:02:46.698Z"),
		];
		const open = vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);

		render(<LearnPage />);

		await waitFor(() => expect(sessionsStore.load).toHaveBeenCalled());
		// 「?page=learn&course=…」 selects a course; it never opens (or creates) a
		// conversation, so a refresh cannot silently resume the wrong one.
		expect(open).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "学习问题" })).toBeTruthy();
	});

	it("shows only the selected course's conversations", async () => {
		sessionsStore.currentSessionId = null;
		sessionsStore.sessions = [
			meta("python.jsonl", "2026-11-04T08:02:46.698Z"),
			meta("math.jsonl", "2026-11-05T08:02:46.698Z", { courseId: "course_math" }),
		];
		coursesApi.listCourses.mockResolvedValue([
			pythonCourse,
			{ ...pythonCourse, course_id: "course_math", title: "高等数学" },
		]);

		render(<LearnPage />);

		expect(await screen.findByText("python.jsonl")).toBeTruthy();
		// A conversation belongs to exactly one course; B's list stays out of A.
		expect(screen.queryByText("math.jsonl")).toBeNull();
		expect(screen.getByText("高等数学")).toBeTruthy();
	});

	it("keeps the conversation named by the URL and its own course", async () => {
		setUrl("page=learn&course=course_math&session=python.jsonl");
		sessionsStore.currentSessionId = "python.jsonl";
		sessionsStore.sessions = [meta("python.jsonl", "2026-11-04T08:02:46.698Z")];

		render(<LearnPage />);

		await waitFor(() => expect(window.location.search).toContain("course=course_python"));
		// The URL said 高等数学, the binding says Python: the binding wins and the
		// address is corrected instead of sending under the wrong course.
		expect(window.location.search).toContain("session=python.jsonl");
	});
});

describe("learn page session management", () => {
	const meta = (
		id: string,
		options: { updatedAt?: string; archived?: boolean; messageCount?: number } = {},
	) => ({
		id,
		name: id,
		createdAt: "2026-11-02T02:32:07.000Z",
		updatedAt: options.updatedAt ?? "2026-11-04T08:02:46.698Z",
		messageCount: options.messageCount ?? 2,
		preview: "你好",
		channels: ["web" as const],
		origin: "web" as const,
		course: { course_id: "course_python", title: "Python 编程", archived: false, task_id: null },
		daily_visible: !options.archived,
		...(options.archived ? { archived: true } : {}),
	});

	const openRowMenu = async (name: string) => {
		const trigger = await screen.findByRole("button", { name: `会话操作：${name}` });
		fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
	};

	const chooseMenuItem = async (label: string | RegExp) => {
		fireEvent.click(await screen.findByRole("menuitem", { name: label }));
	};

	it("deletes a conversation only after an explicit confirmation", async () => {
		sessionsStore.sessions = [meta("old.jsonl"), meta("new.jsonl")];
		const open = vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);
		const remove = vi.spyOn(sessionsStore, "deleteSession").mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/永久删除/);

		await waitFor(() => expect(remove).toHaveBeenCalledWith("old.jsonl", { createReplacement: false }));
		expect(window.confirm).toHaveBeenCalledTimes(1);
		const copy = (window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
		expect(copy).toContain("已经写入长期学习档案的学习证据和掌握状态不会自动删除或回滚");
		expect(copy).toContain("这不等同于彻底清除个人学习数据");
		// D3/D4: the server no longer creates a replacement behind the user's back.
		expect(copy).not.toContain("创建一个新的空会话");
		// Deleting must not also open the row it belongs to.
		expect(open).not.toHaveBeenCalled();
	});

	it("deletes the last conversation and enters a new blank one after confirmation", async () => {
		sessionsStore.sessions = [meta("only.jsonl")];
		sessionsStore.currentSessionId = "only.jsonl";
		const remove = vi.spyOn(sessionsStore, "deleteSession").mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("only.jsonl");
		await chooseMenuItem(/永久删除/);

		await waitFor(() => expect(remove).toHaveBeenCalledWith("only.jsonl", { createReplacement: true }));
		const copy = (window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
		expect(copy).toContain("这是当前唯一的会话");
		expect(copy).toContain("新建一个空白对话");
		// Never tells the learner to create a throwaway conversation first.
		expect(copy).not.toContain("请先新建一个会话");
	});

	it("requests a successor for any open-conversation delete, so a vanishing peer is not a 409", async () => {
		sessionsStore.sessions = [meta("old.jsonl"), meta("new.jsonl")];
		sessionsStore.currentSessionId = "old.jsonl";
		const remove = vi.spyOn(sessionsStore, "deleteSession").mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/永久删除/);

		// The server still prefers the existing conversation; the flag only makes
		// the explicit confirmation cover the case where none is left.
		await waitFor(() => expect(remove).toHaveBeenCalledWith("old.jsonl", { createReplacement: true }));
		const copy = (window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
		expect(copy).toContain("删除后会自动切换到另一个已有会话");
		expect(copy).not.toContain("这是当前唯一的会话");
	});

	it("does not request a successor when deleting another conversation", async () => {
		sessionsStore.sessions = [meta("old.jsonl"), meta("new.jsonl")];
		sessionsStore.currentSessionId = "new.jsonl";
		const remove = vi.spyOn(sessionsStore, "deleteSession").mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/永久删除/);

		await waitFor(() => expect(remove).toHaveBeenCalledWith("old.jsonl", { createReplacement: false }));
	});

	it("keeps the last conversation and its messages when the blank replacement cannot be created", async () => {
		sessionsStore.sessions = [meta("only.jsonl")];
		sessionsStore.currentSessionId = "only.jsonl";
		vi.spyOn(sessionsStore, "deleteSession").mockRejectedValue(
			new ApiError(500, "replacement_create_failed", { error: "replacement_create_failed" }),
		);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("only.jsonl");
		await chooseMenuItem(/永久删除/);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("无法新建空白会话"));
		expect(screen.getByRole("alert").textContent).toContain("已保留");
		expect(screen.getByText("only.jsonl")).toBeTruthy();
	});

	it("explains the no-replacement conflict and keeps the conversation", async () => {
		sessionsStore.sessions = [meta("only.jsonl")];
		sessionsStore.currentSessionId = "only.jsonl";
		vi.spyOn(sessionsStore, "deleteSession").mockRejectedValue(
			new ApiError(409, "no_replacement_session", { error: "no_replacement_session" }),
		);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("only.jsonl");
		await chooseMenuItem(/永久删除/);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("这是当前唯一的会话"));
		expect(screen.getByText("only.jsonl")).toBeTruthy();
	});

	it("keeps the row when the replacement disappears during deletion", async () => {
		sessionsStore.sessions = [meta("old.jsonl")];
		vi.spyOn(sessionsStore, "deleteSession").mockRejectedValue(
			new ApiError(409, "replacement_unavailable", { error: "replacement_unavailable" }),
		);
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/永久删除/);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("准备切换到的会话已不可用"));
		expect(screen.getByText("old.jsonl")).toBeTruthy();
	});

	it("leaves the conversation alone when the confirmation is dismissed", async () => {
		sessionsStore.sessions = [meta("old.jsonl")];
		const remove = vi.spyOn(sessionsStore, "deleteSession").mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(false);

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/永久删除/);

		expect(remove).not.toHaveBeenCalled();
		expect(screen.getByText("old.jsonl")).toBeTruthy();
	});

	it("reports a failed delete and keeps the row", async () => {
		sessionsStore.sessions = [meta("old.jsonl")];
		vi.spyOn(sessionsStore, "deleteSession").mockRejectedValue(new Error("Session not found"));
		vi.spyOn(window, "confirm").mockReturnValue(true);

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/永久删除/);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("删除失败"));
		expect(screen.getByText("old.jsonl")).toBeTruthy();
	});

	it("archives a conversation from its secondary menu", async () => {
		sessionsStore.sessions = [meta("old.jsonl")];
		const archive = vi.spyOn(sessionsStore, "archiveSession").mockResolvedValue(undefined);

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/归档会话/);

		await waitFor(() => expect(archive).toHaveBeenCalledWith("old.jsonl"));
	});

	it("keeps archived conversations out of the daily list and points at settings", async () => {
		sessionsStore.sessions = [
			meta("active.jsonl"),
			meta("archived.jsonl", { archived: true }),
			{
				...meta("with-course.jsonl"),
				course: { course_id: "course_math", title: "高等数学", archived: true },
				daily_visible: false,
			},
		];

		render(<LearnPage />);

		expect(await screen.findByText("active.jsonl")).toBeTruthy();
		// E4.7-R1b: no inline archived group; both hidden reasons leave the list.
		expect(screen.queryByText("archived.jsonl")).toBeNull();
		expect(screen.queryByText("with-course.jsonl")).toBeNull();
		expect(screen.getByText(/2 个会话不在日常列表中/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "前往归档会话" }));
		await waitFor(() => expect(window.location.search).toContain("tab=archived-sessions"));
	});

	it("points at the archive centre when every conversation is archived", async () => {
		sessionsStore.sessions = [
			meta("first.jsonl", { archived: true }),
			meta("second.jsonl", { archived: true }),
		];

		render(<LearnPage />);

		expect(await screen.findByText(/这门课程还没有学习对话/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "前往归档会话" })).toBeTruthy();
		expect(screen.queryByText("first.jsonl")).toBeNull();
	});

	it("lists every conversation of the course instead of hiding the tail", async () => {
		sessionsStore.sessions = Array.from({ length: 8 }, (_, index) => meta(`s${index + 1}.jsonl`));

		render(<LearnPage />);

		// E4.8: the sidebar is a course-scoped list, not a "first six" shelf —
		// every conversation of the course is reachable without a "show all".
		expect(await screen.findByText("s6.jsonl")).toBeTruthy();
		expect(screen.getByText("s8.jsonl")).toBeTruthy();
		expect(screen.getByText("s1.jsonl")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: /^会话操作：/ })).toHaveLength(8);
	});

	it("keeps a conversation visible when archiving fails", async () => {
		sessionsStore.sessions = [meta("old.jsonl")];
		vi.spyOn(sessionsStore, "archiveSession").mockRejectedValue(new Error("active chat turn"));

		render(<LearnPage />);
		await openRowMenu("old.jsonl");
		await chooseMenuItem(/归档会话/);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("归档失败"));
		expect(screen.getByText("old.jsonl")).toBeTruthy();
	});
});

describe("learn page — manually archived history (E4.7-R1 final)", () => {
	const archivedMeta = {
		id: "s1.jsonl",
		name: "已归档会话",
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-02T00:00:00.000Z",
		messageCount: 4,
		preview: "闭包与作用域",
		channels: ["web"],
		archived: true,
		course: null,
		daily_visible: false,
	};

	it("shows the conversation read-only and never restores it on open", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: { revision: 3, status: "active", step: "conversation", updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [],
			pending_action: null,
		});
		const unarchive = vi.spyOn(sessionsStore, "unarchiveSession").mockResolvedValue(undefined);
		sessionsStore.sessions = [archivedMeta] as never;

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByText(/该会话已归档，本次会话仅供查看/)).toBeTruthy());
		// No composer, and no record writes either: the server refuses both.
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
		expect(screen.queryByRole("button", { name: /暂停学习/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /继续学习/ })).toBeNull();
		// Opening history is a read; restoring needs its own explicit action.
		expect(unarchive).not.toHaveBeenCalled();
	});

	it("offers no initialise action for an archived conversation without a record", async () => {
		api.getLearningState.mockResolvedValue({ exists: false });
		sessionsStore.sessions = [archivedMeta] as never;

		render(<LearnPage />);

		await waitFor(() => expect(screen.getByText(/归档期间不能新建记录/)).toBeTruthy());
		expect(screen.queryByRole("button", { name: "初始化学习记录" })).toBeNull();
		expect(api.initLearning).not.toHaveBeenCalled();
	});
});
