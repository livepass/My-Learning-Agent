// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { settingsStore } from "../../stores/settings-store.js";

/**
 * E4.7-R1b — the archive centre.
 *
 * The settings tabs are URL state, and the two archive panels are the only
 * place archived content is listed. These tests pin the deep link, Back/Forward
 * behaviour, the reason a session is hidden, and that a course-archived session
 * cannot be restored on its own.
 */

const sessionsApi = vi.hoisted(() => ({
	listSessions: vi.fn(),
	unarchiveSession: vi.fn(),
	archiveSession: vi.fn(),
	deleteSession: vi.fn(),
}));

vi.mock("../../api/sessions.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/sessions.js")>("../../api/sessions.js");
	return { ...actual, ...sessionsApi };
});

const coursesApi = vi.hoisted(() => ({
	listCourses: vi.fn(),
	getDailyPlans: vi.fn(),
	restoreCourse: vi.fn(),
	resumeCourse: vi.fn(),
	deleteCourse: vi.fn(),
	getCourseDeletionPreview: vi.fn(),
}));

vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...coursesApi };
});

const sessions = [
	{
		id: "s_manual.jsonl",
		name: "手动归档会话",
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-02T00:00:00.000Z",
		messageCount: 3,
		preview: "关于闭包的讨论",
		channels: ["web"],
		archived: true,
		course: { course_id: "course_python", title: "Python 编程", archived: false },
		daily_visible: false,
	},
	{
		id: "s_course.jsonl",
		name: "随课程归档会话",
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-03T00:00:00.000Z",
		messageCount: 5,
		preview: "导数练习",
		channels: ["web"],
		archived: false,
		course: { course_id: "course_math", title: "高等数学", archived: true },
		daily_visible: false,
	},
	{
		id: "s_daily.jsonl",
		name: "日常会话",
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-04T00:00:00.000Z",
		messageCount: 1,
		preview: "继续",
		channels: ["web"],
		archived: false,
		course: null,
		daily_visible: true,
	},
];

const course = (id: string, title: string, status: string) => ({
	course_id: id,
	title,
	description: "",
	status,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-05T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 3, sessions: 2, sources: 1 },
});

beforeEach(() => {
	vi.clearAllMocks();
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		show: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
	});
	sessionsStore.sessions = [];
	sessionsStore.currentSessionId = null;
	coursesStore.reset();
	vi.spyOn(settingsStore, "load").mockResolvedValue(undefined);
	sessionsApi.listSessions.mockResolvedValue(sessions);
	sessionsApi.unarchiveSession.mockResolvedValue({ id: "s_manual.jsonl", archived: false });
	sessionsApi.deleteSession.mockResolvedValue({ newActiveId: null });
	coursesApi.listCourses.mockResolvedValue([
		course("course_python", "Python 编程", "in_progress"),
		course("course_math", "高等数学", "archived"),
	]);
	coursesApi.restoreCourse.mockResolvedValue(course("course_math", "高等数学", "paused"));
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("settings archive centre", () => {
	it("opens the archived-sessions tab from a deep link and lists only hidden sessions", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archived-sessions");
		render(<SettingsPage />);

		await waitFor(() => expect(screen.getByRole("heading", { name: "归档会话" })).toBeTruthy());
		await waitFor(() => expect(screen.getByText("手动归档会话")).toBeTruthy());
		// The daily session stays on the daily pages and out of the archive centre.
		expect(screen.queryByText("日常会话")).toBeNull();
	});

	it("keeps the required tab order and switches the URL with history", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=general");
		render(<SettingsPage />);

		const nav = screen.getByRole("navigation", { name: "系统设置内容" });
		expect(Array.from(nav.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
			"通用与外观", "模型连接", "关于", "归档会话", "归档课程",
		]);

		fireEvent.click(screen.getByRole("button", { name: "归档课程" }));
		await waitFor(() => expect(screen.getByRole("heading", { name: "归档课程" })).toBeTruthy());
		expect(window.location.search).toContain("tab=archived-courses");

		// Back/Forward: the page must follow the URL, not an internal copy.
		window.history.replaceState(null, "", "/?page=settings&tab=archived-sessions");
		window.dispatchEvent(new PopStateEvent("popstate"));
		await waitFor(() => expect(screen.getByRole("heading", { name: "归档会话" })).toBeTruthy());
	});

	it("labels why each session is hidden and blocks restoring a child of an archived course", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archived-sessions");
		render(<SettingsPage />);

		await waitFor(() => expect(screen.getByText("随课程归档")).toBeTruthy());
		expect(screen.getByText("手动归档")).toBeTruthy();
		expect(screen.getByText("1 个手动归档 · 1 个随课程归档")).toBeTruthy();

		// Rows are sorted by recently updated; find each one by its title.
		const rowOf = (name: string) => screen.getByText(name).closest(".mla-state-row") as HTMLElement;
		const manualRestore = Array.from(rowOf("手动归档会话").querySelectorAll("button"))
			.find((button) => button.textContent?.includes("恢复会话"))!;
		const courseRestore = Array.from(rowOf("随课程归档会话").querySelectorAll("button"))
			.find((button) => button.textContent?.includes("恢复会话"))!;
		expect(courseRestore.disabled).toBe(true);
		expect(manualRestore.disabled).toBe(false);

		fireEvent.click(manualRestore);
		await waitFor(() => expect(sessionsApi.unarchiveSession).toHaveBeenCalledWith("s_manual.jsonl"));
	});

	it("asks before deleting an archived conversation", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archived-sessions");
		render(<SettingsPage />);

		await waitFor(() => expect(screen.getByText("手动归档会话")).toBeTruthy());
		const row = screen.getByText("手动归档会话").closest(".mla-state-row") as HTMLElement;
		const deleteButton = Array.from(row.querySelectorAll("button"))
			.find((button) => button.textContent?.trim() === "删除")!;
		fireEvent.click(deleteButton);
		await waitFor(() => expect(screen.getByRole("dialog", { name: "删除归档会话" })).toBeTruthy());
		expect(sessionsApi.deleteSession).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
		await waitFor(() => expect(sessionsApi.deleteSession).toHaveBeenCalledWith("s_manual.jsonl"));
	});

	it("restores an archived course and says it lands on paused", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archived-courses");
		render(<SettingsPage />);

		await waitFor(() => expect(screen.getByText("高等数学")).toBeTruthy());
		// Only the archived course is listed here.
		expect(screen.queryByText("Python 编程")).toBeNull();
		expect(screen.getByText(/恢复后状态为「已暂停」/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "恢复课程" }));
		await waitFor(() => expect(coursesApi.restoreCourse).toHaveBeenCalledWith("course_math"));
	});
});

