import { BookOpen, Loader2, Play, Sparkles } from "lucide-react";
import { Button } from "../ui/index.js";
import type { CourseDailyPlan, CourseSummary, DailyPlanItem } from "../../api/courses.js";
import { courseStatusLabel } from "../../stores/courses-store.js";

/**
 * One course card on the today page (E4.5b).
 *
 * Every fact shown here comes from the server: the course row from
 * `GET /api/courses`, the task, its minutes and the progress percentage from
 * `GET /api/courses/daily`. The card never picks a task by itself — it renders
 * the recommendation the daily plan already made (`in_progress` first, else
 * `next_task`), so the card and the cross-course list cannot disagree.
 */
export function CourseCard({
	course,
	daily,
	busy,
	onStart,
	onOpen,
}: {
	course: CourseSummary;
	daily: CourseDailyPlan | undefined;
	busy: boolean;
	onStart: (taskId: string | null) => void;
	onOpen: () => void;
}) {
	const taskItem = pickCurrentTask(daily);
	const progress = daily?.task_progress;
	const archived = course.status === "archived";
	const paused = course.status === "paused";

	return (
		<article className="mla-course-card" aria-label={`课程：${course.title}`}>
			<div className="mla-course-card-head">
				<h3>{course.title}</h3>
				<span className={`mla-badge${course.status === "in_progress" ? " mla-badge--accent" : ""}`}>
					{courseStatusLabel(course.status)}
				</span>
			</div>

			{taskItem ? (
				<div className="mla-course-task">
					<span className="mla-small mla-muted">
						{taskItem.reason_code === "in_progress" ? "继续当前任务" : "下一项任务"}
					</span>
					<strong>{taskItem.title}</strong>
					<span className="mla-small mla-muted">
						{taskItem.estimated_minutes} 分钟
						{taskItem.stage_title ? ` · ${taskItem.stage_title}` : ""}
						{taskItem.status === "in_progress" ? " · 进行中" : ""}
					</span>
				</div>
			) : (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{dailyStatusText(daily)}
				</p>
			)}

			{progress && progress.total > 0 ? (
				<div>
					<div className="mla-inline" style={{ justifyContent: "space-between" }}>
						<span className="mla-small mla-muted">任务进度</span>
						<span className="mla-small mla-muted">
							{progress.completed}/{progress.total} · {progress.percent}%
						</span>
					</div>
					<div className="mla-progress" aria-hidden="true" style={{ marginTop: 6 }}>
						<span style={{ width: `${progress.percent}%` }} />
					</div>
				</div>
			) : null}

			<div className="mla-course-card-actions">
				{taskItem ? (
					<Button variant="primary" disabled={busy || archived || paused} onClick={() => onStart(taskItem.task_id)}>
						{busy ? <Loader2 size={14} className="mla-spin" /> : <Play size={14} />}
						{taskItem.reason_code === "in_progress" ? "继续学习" : "开始学习"}
					</Button>
				) : daily?.status === "no_active_plan" ? (
					<Button variant="primary" disabled={archived} onClick={onOpen}>
						<Sparkles size={14} />
						去制定计划
					</Button>
				) : null}
				<Button onClick={onOpen}>
					<BookOpen size={14} />
					查看课程
				</Button>
			</div>
		</article>
	);
}

/** The daily plan's own pick: an in-progress task wins, else the next one. */
export function pickCurrentTask(daily: CourseDailyPlan | undefined): Extract<DailyPlanItem, { kind: "task" }> | undefined {
	if (!daily) return undefined;
	const tasks = daily.items.filter((item): item is Extract<DailyPlanItem, { kind: "task" }> => item.kind === "task");
	return tasks.find((item) => item.reason_code === "in_progress") ?? tasks[0];
}

function dailyStatusText(daily: CourseDailyPlan | undefined): string {
	if (!daily) return "暂无今日安排。打开课程查看学习计划。";
	switch (daily.status) {
		case "no_active_plan": return "还没有启用中的学习计划。";
		case "empty_plan": return "当前计划还没有任务。";
		case "all_completed": return "当前计划的全部任务都已完成。";
		default: return "今天没有需要继续的任务。";
	}
}

