// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeletionDialog } from "./DeletionDialog.js";
import { coursesStore } from "../../stores/courses-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";

/**
 * E4.7 — the deletion dialog is the only path to a permanent delete.
 *
 * These tests pin the two rules that make the feature safe from the UI side:
 * opening it never deletes, and a record with history never offers a second
 * confirmation at all.
 */

const api = vi.hoisted(() => ({
	getCourseDeletionPreview: vi.fn(),
	getPlanDeletionPreview: vi.fn(),
	deleteCourse: vi.fn(),
	deletePlan: vi.fn(),
	archivePlan: vi.fn(),
	archiveCourse: vi.fn(),
	listCourses: vi.fn(),
	getDailyPlans: vi.fn(),
}));

vi.mock("../../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/courses.js")>("../../api/courses.js");
	return { ...actual, ...api };
});

beforeEach(() => {
	vi.clearAllMocks();
	coursesStore.reset();
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		show: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
	});
	api.listCourses.mockResolvedValue([]);
	api.getDailyPlans.mockResolvedValue({ as_of: "", generated_at: "", minutes_override: null, courses: [], total_planned_minutes: 0 });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const deletableCourseReport = {
	course_id: "course_a",
	title: "Python 编程",
	deletable: true,
	blockers: [],
	counts: { plans: 1, stages: 2, tasks: 3, started_tasks: 0, sessions: 0, goals: 0, sources: 1 },
	has_material: true,
};

const blockedCourseReport = {
	...deletableCourseReport,
	course_id: "course_b",
	title: "高等数学",
	deletable: false,
	blockers: [
		{ code: "course_sessions", count: 1, message: "该课程已有 1 个学习会话，会话与学习记录必须保留，请改用归档。" },
	],
	counts: { ...deletableCourseReport.counts, sessions: 1, started_tasks: 1 },
};