describe("settings archive centre — parent/child rules (E4.7-R1c)", () => {
	it("marks a course-archived session as read-only and explains the next step", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archived-sessions");
		render(<SettingsPage />);

		await waitFor(() => expect(screen.getByText("随课程归档")).toBeTruthy());
		const row = screen.getByText("随课程归档会话").closest(".mla-state-row") as HTMLElement;
		expect(row.textContent).toContain("只读");
		expect(row.textContent).toContain("恢复课程后才能继续学习");
	});
});

describe("settings archive centre — permanent delete (E4.7-R1 final)", () => {
	const emptyDaily = {
		as_of: "", generated_at: "", minutes_override: null, courses: [], total_planned_minutes: 0,
	};

	it("deletes an archived course without history after the shared two-step dialog", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archived-courses");
		coursesApi.getDailyPlans.mockResolvedValue(emptyDaily);
		coursesApi.getCourseDeletionPreview.mockResolvedValue({
			course_id: "course_math",
			title: "高等数学",
			deletable: true,
			blockers: [],
			counts: { plans: 1, stages: 1, tasks: 2, started_tasks: 0, sessions: 0, goals: 0, sources: 0 },
			has_material: false,
		});
		coursesApi.deleteCourse.mockResolvedValue({
			deleted: true,
			course_id: "course_math",
			removed: { plans: 1, stages: 1, tasks: 2, sessions: 0, goals: 0, sources: 0, learning_starts: 0 },
		});

		render(<SettingsPage />);
		await waitFor(() => expect(screen.getByText("高等数学")).toBeTruthy());

		const row = screen.getByText("高等数学").closest(".mla-state-row") as HTMLElement;
		const deleteButton = Array.from(row.querySelectorAll("button"))
			.find((button) => button.textContent?.trim() === "删除课程")!;
		fireEvent.click(deleteButton);

		await waitFor(() => expect(screen.getByRole("dialog", { name: "删除课程确认" })).toBeTruthy());
		// The store passes its abort signal as the second argument.
		expect(coursesApi.getCourseDeletionPreview.mock.calls[0]?.[0]).toBe("course_math");
		expect(coursesApi.deleteCourse).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "继续删除" }));
		// The list the store re-reads after a successful delete no longer has it.
		coursesApi.listCourses.mockResolvedValue([]);
		fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

		await waitFor(() => expect(coursesApi.deleteCourse).toHaveBeenCalledWith("course_math"));
		await waitFor(() => expect(screen.queryByText("高等数学")).toBeNull());
		expect(screen.getByText("没有归档课程")).toBeTruthy();
	});

	it("refuses the delete when the archived course has real history", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archived-courses");
		coursesApi.getCourseDeletionPreview.mockResolvedValue({
			course_id: "course_math",
			title: "高等数学",
			deletable: false,
			blockers: [
				{ code: "course_sessions", message: "该课程已有 1 个学习会话。", count: 1 },
				{ code: "learning_evidence", message: "该课程的学习会话已写入正式学习证据。", count: 1 },
			],
			counts: { plans: 1, stages: 1, tasks: 2, started_tasks: 1, sessions: 1, goals: 0, sources: 0 },
			has_material: false,
		});

		render(<SettingsPage />);
		await waitFor(() => expect(screen.getByText("高等数学")).toBeTruthy());

		const row = screen.getByText("高等数学").closest(".mla-state-row") as HTMLElement;
		const deleteButton = Array.from(row.querySelectorAll("button"))
			.find((button) => button.textContent?.trim() === "删除课程")!;
		fireEvent.click(deleteButton);

		await waitFor(() => expect(screen.getByRole("dialog", { name: "删除课程确认" })).toBeTruthy());
		expect(screen.getByText("该课程已有真实学习记录，不能永久删除。")).toBeTruthy();
		expect(screen.getByText("该课程已有 1 个学习会话。")).toBeTruthy();
		expect(screen.getByText("该课程的学习会话已写入正式学习证据。")).toBeTruthy();
		// No second step and no delete request: the protection is the server's.
		expect(screen.queryByRole("button", { name: "继续删除" })).toBeNull();
		expect(coursesApi.deleteCourse).not.toHaveBeenCalled();
	});
});
