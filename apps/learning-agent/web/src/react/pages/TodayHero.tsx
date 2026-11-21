import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, Play, Sparkles, Target } from "lucide-react";
import { Button } from "../ui/index.js";
import type { CourseDailyPlan, CourseSummary, DailyPlanItem } from "../../api/courses.js";
import { taskReasonText } from "./daily-plan-copy.js";

export type TodayHeroVariant = "task" | "paused" | "no-plan" | "empty-plan" | "done" | "course";

type DailyTask = Extract<DailyPlanItem, { kind: "task" }>;

/**
 * The single primary surface of the today page (direction B).
 *
 * The page decides which variant is true; this component never chooses a task
 * or a course state by itself. Every string is either a server field (title,
 * stage, minutes, progress) or a translated label.
 */
export function TodayHero({
	variant,
	course,
	daily,
	task,
	busy,
	disabled,
	reviewCount,
	onStart,
	onResume,
	onOpen,
	onPlan,
	onRecords,
	onLearn,
}: {
	variant: TodayHeroVariant;
	course: CourseSummary;
	daily: CourseDailyPlan | undefined;
	task?: DailyTask;
	busy: boolean;
	/**
	 * True while another write (start / resume / create / archive / delete) is
	 * in flight. Start and resume must reject clicks instead of queueing a
	 * second request; navigation stays available because it writes nothing.
	 */
	disabled: boolean;
	reviewCount: number;
	onStart: () => void;
	onResume: () => void;
	onOpen: () => void;
	onPlan: () => void;
	onRecords: () => void;
	onLearn: () => void;
}) {
	const { t } = useTranslation();
	const progress = daily?.task_progress;
	const stage = task?.stage_title ?? daily?.plan?.title;

	const badge = (() => {
		if (variant === "paused") return <><AlertCircle size={13} aria-hidden="true" />{t("today.hero.paused")}</>;
		if (variant === "no-plan") return <><Target size={13} aria-hidden="true" />{t("today.hero.noPlan")}</>;
		if (variant === "empty-plan") return <><Target size={13} aria-hidden="true" />{t("today.hero.emptyPlan")}</>;
		if (variant === "done") return <><CheckCircle2 size={13} aria-hidden="true" />{t("today.hero.done")}</>;
		return <><Sparkles size={13} aria-hidden="true" />{t("today.hero.mainCourse")} · {course.title}</>;
	})();

	const title = (() => {
		if (variant === "task" && task) return task.title;
		// Plan completion names the course and comes from `daily.status`; it is
		// never inferred from an empty `items` array (completed tasks are filtered
		// out by the server before the snapshot is built).
		if (variant === "done") return t("today.hero.doneTitle", { title: course.title });
		return course.title;
	})();

	const meta = (() => {
		if (variant === "task" && task) {
			return [stage, t("course.card.minutes", { count: task.estimated_minutes })].filter(Boolean).join(" · ");
		}
		if (variant === "done") return daily?.plan?.title ?? "";
		return [daily?.plan?.title, t(`course.status.${course.status}`)].filter(Boolean).join(" · ");
	})();

	const reason = (() => {
		if (variant === "task" && task) return taskReasonText(t, task.reason_code);
		if (variant === "paused") return t("today.hero.pausedReason");
		if (variant === "no-plan") return t("today.hero.noPlanReason");
		if (variant === "empty-plan") return t("today.hero.emptyPlanReason");
		if (variant === "done") {
			return reviewCount > 0
				? t("today.hero.doneReason", { count: reviewCount })
				: t("today.hero.doneReasonNone");
		}
		return t("today.hero.noTasksReason");
	})();

	return (
		<section
			className={`mla-today-hero${variant === "paused" || variant === "no-plan" || variant === "empty-plan" || variant === "course" ? " mla-today-hero--quiet" : ""}${variant === "done" ? " mla-today-hero--done" : ""}`}
			aria-labelledby="today-hero-title"
		>
			<div className="mla-today-hero-copy">
				<span className="mla-today-hero-badge">{badge}</span>
				<h2 id="today-hero-title">{title}</h2>
				<p className="mla-today-hero-meta">{meta}</p>
				<p className="mla-today-hero-reason">{reason}</p>

				{progress && progress.total > 0 ? (
					<div className="mla-today-hero-progress">
						<span className="mla-today-hero-track" aria-hidden="true">
							<span style={{ width: `${progress.percent}%` }} />
						</span>
						<span className="mla-today-sr">{t("course.card.taskProgress")}</span>
						{variant === "done" ? (
							<span>
								{t("today.hero.doneProgress", {
									completed: progress.completed,
									total: progress.total,
								})}
							</span>
						) : (
							<span>{progress.completed}/{progress.total} · {progress.percent}%</span>
						)}
					</div>
				) : null}

				<div className="mla-today-hero-actions">
					{variant === "task" ? (
						<Button variant="secondary" className="mla-today-hero-cta" disabled={busy || disabled} onClick={onStart}>
							{busy ? <Loader2 size={14} className="mla-spin" /> : <Play size={14} />}
							{task && (task.status === "in_progress" || task.reason_code === "in_progress")
								? t("course.card.continueLearning")
								: t("course.card.startLearning")}
						</Button>
					) : null}
					{variant === "paused" ? (
						<Button variant="secondary" className="mla-today-hero-cta" disabled={busy || disabled} onClick={onResume}>
							{busy ? <Loader2 size={14} className="mla-spin" /> : <Play size={14} />}
							{t("course.detail.resumeCourse")}
						</Button>
					) : null}
					{variant === "no-plan" ? (
						<Button variant="secondary" className="mla-today-hero-cta" onClick={onPlan}>
							<Target size={14} />
							{t("course.card.makePlan")}
						</Button>
					) : null}
					{variant === "empty-plan" ? (
						<Button variant="secondary" className="mla-today-hero-cta" onClick={onPlan}>
							<Target size={14} />
							{t("today.hero.openPlan")}
						</Button>
					) : null}
					{variant === "done" ? (
						<Button variant="secondary" className="mla-today-hero-cta" onClick={onRecords}>
							<CheckCircle2 size={14} />
							{t("today.hero.viewRecords")}
						</Button>
					) : null}
					{variant === "course" ? (
						<Button variant="secondary" className="mla-today-hero-cta" onClick={onOpen}>
							{t("course.card.view")}
						</Button>
					) : null}

					{variant === "task" || variant === "paused" || variant === "no-plan" || variant === "empty-plan" ? (
						<Button variant="ghost" className="mla-today-hero-ghost" onClick={onOpen}>
							{t("course.card.view")}
						</Button>
					) : null}
					{variant === "done" ? (
						<Button variant="ghost" className="mla-today-hero-ghost" onClick={onLearn}>
							{t("today.rail.goLearn")}
						</Button>
					) : null}
				</div>
			</div>

			<div className="mla-today-hero-art" aria-hidden="true">
				<HeroArt />
			</div>
		</section>
	);
}

