import { useEffect, useMemo } from "react";
import { AlertTriangle, ClipboardList, Loader2, MessageSquare } from "lucide-react";
import { Button } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore, taskStatusLabel, type LearningTask } from "../../stores/courses-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { navigate } from "../shell/navigation.js";
import type { CourseSessionBinding } from "../../api/courses.js";

/**
 * 学习记录 (E4.5c).
 *
 * Read-only. It shows the tasks the server reports and the conversations the
 * server bound to this course, plus — verbatim — any legacy
 * `duplicate_task_bindings` note. Nothing here deletes a session or a B2
 * record; the note explains what the server chose not to repair.
 */

const ORIGIN_LABEL: Record<CourseSessionBinding["origin"], string> = {
	task: "任务学习",
	free_question: "自由提问",
	manual: "手动关联",
};

function formatTime(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleString("zh-CN", {
		month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
	});
}

function statusTone(status: LearningTask["status"]): string {
	switch (status) {
		case "completed": return "mla-badge mla-badge--success";
		case "in_progress": return "mla-badge mla-badge--accent";
		default: return "mla-badge";
	}
}

export function CourseRecordsPanel({ courseId }: { courseId: string }) {
	const state = useStoreSnapshot(coursesStore, () => ({
		detail: coursesStore.detail,
		detailLoading: coursesStore.detailLoading,
		detailError: coursesStore.detailError,
		courseSessions: coursesStore.courseSessions,
		courseSessionsLoading: coursesStore.courseSessionsLoading,
		courseSessionsError: coursesStore.courseSessionsError,
		plans: coursesStore.plans,
		pendingAction: coursesStore.pendingAction,
	}));

	useEffect(() => {
		void coursesStore.loadCourseSessions(courseId);
		void coursesStore.loadDetail(courseId);
	}, [courseId]);

	const tasks = state.detail?.tasks ?? [];
	const stages = state.detail?.stages ?? [];
	const tasksByStage = useMemo(() => {
		const map = new Map<string | null, LearningTask[]>();
		for (const task of tasks) {
			const key = task.stage_id;
			const bucket = map.get(key);
			if (bucket) bucket.push(task);
			else map.set(key, [task]);
		}
		return map;
	}, [tasks]);

	const planTitle = (planId: string | null): string => {
		if (!planId) return "未归属计划";
		return state.plans.find((plan) => plan.plan_id === planId)?.title ?? planId;
	};
	const taskTitle = (taskId: string | null): string => {
		if (!taskId) return "自由学习";
		return tasks.find((task) => task.task_id === taskId)?.title ?? taskId;
	};

	const openSession = async (sessionId: string) => {
		navigate("learn", { history: "push", session: sessionId });
		await sessionsStore.openSession(sessionId, { historyMode: "none" });
	};

	const completed = tasks.filter((task) => task.status === "completed").length;

	return (
		<div className="mla-stack-lg">
			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>学习任务</h2>
						<span className="mla-small mla-muted">
							{tasks.length > 0 ? `已完成 ${completed} / ${tasks.length}` : "还没有任务"}
						</span>
					</div>
				</div>
				{state.detailLoading && tasks.length === 0 ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取学习任务…
					</p>
				) : state.detailError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.detailError}</p>
				) : tasks.length === 0 ? (
					<div className="mla-empty">
						<ClipboardList size={26} aria-hidden="true" />
						<strong>还没有学习任务</strong>
						<p className="mla-small" style={{ margin: 0 }}>在「学习计划」里创建并确认计划后，任务会出现在这里。</p>
					</div>
				) : (
					<div className="mla-stack" style={{ gap: 18 }}>
						{stages.map((stage) => {
							const stageTasks = tasksByStage.get(stage.stage_id) ?? [];
							if (stageTasks.length === 0) return null;
							return (
								<div key={stage.stage_id}>
									<div className="mla-inline">
										<h3 className="mla-plan-stage-title">{stage.title}</h3>
										<span className="mla-badge">{planTitle(stage.plan_id)}</span>
									</div>
									<div className="mla-state-list" style={{ marginTop: 4 }}>
										{stageTasks.map((task) => (
											<TaskRow key={task.task_id} task={task} />
										))}
									</div>
								</div>
							);
						})}
						{(tasksByStage.get(null) ?? []).length > 0 ? (
							<div>
								<h3 className="mla-plan-stage-title">未分阶段任务</h3>
								<div className="mla-state-list" style={{ marginTop: 4 }}>
									{(tasksByStage.get(null) ?? []).map((task) => (
										<TaskRow key={task.task_id} task={task} />
									))}
								</div>
							</div>
						) : null}
					</div>
				)}
			</section>

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>关联的 AI 学习会话</h2>
					<span className="mla-small mla-muted">
						{state.courseSessions?.sessions.length ?? 0} 个会话
					</span>
				</div>
				{state.courseSessions?.duplicate_task_bindings?.length ? (
					<div className="mla-stack" style={{ gap: 8 }}>
						{state.courseSessions.duplicate_task_bindings.map((entry) => (
							<p key={entry.task_id} className="mla-notice mla-notice--conflict">
								<AlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
								{entry.note}
								（任务：{taskTitle(entry.task_id)}；会话：{entry.session_ids.join("、")}）
							</p>
						))}
					</div>
				) : null}
				{state.courseSessionsLoading && !state.courseSessions ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取学习会话…
					</p>
				) : state.courseSessionsError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.courseSessionsError}</p>
				) : (state.courseSessions?.sessions.length ?? 0) === 0 ? (
					<div className="mla-empty">
						<MessageSquare size={26} aria-hidden="true" />
						<strong>还没有关联的学习会话</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							从今日学习或任务列表开始学习后，对应的 AI 会话会自动关联到这门课程。
						</p>
					</div>
				) : (
					<div className="mla-state-list">
						{state.courseSessions!.sessions.map((binding) => (
							<div className="mla-state-row" key={binding.binding_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{taskTitle(binding.task_id)}</strong>
										<span className="mla-badge">{ORIGIN_LABEL[binding.origin]}</span>
									</div>
									<p>{formatTime(binding.created_at)} · 会话 {binding.session_id}</p>
								</div>
								<Button onClick={() => void openSession(binding.session_id)}>打开会话</Button>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

/**
 * Read-only task row.
 *
 * There is deliberately no "标记完成" button: E4.4a defines `learning/start`
 * as the only entry into a task and says nothing there may complete it, and the
 * completion path is the evidence chain, not a UI toggle. Showing the state
 * without offering to fake it keeps the record honest.
 */
function TaskRow({ task }: { task: LearningTask }) {
	return (
		<div className="mla-state-row">
			<div style={{ minWidth: 0 }}>
				<div className="mla-inline" style={{ flexWrap: "wrap" }}>
					<strong style={{ overflowWrap: "anywhere" }}>{task.title}</strong>
					<span className={statusTone(task.status)}>{taskStatusLabel(task.status)}</span>
					<span className="mla-badge">{task.estimated_minutes ?? 25} 分钟</span>
				</div>
				{task.source_refs?.length ? (
					<p>
						引用：{task.source_refs.map((ref) => ref.heading_path || ref.page_path).join("；")}
					</p>
				) : null}
			</div>
			{task.status === "completed" ? (
				<span className="mla-small mla-muted">{formatTime(task.completed_at)}</span>
			) : (
				<span className="mla-small mla-muted">在 AI 学习中推进</span>
			)}
		</div>
	);
}
