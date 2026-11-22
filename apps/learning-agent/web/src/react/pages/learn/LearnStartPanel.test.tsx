// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderWithTooltipProvider } from "../../test-utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseErrorRef } from "../../../stores/courses-store.js";
import type { CourseSummary } from "../../../api/courses.js";
import type { SessionMeta } from "../../../api/sessions.js";
import { LearnStartPanel, type LearnStartPanelProps } from "./LearnStartPanel.js";

type WelcomeProps = Extract<LearnStartPanelProps, { mode: "welcome" }>;
type EmptyProps = Extract<LearnStartPanelProps, { mode: "empty" }>;

const course = (overrides: Partial<CourseSummary> = {}): CourseSummary => ({
	course_id: "c1",
	title: "机器学习基础",
	description: "",
	status: "in_progress",
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-02T00:00:00.000Z",
	counts: { goals: 1, plans: 1, tasks: 3, sessions: 2, sources: 1 },
	...overrides,
});

const session = (id: string, overrides: Partial<SessionMeta> = {}): SessionMeta => ({
	id,
	name: id,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	messageCount: 2,
	preview: "上次的问题",
	channels: ["web"],
	origin: "web",
	course: { course_id: "c1", title: "机器学习基础", archived: false, task_id: null },
	daily_visible: true,
	...overrides,
});

const row = (item: SessionMeta) => <div key={item.id} data-testid={`row-${item.id}`}>{item.name}</div>;

function welcome(overrides: Partial<WelcomeProps> = {}): WelcomeProps {
	return {
		mode: "welcome",
		course: course(),
		coursesLoading: false,
		coursesError: null,
		activeCourses: [course()],
		archivedCourses: [],
		sessions: [session("s1")],
		courseConversations: [session("s1")],
		unclassifiedSessions: [],
		showHistory: false,
		showUnclassified: false,
		archiveEntryCount: 0,
		onSelectCourse: vi.fn(),
		onCreateCourse: vi.fn(),
		onRetryCourses: vi.fn(),
		onToggleHistory: vi.fn(),
		onToggleUnclassified: vi.fn(),
		onOpenArchive: vi.fn(),
		onSwitchCourse: vi.fn(),
		onResumeRecent: vi.fn(),
		onFillDraft: vi.fn(),
		renderSessionRow: row,
		...overrides,
	};
}

function empty(overrides: Partial<EmptyProps> = {}): EmptyProps {
	return {
		mode: "empty",
		courseTitle: "机器学习基础",
		onFillDraft: vi.fn(),
		...overrides,
	};
}

afterEach(cleanup);

