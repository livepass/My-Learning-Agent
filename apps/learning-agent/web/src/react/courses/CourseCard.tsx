import { useTranslation } from "react-i18next";
import { BookOpen, Loader2, Play } from "lucide-react";
import { Button, Card } from "../ui/index.js";
import type { CourseDailyPlan, CourseSummary, DailyPlanItem } from "../../api/courses.js";
import { TaskCover, coverClass } from "./CourseCover.js";

/**
 * One course's current task on the today page (direction B).
 *
 * Every fact comes from the server: the task, its minutes and the progress
 * percentage from `GET /api/courses/daily`. The card never picks a task by
 * itself — the page passes the item the daily plan already chose, so the hero
 * and the cards cannot disagree.
 *
 * The old card's destructive menu is gone: archive / delete live on the course
 * detail page, and the today page keeps a single, non-destructive surface.
 */
export function CourseCard({
	course,
	daily,
	task,
	busy,
	disabled = false,
	onStart,
	onOpen,
}: {
	course: CourseSummary;
	daily: CourseDailyPlan | undefined;
	task: Extract<DailyPlanItem, { kind: "task" }>;
	busy: boolean;
	disabled?: boolean;
	onStart: () => void;
	onOpen: () => void;
}) {
	const { t } = useTranslation();
	const progress = daily?.task_progress;
	const continuing = task.status === "in_progress" || task.reason_code === "in_progress";
	const stage = task.stage_title ?? daily?.plan?.title;

	return (
		<Card
			as="article"
			className={`mla-today-task-card ${coverClass(course)}`}
			aria-label={t("course.card.ariaLabel", { title: course.title })}
		>
			<TaskCover course={course} stage={stage} minutes={task.estimated_minutes} />

			<div className="mla-today-task-body">
				<span className="mla-today-course-tag">
					<i aria-hidden="true" />
					{course.title}
				</span>
				<h3 className="mla-today-task-title">{task.title}</h3>
				<p className="mla-today-task-sub">
					{stage ? `${stage} · ` : ""}
					{t("course.card.minutes", { count: task.estimated_minutes })}
				</p>

				{progress && progress.total > 0 ? (
					<div className="mla-today-progress">
						<span className="mla-today-track" aria-hidden="true">
							<span style={{ width: `${progress.percent}%` }} />
						</span>
						<span className="mla-today-sr">{t("course.card.taskProgress")}</span>
						<span className="mla-today-progress-text">
							{progress.completed}/{progress.total} · {progress.percent}%
						</span>
					</div>
				) : null}

				<div className="mla-today-task-actions">
					<Button variant="primary" size="xs" disabled={busy || disabled} onClick={onStart}>
						{busy ? <Loader2 size={14} className="mla-spin" /> : <Play size={14} />}
						{continuing ? t("course.card.continueLearning") : t("course.card.startLearning")}
					</Button>
					<Button size="xs" onClick={onOpen}>
						<BookOpen size={14} />
						{t("course.card.view")}
					</Button>
				</div>
			</div>
		</Card>
	);
}

/** The daily plan's own pick: an in-progress task wins, else the next one. */
export function pickCurrentTask(daily: CourseDailyPlan | undefined): Extract<DailyPlanItem, { kind: "task" }> | undefined {
	if (!daily) return undefined;
	const tasks = daily.items.filter((item): item is Extract<DailyPlanItem, { kind: "task" }> => item.kind === "task");
	return tasks.find((item) => item.reason_code === "in_progress" || item.status === "in_progress") ?? tasks[0];
}
