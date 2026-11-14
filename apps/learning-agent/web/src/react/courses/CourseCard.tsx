import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Archive, BookOpen, Loader2, MoreHorizontal, Play, Sparkles, Trash2 } from "lucide-react";
import {
	Button,
	DropdownMenu,
	DropdownMenuActionItem,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	IconButton,
} from "../ui/index.js";
import type { CourseDailyPlan, CourseSummary, DailyPlanItem } from "../../api/courses.js";

/**
 * One course card on the today page (E4.5b).
 *
 * Every fact shown here comes from the server: the course row from
 * `GET /api/courses`, the task, its minutes and the progress percentage from
 * `GET /api/courses/daily`. The card never picks a task by itself — it renders
 * the recommendation the daily plan already made (`in_progress` first, else
 * `next_task`), so the card and the cross-course list cannot disagree.
 *
 * E4.7: the card owns a 「更多操作」 menu instead of putting destructive actions
 * on the surface. Choosing 删除课程 only opens the confirmation dialog; the
 * card never calls a delete itself.
 */
export function CourseCard({
	course,
	daily,
	busy,
	onStart,
	onResume,
	onOpen,
	onArchive,
	onDelete,
}: {
	course: CourseSummary;
	daily: CourseDailyPlan | undefined;
	busy: boolean;
	onStart: (taskId: string | null) => void;
	/** Paused only: flip the course back to `in_progress`, starting nothing. */
	onResume: () => void;
	onOpen: () => void;
	onArchive: () => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation();
	const taskItem = pickCurrentTask(daily);
	const progress = daily?.task_progress;
	const archived = course.status === "archived";
	const paused = course.status === "paused";

	return (
		<article className="mla-course-card" aria-label={t("course.card.ariaLabel", { title: course.title })}>
			<div className="mla-course-card-head">
				<div className="mla-inline" style={{ gap: 8, flexWrap: "wrap", minWidth: 0 }}>
					<h3>{course.title}</h3>
					<span className={`mla-badge${course.status === "in_progress" ? " mla-badge--accent" : ""}`}>
						{t(`course.status.${course.status}`)}
					</span>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<IconButton aria-label={t("course.card.moreActions", { title: course.title })}>
							<MoreHorizontal size={16} aria-hidden="true" />
						</IconButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuActionItem icon={<BookOpen size={14} />} label={t("course.card.view")} onSelect={onOpen} />
						<DropdownMenuActionItem
							icon={<Archive size={14} />}
							label={archived ? t("course.card.archived") : t("course.card.archive")}
							disabled={archived}
							onSelect={onArchive}
						/>
						<DropdownMenuSeparator />
						<DropdownMenuActionItem
							icon={<Trash2 size={14} />}
							label={t("course.card.delete")}
							variant="danger"
							onSelect={onDelete}
						/>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{taskItem ? (
				<div className="mla-course-task">
					<span className="mla-small mla-muted">
						{taskItem.reason_code === "in_progress" ? t("course.card.continueCurrentTask") : t("course.card.nextTask")}
					</span>
					<strong>{taskItem.title}</strong>
					<span className="mla-small mla-muted">
						{t("course.card.minutes", { count: taskItem.estimated_minutes })}
						{taskItem.stage_title ? ` · ${taskItem.stage_title}` : ""}
						{taskItem.status === "in_progress" ? ` · ${t("course.status.in_progress")}` : ""}
					</span>
				</div>
			) : (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{dailyStatusText(daily, t)}
				</p>
			)}

			{progress && progress.total > 0 ? (
				<div>
					<div className="mla-inline" style={{ justifyContent: "space-between" }}>
						<span className="mla-small mla-muted">{t("course.card.taskProgress")}</span>
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
				{paused ? (
					<Button variant="primary" disabled={busy} onClick={onResume}>
						{busy ? <Loader2 size={14} className="mla-spin" /> : <Play size={14} />}
						{t("course.detail.resumeCourse")}
					</Button>
				) : taskItem ? (
					<Button variant="primary" disabled={busy || archived} onClick={() => onStart(taskItem.task_id)}>
						{busy ? <Loader2 size={14} className="mla-spin" /> : <Play size={14} />}
						{taskItem.reason_code === "in_progress" ? t("course.card.continueLearning") : t("course.card.startLearning")}
					</Button>
				) : daily?.status === "no_active_plan" ? (
					<Button variant="primary" disabled={archived} onClick={onOpen}>
						<Sparkles size={14} />
						{t("course.card.makePlan")}
					</Button>
				) : null}
				<Button onClick={onOpen}>
					<BookOpen size={14} />
					{t("course.card.view")}
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

function dailyStatusText(daily: CourseDailyPlan | undefined, t: TFunction): string {
	if (!daily) return t("course.card.daily.none");
	switch (daily.status) {
		case "no_active_plan": return t("course.card.daily.noActivePlan");
		case "empty_plan": return t("course.card.daily.emptyPlan");
		case "all_completed": return t("course.card.daily.allCompleted");
		default: return t("course.card.daily.nothingToContinue");
	}
}

