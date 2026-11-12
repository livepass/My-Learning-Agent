import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { App } from "./App.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { chatStore } from "../stores/chat-store.js";
import { appStore } from "../stores/app-store.js";
import { learningStore } from "../stores/learning-store.js";
import { navigate } from "./shell/navigation.js";
import type { ShellPage } from "../stores/app-store.js";

vi.mock("./MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));

// E4.8: the workbench names a course in the URL and reads the course list, so
// the shell test supplies both instead of landing on the "no course" gate.
const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getSessionCourseContext: vi.fn(),
}));
vi.mock("../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../api/courses.js")>("../api/courses.js");
	return { ...actual, ...coursesApi };
});

const pythonCourse = {
	course_id: "course_python",
	title: "Python 编程",
	description: "",
	status: "in_progress" as const,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-01T00:00:00.000Z",
	counts: { goals: 0, plans: 0, tasks: 0, sessions: 0, sources: 0 },
};

function setPage(page: ShellPage) {
	navigate(page, { history: "replace" });
}

beforeEach(() => {
	window.history.replaceState(null, "", "/?page=learn&course=course_python&session=fixture.jsonl");
	coursesApi.listCourses.mockResolvedValue([pythonCourse]);
	coursesApi.getSessionCourseContext.mockResolvedValue({
		session_id: "fixture.jsonl", unclassified: false,
		binding: {
			binding_id: "b1", course_id: "course_python", session_id: "fixture.jsonl",
			task_id: null, origin: "free_question", created_at: "2026-11-01T00:00:00.000Z",
		},
		course: { ...pythonCourse, counts: undefined },
		task: null, source_ids: [], goal_ids: [],
	});
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(learningStore, "load").mockResolvedValue(undefined);
	sessionsStore.currentSessionId = "fixture.jsonl";
	sessionsStore.sessions = [];
	chatStore.messages = [];
	chatStore.isSending = false;
	appStore.chatDraft = "";
	appStore.activePage = "learn";
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	sessionsStore.currentSessionId = null;
	document.documentElement.removeAttribute("data-theme");
});

describe.each(["light", "dark"])("learning shell in %s", (theme) => {
	it("keeps the existing chat owner and offers no removed workbench controls", async () => {
		document.documentElement.setAttribute("data-theme", theme);
		const send = vi.spyOn(chatStore, "send").mockResolvedValue(undefined);
		render(<App />);

		expect(screen.queryByRole("button", { name: /终端|上传|权限|MCP|Office/ })).toBeNull();

		fireEvent.change(await screen.findByRole("textbox", { name: "学习问题" }), { target: { value: "解释工具调用" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() => expect(send).toHaveBeenCalledWith("解释工具调用"));
	});

	it("navigates the four learning pages from the main navigation", async () => {
		render(<App />);
		for (const label of ["今日学习", "练习与反馈", "我的学习档案", "AI 学习"]) {
			const buttons = screen.getAllByRole("button", { name: label });
			fireEvent.click(buttons[0]);
			await waitFor(() =>
				expect(screen.getAllByRole("button", { name: label })[0].getAttribute("aria-current")).toBe("page"),
			);
		}
		// The in-app navigation keeps the open conversation, so the workbench comes
		// back with its composer (a URL without one is still the course-gate case,
		// covered by LearnPage.workbench.test.tsx).
		await waitFor(() => expect(screen.getByRole("textbox", { name: "学习问题" })).toBeTruthy());
		expect(new URL(window.location.href).searchParams.get("page")).toBe("learn");
	});

	it("renders a sidebar nav and a mobile bottom nav with the same four pages", async () => {
		render(<App />);
		const primary = screen.getByRole("navigation", { name: "主导航" });
		const bottom = screen.getByRole("navigation", { name: "主导航（移动端）" });
		expect(primary.querySelectorAll("button")).toHaveLength(4);
		expect(bottom.querySelectorAll("button")).toHaveLength(4);
		// Short labels exist so 320px keeps four readable items.
		expect(bottom.textContent).toContain("今日");
		expect(bottom.textContent).not.toContain("设置");
	});

	it("keeps settings out of the navigation but reachable from the top bar", async () => {
		render(<App />);
		const primary = screen.getByRole("navigation", { name: "主导航" });
		const bottom = screen.getByRole("navigation", { name: "主导航（移动端）" });
		expect(primary.textContent).not.toContain("系统设置");
		expect(bottom.textContent).not.toContain("系统设置");

		fireEvent.click(screen.getByRole("button", { name: "设置" }));

		await waitFor(() => expect(appStore.activePage).toBe("settings"));
		expect(new URL(window.location.href).searchParams.get("page")).toBe("settings");
	});

	it("keeps the composer draft when switching pages", async () => {
		render(<App />);
		fireEvent.change(screen.getByRole("textbox", { name: "学习问题" }), { target: { value: "未发送的草稿" } });
		expect(appStore.chatDraft).toBe("未发送的草稿");

		setPage("today");
		await waitFor(() => expect(screen.getAllByText("今日学习").length).toBeGreaterThan(0));

		navigate("learn", { history: "replace", learn: { courseId: "course_python", session: null } });
		await waitFor(() => expect(screen.getByRole("textbox", { name: "学习问题" })).toHaveProperty("value", "未发送的草稿"));
	});
});

describe("learning workspace — archived course history (E4.7-R1c)", () => {
	it("shows the conversation read-only, without a composer", async () => {
		window.history.replaceState(null, "", "/?page=learn&course=course_python&session=fixture.jsonl");
		sessionsStore.sessions = [{
			id: "fixture.jsonl",
			name: "归档课程会话",
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
			messageCount: 2,
			preview: "继续学习",
			channels: ["web"],
			archived: false,
			course: { course_id: "course_python", title: "Python 编程", archived: true },
			daily_visible: false,
		}];
		render(<App />);

		await waitFor(() => expect(screen.getByText(/本次会话仅供查看/)).toBeTruthy());
		expect(screen.queryByRole("textbox", { name: "学习问题" })).toBeNull();
	});
});