describe("LearnStartPanel — welcome", () => {
	it("fills the draft from a quick start without selecting or sending anything", () => {
		const props = welcome();
		render(<LearnStartPanel {...props} />);

		expect(screen.getByRole("heading", { name: "你想在「机器学习基础」中学习什么？" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /讲解知识点/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /开始练习/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /复习薄弱点/ })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /讲解知识点/ }));
		expect(props.onFillDraft).toHaveBeenCalledTimes(1);
		expect(String(vi.mocked(props.onFillDraft).mock.calls[0]![0])).toContain("机器学习基础");
		expect(String(vi.mocked(props.onFillDraft).mock.calls[0]![0])).toContain("请讲解");
		expect(props.onSelectCourse).not.toHaveBeenCalled();
	});

	it("hides quick starts for a paused course and offers the existing switch action", () => {
		const props = welcome({ course: course({ status: "paused" }) });
		render(<LearnStartPanel {...props} />);

		expect(screen.getByText("已暂停")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /讲解知识点/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /切换课程/ }));
		expect(props.onSwitchCourse).toHaveBeenCalledTimes(1);
	});

	it("renders the course picker without a course and routes selection and creation", () => {
		const props = welcome({
			course: null,
			activeCourses: [course(), course({ course_id: "c2", title: "英语学术写作" })],
		});
		render(<LearnStartPanel {...props} />);

		expect(screen.getByRole("heading", { name: "你想学习什么？" })).toBeTruthy();
		expect(screen.getByText("先选择一门课程，再开始本次 AI 学习。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "选择课程：英语学术写作" }));
		expect(props.onSelectCourse).toHaveBeenCalledWith("c2");
		fireEvent.click(screen.getByRole("button", { name: /创建课程/ }));
		expect(props.onCreateCourse).toHaveBeenCalledTimes(1);
	});

	it("keeps the loading and failure states distinct from an empty list", async () => {
		const error: CourseErrorRef = {
			messageKey: "courses.unavailable",
			message: "课程服务不可用",
			code: "unavailable",
		};
		const failing = welcome({ course: null, coursesError: error, activeCourses: [] });
		const view = render(<LearnStartPanel {...failing} />);
		expect(screen.getByRole("alert")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(failing.onRetryCourses).toHaveBeenCalledTimes(1);

		view.unmount();
		render(<LearnStartPanel {...welcome({ course: null, coursesLoading: true, activeCourses: [] })} />);
		expect(screen.getByText("正在加载课程…")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /创建课程/ })).toBeNull();
	});

	it("T01 keeps the archived empty copy and the create entry while a refresh runs", () => {
		const props = welcome({
			course: null,
			coursesLoading: true,
			activeCourses: [],
			archivedCourses: [
				course({ course_id: "c_old_1", title: "旧课一", status: "archived" }),
				course({ course_id: "c_old_2", title: "旧课二", status: "archived" }),
			],
			archiveEntryCount: 2,
		});
		render(<LearnStartPanel {...props} />);

		// Archived courses are still course records: a refresh must not look like
		// the very first load and hide the empty copy or the create entry.
		expect(screen.queryByText("正在加载课程…")).toBeNull();
		expect(screen.getByText("课程都在归档中，可以先创建新课程，或到归档中心恢复原有课程。")).toBeTruthy();
		expect(screen.getByRole("button", { name: /创建课程/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /查看归档/ })).toBeTruthy();
	});

	it("T02 shows the first-load spinner and no empty state when there are no records", () => {
		const props = welcome({
			course: null,
			coursesLoading: true,
			activeCourses: [],
			archivedCourses: [],
			archiveEntryCount: 0,
		});
		render(<LearnStartPanel {...props} />);

		expect(screen.getByText("正在加载课程…")).toBeTruthy();
		expect(screen.queryByText("还没有课程，先创建第一门课程再开始学习。")).toBeNull();
		expect(screen.queryByRole("button", { name: /创建课程/ })).toBeNull();
	});

	it("T03 keeps existing course cards usable during a background refresh", () => {
		const props = welcome({
			course: null,
			coursesLoading: true,
			activeCourses: [course()],
			archivedCourses: [],
		});
		render(<LearnStartPanel {...props} />);

		expect(screen.queryByText("正在加载课程…")).toBeNull();
		const card = screen.getByRole("button", { name: "选择课程：机器学习基础" }) as HTMLButtonElement;
		expect(card.disabled).toBe(false);
		fireEvent.click(card);
		expect(props.onSelectCourse).toHaveBeenCalledWith("c1");
	});

	it("expands the previous conversations through the page callback", () => {
		const props = welcome({ courseConversations: [session("s1"), session("s2")] });
		const view = render(<LearnStartPanel {...props} />);

		fireEvent.click(screen.getByRole("button", { name: /继续之前的对话 · 2/ }));
		expect(props.onToggleHistory).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("row-s1")).toBeNull();

		view.rerender(<LearnStartPanel {...props} showHistory />);
		expect(screen.getByTestId("row-s1")).toBeTruthy();
		expect(screen.getByTestId("row-s2")).toBeTruthy();
	});

	it("keeps unclassified history and the archive entry as separate controls", () => {
		const props = welcome({
			unclassifiedSessions: [session("legacy", { course: null, name: "未归类对话" })],
			archiveEntryCount: 2,
		});
		const view = render(<LearnStartPanel {...props} />);

		fireEvent.click(screen.getByRole("button", { name: /未归类历史 1/ }));
		expect(props.onToggleUnclassified).toHaveBeenCalledTimes(1);
		view.rerender(<LearnStartPanel {...props} showUnclassified />);
		expect(screen.getByTestId("row-legacy")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /查看归档/ }));
		expect(props.onOpenArchive).toHaveBeenCalledTimes(1);
	});
});

