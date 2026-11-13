// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { buildGroups } from "../settings/ArchiveSettings.js";
import type { CourseStatus } from "../../api/courses.js";
import type { SessionMeta } from "../../api/sessions.js";

/**
 * E4.8e — the unified archive centre.
 *
 * Seven acceptance cases:
 * 1. one 「归档」 tab before 「关于」; the retired tab ids still land on it;
 * 2. an archived course lists every one of its conversations;
 * 3. a live course lists only its manually archived conversations;
 * 4. a child of an archived course cannot be restored on its own;
 * 5. restoring a course separates manual from course-only archiving;
 * 6. restoring the last manual conversation drops the live course group;
 * 7. deleting an archived course removes the course and its conversations, and
 *    a failure never removes them locally.
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

interface SessionFixture {
	id: string;
	name: string;
	updatedAt?: string;
	archived: boolean;
	courseId: string | null;
	courseArchived?: boolean;
	courseTitle?: string;
	dailyVisible?: boolean;
}

const session = (input: SessionFixture) => ({
	id: input.id,
	name: input.name,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: input.updatedAt ?? "2026-11-02T00:00:00.000Z",
	messageCount: 3,
	preview: "上次的问题",
	channels: ["web"],
	archived: input.archived,
	course: input.courseId
		? {
			course_id: input.courseId,
			title: input.courseTitle ?? "Python 编程",
			archived: input.courseArchived === true,
			task_id: null,
		}
		: null,
	daily_visible: input.dailyVisible ?? (!input.archived && input.courseArchived !== true),
});

const course = (id: string, title: string, status: CourseStatus) => ({
	course_id: id,
	title,
	description: "",
	status,
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-05T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 3, sessions: 2, sources: 1 },
});

const emptyDaily = {
	as_of: "", generated_at: "", minutes_override: null, courses: [], total_planned_minutes: 0,
};

/** The group card whose title is exactly this course name. */
const groupOf = (title: string): HTMLElement => {
	const node = screen.getByText(title, { selector: ".mla-archive-group-title" });
	return node.closest(".mla-archive-group") as HTMLElement;
};

const sessionRowOf = (name: string): HTMLElement =>
	screen.getByText(name, { selector: ".mla-archive-session-title" }).closest(".mla-archive-session") as HTMLElement;

const buttonIn = (root: HTMLElement, label: string): HTMLButtonElement =>
	Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes(label)) as HTMLButtonElement;

beforeEach(() => {
	vi.clearAllMocks();
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		show: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
	});
	sessionsStore.sessions = [];
	sessionsStore.currentSessionId = null;
	sessionsStore.loadError = null;
	coursesStore.reset();
	vi.spyOn(settingsStore, "load").mockResolvedValue(undefined);
	sessionsApi.listSessions.mockResolvedValue([]);
	sessionsApi.unarchiveSession.mockResolvedValue({ id: "s1", archived: false });
	sessionsApi.deleteSession.mockResolvedValue({ newActiveId: null });
	coursesApi.getDailyPlans.mockResolvedValue(emptyDaily);
	coursesApi.listCourses.mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/?page=today");
});

describe("E4.8e — settings navigation", () => {
	it("shows one 归档 tab before 关于", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=general");
		render(<SettingsPage />);

		const nav = screen.getByRole("navigation", { name: "系统设置内容" });
		expect(Array.from(nav.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
			"通用与外观", "模型连接", "归档", "关于",
		]);
		expect(screen.queryByRole("button", { name: "归档课程" })).toBeNull();
		expect(screen.queryByRole("button", { name: "归档会话" })).toBeNull();
	});

	it("sends both retired tab links to 归档 with replace, leaving no extra history entry", async () => {
		for (const legacy of ["archived-courses", "archived-sessions"]) {
			window.history.replaceState(null, "", `/?page=settings&tab=${legacy}`);
			const before = window.history.length;
			const { unmount } = render(<SettingsPage />);

			expect(await screen.findByRole("heading", { name: "归档" })).toBeTruthy();
			await waitFor(() => expect(window.location.search).toContain("tab=archive"));
			expect(window.location.search).not.toContain(legacy);
			// `replace` rewrites the current entry instead of pushing a new one.
			expect(window.history.length).toBe(before);
			unmount();
			cleanup();
		}
	});
});

