import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, ClipboardList, Loader2, MessageSquare } from "lucide-react";
import { Button } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore, type LearningTask } from "../../stores/courses-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { navigate } from "../shell/navigation.js";
import type { CourseSessionBinding } from "../../api/courses.js";

/**
 * 学习记录 (E4.5c, E4.6-R1).
 *
 * Read-only. A record means work that actually happened, so this panel shows
 * only tasks that were started (real progress) or that already own a bound
 * session, plus the conversations the server bound to this course and — verbatim
 * — any legacy `duplicate_task_bindings` note.
 *
 * Why not every task: `GET /api/courses/:id` returns the full task list because
 * the draft editor needs it, so filtering it server-side would break editing.
 * But an unstarted task — including every task of a plan that is still a
 * `draft` or was confirmed but never opened — is 学习计划, not 学习记录. Showing
 * it here made an AI draft look like the learner had already studied. Nothing
 * is deleted: as soon as a task is started it appears, and its history stays
 * after the plan is archived.
 */

const ORIGIN_LABEL_KEY: Record<CourseSessionBinding["origin"], string> = {
	task: "course.origin.task",
	free_question: "course.origin.free_question",
	manual: "course.origin.manual",
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
	const { t } = useTranslation();
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

	// A task is a learning record only once it has actually been started:
	// it has real progress, or a session is bound to it. Everything else is
	// still a plan (unstarted draft/active tasks), not history.
	const allTasks = state.detail?.tasks ?? [];
	const sessions = state.courseSessions?.sessions ?? [];
	const startedTaskIds = useMemo(
		() => new Set(sessions.map((binding) => binding.task_id).filter((taskId): taskId is string => Boolean(taskId))),
		[sessions],
	);
	const tasks = useMemo(
		() => allTasks.filter((task) => task.status !== "pending" || startedTaskIds.has(task.task_id)),
		[allTasks, startedTaskIds],
	);
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

	// The course snapshot already carries its plans, and the records page reads it
	// on mount. `state.plans` comes from the separate list endpoint, which this
	// page never loads — using it here printed a raw `plan_xxx` id when the page
	// was opened directly.
	const planTitle = (planId: string | null): string => {
		if (!planId) return t("course.records.noPlan");
		const fromDetail = state.detail?.plans.find((plan) => plan.plan_id === planId)?.title;
		if (fromDetail) return fromDetail;
		return state.plans.find((plan) => plan.plan_id === planId)?.title ?? planId;
	};
	const taskTitle = (taskId: string | null): string => {
		if (!taskId) return t("course.records.freeLearning");
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
						<h2>{t("course.records.tasksTitle")}</h2>
						<span className="mla-small mla-muted">
							{tasks.length > 0
								? t("course.records.completedOf", { completed, total: tasks.length })
								: t("course.records.noTasks")}
						</span>
					</div>
				</div>
				{state.detailLoading && tasks.length === 0 ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.records.tasksLoading")}
					</p>
				) : state.detailError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.detailError}</p>
				) : tasks.length === 0 ? (
					<div className="mla-empty">
						<ClipboardList size={26} aria-hidden="true" />
						<strong>{t("course.records.emptyTitle")}</strong>
						<p className="mla-small" style={{ margin: 0 }}>
							{t("course.records.emptyHint")}
						</p>
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
								<h3 className="mla-plan-stage-title">{t("course.records.unstaged")}</h3>
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
					<h2>{t("course.records.sessionsTitle")}</h2>
					<span className="mla-small mla-muted">
						{t("course.records.sessionCount", { count: state.courseSessions?.sessions.length ?? 0 })}
					</span>
				</div>
				{state.courseSessions?.duplicate_task_bindings?.length ? (
					<div className="mla-stack" style={{ gap: 8 }}>
						{state.courseSessions.duplicate_task_bindings.map((entry) => (
							<p key={entry.task_id} className="mla-notice mla-notice--conflict">
								<AlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
								{t("course.records.duplicateBinding", {
									note: entry.note,
									task: taskTitle(entry.task_id),
									sessions: entry.session_ids.join("、"),
								})}
							</p>
						))}
					</div>
				) : null}
				{state.courseSessionsLoading && !state.courseSessions ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.records.sessionsLoading")}
					</p>
				) : state.courseSessionsError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.courseSessionsError}</p>
				) : (state.courseSessions?.sessions.length ?? 0) === 0 ? (
					<div className="mla-empty">
						<MessageSquare size={26} aria-hidden="true" />
						<strong>{t("course.records.noSessionsTitle")}</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							{t("course.records.noSessionsHint")}
						</p>
					</div>
				) : (
					<div className="mla-state-list">
						{state.courseSessions!.sessions.map((binding) => (
							<div className="mla-state-row" key={binding.binding_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{taskTitle(binding.task_id)}</strong>
										<span className="mla-badge">{t(ORIGIN_LABEL_KEY[binding.origin])}</span>
									</div>
									<p>{t("course.records.sessionLine", { time: formatTime(binding.created_at), session: binding.session_id })}</p>
								</div>
								<Button onClick={() => void openSession(binding.session_id)}>{t("course.records.openSession")}</Button>
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
	const { t } = useTranslation();
	return (
		<div className="mla-state-row">
			<div style={{ minWidth: 0 }}>
				<div className="mla-inline" style={{ flexWrap: "wrap" }}>
					<strong style={{ overflowWrap: "anywhere" }}>{task.title}</strong>
					<span className={statusTone(task.status)}>{t(`course.task.${task.status}`)}</span>
					<span className="mla-badge">{t("course.card.minutes", { count: task.estimated_minutes ?? 25 })}</span>
				</div>
				{task.source_refs?.length ? (
					<p>
						{t("course.records.citations", {
							items: task.source_refs.map((ref) => ref.heading_path || ref.page_path).join("；"),
						})}
					</p>
				) : null}
			</div>
			{task.status === "completed" ? (
				<span className="mla-small mla-muted">{formatTime(task.completed_at)}</span>
			) : (
				<span className="mla-small mla-muted">{t("course.records.advanceInLearn")}</span>
			)}
		</div>
	);
}