describe("course deletion dialog", () => {
	it("shows what would be deleted and needs a second confirmation", async () => {
		api.getCourseDeletionPreview.mockResolvedValue(deletableCourseReport);
		api.deleteCourse.mockResolvedValue({ deleted: true, course_id: "course_a", removed: {} });
		const onDeleted = vi.fn();

		render(<DeletionDialog target={{ kind: "course", courseId: "course_a", title: "Python 编程" }} onClose={vi.fn()} onDeleted={onDeleted} />);

		// Opening is a read only.
		await waitFor(() => expect(api.getCourseDeletionPreview).toHaveBeenCalledWith("course_a", expect.anything()));
		expect(screen.getByText(/2 个阶段/)).toBeTruthy();
		expect(screen.getByText(/3 个任务/)).toBeTruthy();
		expect(screen.getByText(/关联教材 1 份/)).toBeTruthy();
		expect(api.deleteCourse).not.toHaveBeenCalled();
		// Step one cannot delete: it only advances.
		expect(screen.queryByRole("button", { name: /永久删除/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /继续删除/ }));
		expect(screen.getByText(/删除后无法恢复/)).toBeTruthy();
		expect(api.deleteCourse).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /永久删除/ }));
		await waitFor(() => expect(api.deleteCourse).toHaveBeenCalledWith("course_a"));
		await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
	});

	it("offers archiving instead of a delete when the course has history", async () => {
		api.getCourseDeletionPreview.mockResolvedValue(blockedCourseReport);
		const onArchive = vi.fn().mockResolvedValue(true);
		const onClose = vi.fn();

		render(
			<DeletionDialog
				target={{ kind: "course", courseId: "course_b", title: "高等数学" }}
				onClose={onClose}
				onArchive={onArchive}
			/>,
		);

		await waitFor(() => expect(screen.getByText(/已有真实学习记录，不能永久删除/)).toBeTruthy());
		// Every concrete reason is printed, not one generic failure.
		expect(screen.getByText(/该课程已有 1 个学习会话/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /继续删除/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /永久删除/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /归档课程/ }));
		await waitFor(() => expect(onArchive).toHaveBeenCalledOnce());
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(api.deleteCourse).not.toHaveBeenCalled();
	});

	it("expands the concrete blocking tasks and labels status-only progress as 待核实", async () => {
		api.getCourseDeletionPreview.mockResolvedValue({
			...blockedCourseReport,
			started_task_details: [
				{
					task_id: "task_a",
					task_title: "阅读装饰器教材",
					plan_id: "plan_a",
					plan_title: "Python 计划",
					stage_id: "stage_a",
					stage_title: "基础语法",
					task_status: "in_progress",
					updated_at: "2026-11-10T02:00:00.000Z",
					session_bound: true,
					session_ids: ["session_a.jsonl"],
					b2_evidence: false,
					b2_evidence_count: 0,
					evidence_state: "session_bound",
				},
				{
					task_id: "task_b",
					task_title: "写一个装饰器",
					plan_id: "plan_a",
					plan_title: "Python 计划",
					stage_id: "stage_a",
					stage_title: "基础语法",
					task_status: "completed",
					completed_at: "2026-11-11T02:00:00.000Z",
					updated_at: "2026-11-11T02:00:00.000Z",
					session_bound: false,
					session_ids: [],
					b2_evidence: false,
					b2_evidence_count: null,
					evidence_state: "task_progress_only",
				},
			],
			mastery_state_count: 2,
		});

		render(
			<DeletionDialog
				target={{ kind: "course", courseId: "course_b", title: "高等数学" }}
				onClose={vi.fn()}
				onArchive={vi.fn().mockResolvedValue(true)}
			/>,
		);

		await waitFor(() => expect(screen.getByText(/已有真实学习记录，不能永久删除/)).toBeTruthy());
		// Collapsed by default: the decision comes first.
		expect(screen.queryByText("阅读装饰器教材")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /查看涉及的具体任务（2）/ }));

		expect(screen.getByText("阅读装饰器教材")).toBeTruthy();
		expect(screen.getByText("写一个装饰器")).toBeTruthy();
		expect(screen.getByText("进行中")).toBeTruthy();
		expect(screen.getByText("已完成")).toBeTruthy();
		// A bound conversation without a formal attempt is still 待核实.
		expect(screen.getByText("已关联会话，证据待核实")).toBeTruthy();
		// A completed checkbox with no conversation is never 正式学习证据.
		expect(screen.getByText("仅有任务进度，证据待核实")).toBeTruthy();
		expect(screen.queryByText(/B2 正式证据/)).toBeNull();
		expect(screen.getByText(/关联会话 1 个/)).toBeTruthy();
		expect(screen.getByText(/没有关联学习会话/)).toBeTruthy();
		// L1 mastery is named as its own state, not folded into task evidence.
		expect(screen.getByText(/2 个本课程的知识点掌握状态/)).toBeTruthy();
		// Only the bound task offers a jump into its learning record.
		expect(screen.getAllByRole("button", { name: /查看学习记录/ })).toHaveLength(1);
	});

	it("shows the B2 evidence count when a task really has formal evidence", async () => {
		api.getCourseDeletionPreview.mockResolvedValue({
			...blockedCourseReport,
			started_task_details: [
				{
					task_id: "task_a",
					task_title: "阅读装饰器教材",
					plan_id: "plan_a",
					plan_title: "Python 计划",
					stage_id: "stage_a",
					stage_title: "基础语法",
					task_status: "completed",
					completed_at: "2026-11-10T02:00:00.000Z",
					updated_at: "2026-11-10T02:00:00.000Z",
					session_bound: true,
					session_ids: ["session_a.jsonl"],
					b2_evidence: true,
					b2_evidence_count: 2,
					evidence_state: "b2_evidence",
				},
			],
		});

		render(
			<DeletionDialog
				target={{ kind: "course", courseId: "course_b", title: "高等数学" }}
				onClose={vi.fn()}
				onArchive={vi.fn().mockResolvedValue(true)}
			/>,
		);

		await waitFor(() => expect(screen.getByText(/已有真实学习记录，不能永久删除/)).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /查看涉及的具体任务（1）/ }));
		expect(screen.getByText("B2 正式证据 2 条")).toBeTruthy();
	});

	it("reports the server's 409 without closing a plan dialog", async () => {
		api.getPlanDeletionPreview.mockResolvedValue({
			course_id: "course_a",
			plan_id: "plan_a",
			title: "草稿计划",
			status: "draft",
			deletable: true,
			blockers: [],
			counts: { stages: 1, tasks: 2, completed_tasks: 0, started_tasks: 0, sessions: 0 },
		});
		const { ApiError } = await import("../../api/client.js");
		api.deletePlan.mockRejectedValue(new ApiError(409, "conflict", {
			error: "course_conflict",
			message: "该计划已有真实学习记录，不能永久删除；请改用归档。",
			blockers: [{ code: "plan_sessions", message: "该计划的任务已绑定 1 个学习会话，只能归档。" }],
		}));
		const onClose = vi.fn();

		render(<DeletionDialog target={{ kind: "plan", courseId: "course_a", planId: "plan_a", title: "草稿计划" }} onClose={onClose} />);
		await waitFor(() => expect(api.getPlanDeletionPreview).toHaveBeenCalledWith("course_a", "plan_a", expect.anything()));
		expect(screen.getByText(/1 个阶段/)).toBeTruthy();
		expect(screen.getByText(/2 个任务/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /继续删除/ }));
		fireEvent.click(screen.getByRole("button", { name: /永久删除/ }));
		// The 409 message is shown inside the dialog, which stays open and returns
		// to the summary (re-reading the blockers) so the learner can archive.
		await waitFor(() => expect(screen.getByText(/不能永久删除/)).toBeTruthy());
		await waitFor(() => expect(api.getPlanDeletionPreview).toHaveBeenCalledTimes(2));
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe("course deletion dialog — blocking conversations (E4.7-R2a)", () => {
	it("names pending-task and course-level sessions with archive and B2 state", async () => {
		api.getCourseDeletionPreview.mockResolvedValue({
			...blockedCourseReport,
			// Neither started task list nor the counts alone can locate these.
			started_task_details: [],
			session_details: [
				{
					session_id: "session_pending.jsonl",
					origin: "task",
					created_at: "2026-11-10T00:00:00.000Z",
					task_id: "task_pending",
					task_title: "还没有开始的任务",
					task_status: "pending",
					plan_id: "plan_a",
					plan_title: "Python 计划",
					stage_title: "基础语法",
					archived: false,
					b2_evidence_count: 1,
					b2_evidence: true,
				},
				{
					session_id: "session_free.jsonl",
					origin: "manual",
					created_at: "2026-11-09T00:00:00.000Z",
					task_id: null,
					task_title: null,
					task_status: null,
					plan_id: null,
					plan_title: null,
					stage_title: null,
					archived: true,
					b2_evidence_count: 0,
					b2_evidence: false,
				},
			],
		});

		render(
			<DeletionDialog
				target={{ kind: "course", courseId: "course_b", title: "高等数学" }}
				onClose={vi.fn()}
				onArchive={vi.fn().mockResolvedValue(true)}
			/>,
		);

		await waitFor(() => expect(screen.getByText("涉及的学习会话（2）")).toBeTruthy());
		expect(screen.getByText("还没有开始的任务")).toBeTruthy();
		expect(screen.getByText("未开始")).toBeTruthy();
		expect(screen.getByText("未关联任务")).toBeTruthy();
		expect(screen.getByText("已归档")).toBeTruthy();
		expect(screen.getByText("B2 正式证据 1 条")).toBeTruthy();
		expect(screen.getByText("无 B2 正式证据")).toBeTruthy();
		expect(screen.getByText(/会话 session_pending\.jsonl/)).toBeTruthy();

		const open = vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);
		fireEvent.click(screen.getAllByRole("button", { name: "查看历史" })[0]!);
		await waitFor(() => expect(open).toHaveBeenCalledWith("session_pending.jsonl", { historyMode: "none" }));
	});
});