describe("E4.8e — course groups", () => {
	it("lists every conversation of an archived course, including course-only ones", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学", "archived")]);
		sessionsApi.listSessions.mockResolvedValue([
			session({ id: "s1", name: "手动归档的会话", archived: true, courseId: "course_math", courseArchived: true, courseTitle: "高等数学" }),
			session({ id: "s2", name: "随课程归档的会话", archived: false, courseId: "course_math", courseArchived: true, courseTitle: "高等数学" }),
		]);

		render(<SettingsPage />);

		const group = await waitFor(() => groupOf("高等数学"));
		expect(within(group).getByText("已归档")).toBeTruthy();
		expect(within(group).getByText("2 个会话")).toBeTruthy();
		expect(within(group).getByText("手动归档的会话")).toBeTruthy();
		expect(within(group).getByText("随课程归档的会话")).toBeTruthy();
		// The reason each row is here is stated, not implied.
		expect(within(group).getByText("手动归档 · 课程已归档")).toBeTruthy();
		expect(within(group).getByText("随课程归档")).toBeTruthy();
		// Course-level actions exist only for the archived course.
		for (const label of ["课程详情", "学习记录", "恢复课程", "删除课程"]) {
			expect(buttonIn(group, label)).toBeTruthy();
		}
	});

	it("shows only manually archived conversations of a live course", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程", "in_progress")]);
		sessionsApi.listSessions.mockResolvedValue([
			session({ id: "s1", name: "手动归档的会话", archived: true, courseId: "course_python" }),
			session({ id: "s2", name: "日常会话", archived: false, courseId: "course_python" }),
		]);

		render(<SettingsPage />);

		const group = await waitFor(() => groupOf("Python 编程"));
		expect(within(group).getByText("手动归档的会话")).toBeTruthy();
		// A live conversation is not archived content.
		expect(within(group).queryByText("日常会话")).toBeNull();
		// A live course offers no course-level restore/delete and no archived badge.
		expect(within(group).queryByText("已归档")).toBeNull();
		expect(buttonIn(group, "恢复课程")).toBeUndefined();
		expect(buttonIn(group, "删除课程")).toBeUndefined();
		// Its conversation can be restored.
		expect(buttonIn(sessionRowOf("手动归档的会话"), "恢复会话").disabled).toBe(false);
	});

	it("keeps unclassified history in its own group and never guesses a course", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		sessionsApi.listSessions.mockResolvedValue([
			session({ id: "legacy", name: "旧版未归类会话", archived: true, courseId: null }),
		]);

		render(<SettingsPage />);

		expect(await screen.findByText("未归类归档会话")).toBeTruthy();
		expect(screen.getByText("旧版未归类会话")).toBeTruthy();
		expect(screen.queryByText(/已归档$/, { selector: ".mla-archive-group-title" })).toBeNull();
	});
});

