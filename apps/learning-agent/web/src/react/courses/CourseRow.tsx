import { useTranslation } from "react-i18next";
import { Archive, BookOpen, MoreHorizontal, Trash2 } from "lucide-react";
import {
	Badge,
	DropdownMenu,
	DropdownMenuActionItem,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	IconButton,
} from "../ui/index.js";
import type { CourseDailyPlan, CourseSummary, DailyPlanItem } from "../../api/courses.js";
import { CourseCover } from "./CourseCover.js";

/**
 * One course row in the today page's course panel.
 *
 * The row keeps the existing archive / delete menu (the only destructive entry
 * left on this page) but it is a sibling of the row's main button, never nested,
 * and it stays visually secondary until hover or keyboard focus.
 */
export function CourseRow({
	course,
	daily,
	onOpen,
	onArchive,
	onDelete,
}: {
	course: CourseSummary;
	daily: CourseDailyPlan | undefined;
	onOpen: () => void;
	onArchive: () => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation();
	const progress = daily?.task_progress;
	const noPlan = daily?.status === "no_active_plan";
	const stage = daily?.items.find((item): item is Extract<DailyPlanItem, { kind: "task" }> => item.kind === "task")?.stage_title;
	const subtitle = course.status === "paused"
		? t("course.status.paused")
		: course.status === "completed"
			? t("course.status.completed")
			: noPlan
				? t("today.coursesUi.noPlan")
				: stage ?? daily?.plan?.title ?? t("course.card.daily.none");

	return (
		<div className="mla-today-course-row">
			<button type="button" className="mla-today-course-main" onClick={onOpen}>
				<CourseCover course={course} size="md" />
				<span className="mla-today-course-info">
					<span className="mla-today-course-name">
						<strong>{course.title}</strong>
						{course.status === "paused" ? <Badge tone="warning">{t("course.status.paused")}</Badge> : null}
						{course.status === "completed" ? <Badge>{t("course.status.completed")}</Badge> : null}
						{noPlan ? <Badge>{t("today.coursesUi.noPlan")}</Badge> : null}
					</span>
					<span className="mla-today-course-sub">{subtitle}</span>
					{progress && progress.total > 0 ? (
						<span className="mla-today-course-bar">
							<span className="mla-today-track" aria-hidden="true">
								<span style={{ width: `${progress.percent}%` }} />
							</span>
							<span className="mla-today-course-count">
								{progress.completed} / {progress.total}
							</span>
						</span>
					) : noPlan ? (
						<span className="mla-today-course-count">{t("today.coursesUi.noPlanProgress")}</span>
					) : null}
				</span>
				<span className="mla-today-course-pct">
					<strong>{progress && progress.total > 0 ? `${progress.percent}%` : "—"}</strong>
					<span>{t("course.card.taskProgress")}</span>
				</span>
			</button>

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<IconButton
						className="mla-today-course-menu"
						aria-label={t("course.card.moreActions", { title: course.title })}
					>
						<MoreHorizontal size={16} aria-hidden="true" />
					</IconButton>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuActionItem icon={<BookOpen size={14} />} label={t("course.card.view")} onSelect={onOpen} />
					<DropdownMenuActionItem
						icon={<Archive size={14} />}
						label={t("course.card.archive")}
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
	);
}
