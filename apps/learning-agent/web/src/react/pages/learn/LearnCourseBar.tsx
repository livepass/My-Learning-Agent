import { useTranslation } from "react-i18next";
import { BookOpen, ChevronDown, PanelRightClose, PanelRightOpen, Plus } from "lucide-react";
import type { CourseStatus, CourseSummary, LearningStartTaskView } from "../../../api/courses.js";
import { CourseCover } from "../../courses/CourseCover.js";
import {
	Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
	DropdownMenuRadioItem, DropdownMenuTrigger,
} from "../../ui/index.js";

export type LearnCourseBarCourse = {
	course_id: string;
	title: string;
	/** Null when only the session binding is known and no course summary loaded. */
	status: CourseStatus | null;
};

/**
 * E4.9g-P2-2 — one course bar for the conversation mode.
 *
 * It replaces the duplicated chat title and `CourseContextStrip`: the course,
 * its status, the server-bound task/stage and the actions that used to be
 * scattered across the header and the sidebar now share one row.
 *
 * Everything shown here is a real payload: `sessionContext` (course, task,
 * stage, warnings) or the course list. A missing task is never replaced by a
 * guessed one; a missing context is simply not drawn.
 */
export function LearnCourseBar({
	course,
	courses,
	task,
	stageTitle,
	warnings,
	contextReady,
	unclassified,
	canStartNew,
	creating,
	statusOpen,
	navOpen,
	onOpenNav,
	onSelectCourse,
	onNewConversation,
	onToggleStatus,
	onOpenPlan,
}: {
	course: LearnCourseBarCourse | null;
	courses: CourseSummary[];
	task: LearningStartTaskView | null;
	stageTitle: string | null;
	warnings: string[];
	contextReady: boolean;
	unclassified: boolean;
	canStartNew: boolean;
	creating: boolean;
	statusOpen: boolean;
	navOpen: boolean;
	onOpenNav: () => void;
	onSelectCourse: (courseId: string) => void;
	onNewConversation: () => void;
	onToggleStatus: () => void;
	onOpenPlan: () => void;
}) {
	const { t } = useTranslation();
	const title = course?.title
		?? (unclassified ? t("learn.sidebar.unclassifiedChat") : t("nav.learn.label"));
	const showContext = Boolean(course) && contextReady && !unclassified;
	const showFreeLearning = showContext && !task && !stageTitle;

	return (
		<header
			className="mla-course-bar"
			aria-label={course ? t("course.context.ariaLabel") : t("learn.courseBar.aria")}
		>
			<button
				type="button"
				className="mla-learn-nav-toggle mla-course-bar-nav"
				aria-label={t("learn.sidebar.openNav")}
				aria-expanded={navOpen}
				onClick={onOpenNav}
			>
				<BookOpen size={16} aria-hidden="true" />
			</button>

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="mla-course-bar-switch"
						aria-label={t("learn.courseBar.switchCourse")}
					>
						{course ? <CourseCover course={course} size="sm" /> : null}
						<span className="mla-course-bar-title">
							<strong title={title}>{title}</strong>
							{course?.status ? (
								<Badge tone={course.status === "in_progress" ? "accent" : "neutral"}>
									{t(`course.status.${course.status}`)}
								</Badge>
							) : null}
							{!course && unclassified ? <Badge>{t("learn.sidebar.unclassified")}</Badge> : null}
						</span>
						<ChevronDown size={14} aria-hidden="true" className="mla-course-bar-caret" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" sideOffset={6} className="mla-course-bar-menu">
					<DropdownMenuLabel>{t("learn.courseBar.switchLabel")}</DropdownMenuLabel>
					{courses.length > 0 ? (
						<DropdownMenuRadioGroup
							value={course?.course_id ?? ""}
							onValueChange={onSelectCourse}
						>
							{courses.map((item) => (
								<DropdownMenuRadioItem
									key={item.course_id}
									value={item.course_id}
									className="mla-course-bar-option"
								>
									<span className="mla-course-bar-option-copy">
										<strong>{item.title}</strong>
										<span>{t(`course.status.${item.status}`)}</span>
									</span>
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					) : (
						<p className="mla-course-bar-menu-empty">{t("learn.courseBar.noCourses")}</p>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			{showContext ? (
				<div className="mla-course-bar-context">
					{task ? (
						<span className="mla-course-bar-task" title={task.title}>
							<i
								className={task.status === "in_progress" ? "is-active" : ""}
								aria-hidden="true"
							/>
							<span className="mla-course-bar-task-label">{t("learn.courseBar.currentTask")}</span>
							<strong>{task.title}</strong>
						</span>
					) : showFreeLearning ? (
						<span className="mla-course-bar-free">{t("course.context.freeLearning")}</span>
					) : null}
					{stageTitle ? (
						<span className="mla-course-bar-stage" title={stageTitle}>
							{t("course.context.stage", { title: stageTitle })}
						</span>
					) : null}
					{warnings.length > 0 ? (
						<span
							className="mla-course-bar-warning"
							role="img"
							aria-label={warnings.join(" · ")}
							title={warnings.join(" · ")}
						>
							!
						</span>
					) : null}
				</div>
			) : null}

			<div className="mla-course-bar-actions">
				{course ? (
					<span className="mla-course-bar-action-wrap" title={t("learn.courseBar.openPlan")}>
						<Button
							variant="ghost"
							size="xs"
							className="mla-course-bar-action"
							aria-label={t("learn.courseBar.openPlan")}
							onClick={onOpenPlan}
						>
							<BookOpen size={14} aria-hidden="true" />
							<span className="mla-course-bar-action-label">{t("learn.courseBar.openPlan")}</span>
						</Button>
					</span>
				) : null}
				<span className="mla-course-bar-action-wrap" title={t("learn.courseBar.learningStatus")}>
					<Button
						variant="ghost"
						size="xs"
						className="mla-course-bar-action"
						aria-label={t("learn.courseBar.learningStatus")}
						aria-expanded={statusOpen}
						onClick={onToggleStatus}
					>
						{statusOpen
							? <PanelRightClose size={14} aria-hidden="true" />
							: <PanelRightOpen size={14} aria-hidden="true" />}
						<span className="mla-course-bar-action-label">{t("learn.courseBar.learningStatus")}</span>
					</Button>
				</span>
				{course && canStartNew ? (
					<span className="mla-course-bar-action-wrap" title={t("learn.sidebar.newConversation")}>
						<Button
							variant="ghost"
							size="xs"
							className="mla-course-bar-action"
							aria-label={t("learn.sidebar.newConversation")}
							disabled={creating}
							onClick={onNewConversation}
						>
							<Plus size={14} aria-hidden="true" />
							<span className="mla-course-bar-action-label">{t("learn.sidebar.newConversation")}</span>
						</Button>
					</span>
				) : null}
			</div>
		</header>
	);
}