describe("E4.8e — restore rules", () => {
	it("cannot restore a child of an archived course on its own", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学", "archived")]);
		sessionsApi.listSessions.mockResolvedValue([
			session({ id: "s2", name: "随课程归档的会话", archived: false, courseId: "course_math", courseArchived: true, courseTitle: "高等数学" }),
		]);

		render(<SettingsPage />);

		await waitFor(() => groupOf("高等数学"));
		const restore = buttonIn(sessionRowOf("随课程归档的会话"), "恢复会话");
		expect(restore.disabled).toBe(true);
		expect(restore.title).toContain("请先恢复所属课程");
		// The row is read-only and says why.
		expect(sessionRowOf("随课程归档的会话").textContent).toContain("只读");
		fireEvent.click(restore);
		expect(sessionsApi.unarchiveSession).not.toHaveBeenCalled();
	});

	it("separates manual from course-only archiving after restoring the course", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		const archivedCourse = course("course_math", "高等数学", "archived");
		coursesApi.listCourses.mockResolvedValue([archivedCourse]);
		const manual = session({ id: "s1", name: "手动归档的会话", archived: true, courseId: "course_math", courseArchived: true, courseTitle: "高等数学" });
		const byCourse = session({ id: "s2", name: "随课程归档的会话", archived: false, courseId: "course_math", courseArchived: true, courseTitle: "高等数学" });
		sessionsApi.listSessions.mockResolvedValue([manual, byCourse]);
		coursesApi.restoreCourse.mockResolvedValue(course("course_math", "高等数学", "paused"));

		render(<SettingsPage />);
		await waitFor(() => groupOf("高等数学"));

		// After the restore the server derives new visibility: the course is live,
		// the course-only conversation is visible again, the manual one stays.
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学", "paused")]);
		sessionsApi.listSessions.mockResolvedValue([
			{ ...manual, course: { ...manual.course!, archived: false }, daily_visible: false },
			{ ...byCourse, course: { ...byCourse.course!, archived: false }, daily_visible: true },
		]);

		fireEvent.click(buttonIn(groupOf("高等数学"), "恢复课程"));

		await waitFor(() => expect(coursesApi.restoreCourse).toHaveBeenCalledWith("course_math"));
		// The session list is re-read: without it the old course-archived split
		// would survive until a reload.
		await waitFor(() => expect(sessionsApi.listSessions.mock.calls.length).toBeGreaterThan(1));

		const group = await waitFor(() => groupOf("高等数学"));
		expect(within(group).getByText("手动归档的会话")).toBeTruthy();
		// The course-only conversation left the archive centre with the course.
		expect(within(group).queryByText("随课程归档的会话")).toBeNull();
		// And the course is no longer presented as archived.
		expect(within(group).queryByText("已归档")).toBeNull();
		expect(buttonIn(group, "恢复课程")).toBeUndefined();
	});

	it("drops a live course group once its last manual conversation is restored", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		coursesApi.listCourses.mockResolvedValue([course("course_python", "Python 编程", "in_progress")]);
		const only = session({ id: "s1", name: "唯一手动归档会话", archived: true, courseId: "course_python" });
		sessionsApi.listSessions.mockResolvedValue([only]);

		render(<SettingsPage />);
		await waitFor(() => groupOf("Python 编程"));

		// The server now reports the conversation as visible again.
		sessionsApi.listSessions.mockResolvedValue([
			{ ...only, archived: false, daily_visible: true },
		]);
		fireEvent.click(buttonIn(sessionRowOf("唯一手动归档会话"), "恢复会话"));

		await waitFor(() => expect(sessionsApi.unarchiveSession).toHaveBeenCalledWith("s1"));
		await waitFor(() => expect(screen.queryByText("Python 编程")).toBeNull());
		expect(screen.getByText("暂无归档内容")).toBeTruthy();
	});
});