function HeroArt() {
	return (
		<svg viewBox="0 0 320 132" fill="none">
			<defs>
				<linearGradient id="todayHeroCurve" x1="0" y1="0" x2="320" y2="132" gradientUnits="userSpaceOnUse">
					<stop stopColor="#fff" stopOpacity=".9" />
					<stop offset="1" stopColor="#fff" stopOpacity=".28" />
				</linearGradient>
			</defs>
			<path d="M8 22h304M8 66h304M8 110h304" stroke="#fff" strokeOpacity=".12" strokeDasharray="3 5" />
			<path
				d="M18 18c42 2 52 58 84 72 30 13 44-14 66-32 22-18 34-30 56-24 24 6 34 30 60 34"
				stroke="url(#todayHeroCurve)"
				strokeWidth="2"
				strokeLinecap="round"
			/>
			<circle cx="18" cy="18" r="4" fill="#fff" fillOpacity=".9" />
			<circle cx="102" cy="90" r="3.2" fill="#fff" fillOpacity=".75" />
			<circle cx="168" cy="58" r="3.2" fill="#fff" fillOpacity=".75" />
			<circle cx="224" cy="34" r="3.2" fill="#fff" fillOpacity=".75" />
			<circle cx="284" cy="68" r="5" fill="#fff" />
			<circle cx="284" cy="68" r="11" stroke="#fff" strokeOpacity=".4" />
			<path d="M284 84v26" stroke="#fff" strokeOpacity=".35" strokeDasharray="3 4" />
		</svg>
	);
}