describe("LearnStartPanel — empty conversation", () => {
	it("renders the three starters and only fills the draft", () => {
		const props = empty();
		render(<LearnStartPanel {...props} />);

		expect(screen.getByText("在「机器学习基础」中开始第一段学习")).toBeTruthy();
		expect(screen.getByRole("group", { name: "快捷提问" })).toBeTruthy();
		expect(screen.getAllByRole("button")).toHaveLength(3);

		fireEvent.click(screen.getByRole("button", { name: "从一个例子讲起" }));
		expect(props.onFillDraft).toHaveBeenCalledTimes(1);
		expect(String(vi.mocked(props.onFillDraft).mock.calls[0]![0])).toContain("机器学习基础");
	});

	it("falls back to the generic course wording when no title is available", () => {
		render(<LearnStartPanel {...empty({ courseTitle: null })} />);

		expect(screen.getByText("开始一段新的学习对话")).toBeTruthy();
		expect(screen.getByText("说出你想弄懂的内容，或从下面的问题开始。")).toBeTruthy();
	});
});

/**
 * E4.9g-P2-4 — the one-click resume card.
 *
 * It only reuses `SessionMeta.updatedAt`; the full list stays available below
 * it, and an archived or unparsable row never becomes "the recent one".
 */
describe("LearnStartPanel — recent conversation", () => {
	it("picks the newest resumable conversation and opens it through the page callback", () => {
		const older = session("older", { updatedAt: "2026-11-01T00:00:00.000Z" });
		const newer = session("newer", { updatedAt: "2026-11-05T00:00:00.000Z" });
		const props = welcome({
			courseConversations: [older, newer],
			sessions: [older, newer],
		});
		renderWithTooltipProvider(<LearnStartPanel {...props} />);

		const card = screen.getByRole("button", { name: /继续「newer」/ });
		fireEvent.click(card);
		expect(props.onResumeRecent).toHaveBeenCalledWith(newer);
	});

	it("skips archived conversations and keeps a stable pick on equal timestamps", () => {
		const archived = session("archived", { updatedAt: "2026-11-09T00:00:00.000Z", archived: true });
		const first = session("first", { updatedAt: "2026-11-03T00:00:00.000Z" });
		const second = session("second", { updatedAt: "2026-11-03T00:00:00.000Z" });

		renderWithTooltipProvider(
			<LearnStartPanel {...welcome({ courseConversations: [archived, first, second], sessions: [archived, first, second] })} />,
		);

		// Equal timestamps: the earlier row wins, so the card does not jump around.
		expect(screen.getByRole("button", { name: /继续「first」/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /继续「archived」/ })).toBeNull();
	});

	it("shows no resume card without history, and still lists every row when there is one", () => {
		renderWithTooltipProvider(<LearnStartPanel {...welcome({ courseConversations: [], sessions: [] })} />);
		expect(screen.queryByRole("button", { name: /继续「/ })).toBeNull();

		cleanup();
		const rows = Array.from({ length: 5 }, (_, index) => session(`s${index + 1}`));
		renderWithTooltipProvider(
			<LearnStartPanel {...welcome({ courseConversations: rows, sessions: rows, showHistory: true })} />,
		);
		for (const item of rows) expect(screen.getByTestId(`row-${item.id}`)).toBeTruthy();
	});

	it("does not fabricate a task or stage in the empty-conversation starters", () => {
		renderWithTooltipProvider(
			<LearnStartPanel mode="empty" courseTitle="Python 编程" onFillDraft={vi.fn()} />,
		);

		expect(screen.getByText(/在「Python 编程」中开始第一段学习/)).toBeTruthy();
		expect(screen.queryByText(/当前任务|阶段：/)).toBeNull();
	});
});