describe("E4.8e — delete", () => {
	it("removes an archived course and its conversations after the shared confirmation", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学", "archived")]);
		sessionsApi.listSessions.mockResolvedValue([
			session({ id: "s2", name: "随课程归档的会话", archived: false, courseId: "course_math", courseArchived: true, courseTitle: "高等数学" }),
		]);
		coursesApi.getCourseDeletionPreview.mockResolvedValue({
			course_id: "course_math",
			title: "高等数学",
			archived: true,
			deletable: true,
			blockers: [],
			counts: { plans: 1, stages: 1, tasks: 2, started_tasks: 1, sessions: 1, goals: 0, sources: 0 },
			has_material: false,
			b2_evidence_sessions: 0,
			b2_evidence_attempts: 0,
			mastery_state_count: 0,
		});
		coursesApi.deleteCourse.mockResolvedValue({ deleted: true, course_id: "course_math", removed: {} });

		render(<SettingsPage />);
		await waitFor(() => groupOf("高等数学"));

		fireEvent.click(buttonIn(groupOf("高等数学"), "删除课程"));
		await waitFor(() => expect(screen.getByRole("dialog", { name: "删除课程确认" })).toBeTruthy());
		expect(coursesApi.deleteCourse).not.toHaveBeenCalled();

		// The delete cascades on the server; both lists are re-read afterwards.
		coursesApi.listCourses.mockResolvedValue([]);
		sessionsApi.listSessions.mockResolvedValue([]);
		fireEvent.click(screen.getByRole("button", { name: "继续删除" }));
		fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

		await waitFor(() => expect(coursesApi.deleteCourse).toHaveBeenCalledWith("course_math"));
		await waitFor(() => expect(screen.queryByText("高等数学")).toBeNull());
		expect(screen.queryByText("随课程归档的会话")).toBeNull();
		expect(screen.getByText("暂无归档内容")).toBeTruthy();
	});

	it("keeps the course and its conversations when the delete fails", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		coursesApi.listCourses.mockResolvedValue([course("course_math", "高等数学", "archived")]);
		sessionsApi.listSessions.mockResolvedValue([
			session({ id: "s2", name: "随课程归档的会话", archived: false, courseId: "course_math", courseArchived: true, courseTitle: "高等数学" }),
		]);
		coursesApi.getCourseDeletionPreview.mockResolvedValue({
			course_id: "course_math",
			title: "高等数学",
			archived: true,
			deletable: true,
			blockers: [],
			counts: { plans: 0, stages: 0, tasks: 0, started_tasks: 0, sessions: 1, goals: 0, sources: 0 },
			has_material: false,
		});
		coursesApi.deleteCourse.mockRejectedValue(new Error("网络错误"));

		render(<SettingsPage />);
		await waitFor(() => groupOf("高等数学"));

		fireEvent.click(buttonIn(groupOf("高等数学"), "删除课程"));
		await waitFor(() => expect(screen.getByRole("dialog", { name: "删除课程确认" })).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "继续删除" }));
		fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

		await waitFor(() => expect(coursesApi.deleteCourse).toHaveBeenCalled());
		// Nothing is removed locally before the server confirms.
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText("高等数学", { selector: ".mla-archive-group-title" })).toBeTruthy();
		expect(screen.getByText("随课程归档的会话")).toBeTruthy();
	});
});

describe("E4.8e — grouping and empty states", () => {
	it("groups by real course id, not by title", () => {
		const groups = buildGroups(
			[course("course_a", "同名课程", "archived"), course("course_b", "同名课程", "in_progress")],
			[
				session({ id: "s1", name: "A 的会话", archived: false, courseId: "course_a", courseArchived: true, courseTitle: "同名课程" }),
				session({ id: "s2", name: "B 的会话", archived: true, courseId: "course_b", courseTitle: "同名课程" }),
			] as SessionMeta[],
		);
		expect(groups).toHaveLength(2);
		const ids = groups.map((group) => (group.kind === "course" ? group.courseId : "unclassified"));
		expect(ids).toEqual(["course_a", "course_b"]);
	});

	it("does not list a course with nothing archived, and never shows the empty state on a failed read", async () => {
		window.history.replaceState(null, "", "/?page=settings&tab=archive");
		coursesApi.listCourses.mockResolvedValue([
			course("course_python", "Python 编程", "in_progress"),
			course("course_math", "高等数学", "archived"),
		]);
		sessionsApi.listSessions.mockResolvedValue([
			session({ id: "s2", name: "日常会话", archived: false, courseId: "course_python" }),
		]);

		render(<SettingsPage />);

		// A live course with no archived conversation is absent.
		await waitFor(() => groupOf("高等数学"));
		expect(screen.queryByText("Python 编程")).toBeNull();
		// An archived course without conversations still appears.
		expect(groupOf("高等数学")).toBeTruthy();

		cleanup();
		sessionsApi.listSessions.mockRejectedValue(new Error("network down"));
		render(<SettingsPage />);
		expect(await screen.findByText(/归档内容读取失败/)).toBeTruthy();
		expect(screen.queryByText("暂无归档内容")).toBeNull();
	});
});
