import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Plus } from "lucide-react";
import { currentLocale } from "../../i18n/index.js";
import type { CourseDailyPlan, DailyPlanItem } from "../../api/courses.js";
import type { LearningRecommendation } from "../../types/learner.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";
import { isActionableReviewDue } from "../../utils/review-eligibility.js";
import { isDailyVisible } from "../../utils/session-visibility.js";
import { CourseCard, pickCurrentTask } from "../courses/CourseCard.js";
import { CreateCourseDialog } from "../courses/CreateCourseDialog.js";
import { DeletionDialog, type DeletionTarget } from "../courses/DeletionDialog.js";
import { useCourseErrorText, useCourseFeedbackText } from "../courses/use-course-error-text.js";
import { TodayHero, type TodayHeroVariant } from "./TodayHero.js";
import {
	TodayAdvice,
	TodayCourses,
	TodayEmpty,
	TodayError,
	TodayGoal,
	TodayReviews,
	TodaySessions,
	TodaySkeleton,
} from "./TodayPanels.js";

/**
 * 今日学习 — direction B (course-driven).
 *
 * The page keeps every existing source and write path:
 *   - `coursesStore`: course rows / daily plan / start / resume / create;
 *   - `learnerStore`: next-step recommendations and due reviews;
 *   - `sessionsStore`: the recent-conversation list.
 *
 * What changed is composition, not data: one primary course surface (the
 * latest-updated non-archived course), then the remaining tasks, advice, due
 * reviews and the course / session / goal panels. Starting a task still waits
 * for `POST /learning/start` to return a bound session before navigating.
 */
export function TodayPage() {
	const { t } = useTranslation();
	const courseErrorText = useCourseErrorText();
	const courseFeedbackText = useCourseFeedbackText();

	const { profile, profileLoading, profileError } = useStoreSnapshot(learnerStore, () => ({
		profile: learnerStore.profile,
		profileLoading: learnerStore.isLoading,
		profileError: learnerStore.error,
	}));
	const { recommendations, recommendationsLoading, recommendationsError } = useStoreSnapshot(learnerStore, () => ({
		recommendations: learnerStore.recommendations,
		recommendationsLoading: learnerStore.recommendationsLoading,
		recommendationsError: learnerStore.recommendationsError,
	}));
	const { sessions, sessionsLoading, currentSessionId } = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		sessionsLoading: sessionsStore.isLoading,
		currentSessionId: sessionsStore.currentSessionId,
	}));
	const courseState = useStoreSnapshot(coursesStore, () => ({
		courses: coursesStore.courses,
		coursesLoading: coursesStore.coursesLoading,
		coursesError: coursesStore.coursesError,
		daily: coursesStore.daily,
		dailyLoading: coursesStore.dailyLoading,
		dailyError: coursesStore.dailyError,
		pendingAction: coursesStore.pendingAction,
		feedback: coursesStore.feedback,
	}));

	const [createOpen, setCreateOpen] = useState(false);
	const [pendingTask, setPendingTask] = useState<{ courseId: string; taskId: string } | null>(null);
	const [pendingResume, setPendingResume] = useState<string | null>(null);
	const [lastAttempt, setLastAttempt] = useState<{ courseId: string; taskId: string } | null>(null);
	const [deletionTarget, setDeletionTarget] = useState<DeletionTarget | null>(null);
	const [showAllTasks, setShowAllTasks] = useState(false);

	useEffect(() => {
		void learnerStore.load();
		void learnerStore.loadRecommendations();
		void sessionsStore.load();
		void coursesStore.loadCourses();
		void coursesStore.loadDaily();
	}, []);

	const visibleCourses = useMemo(
		() => courseState.courses.filter((course) => course.status !== "archived"),
		[courseState.courses],
	);
	const archivedCount = courseState.courses.length - visibleCourses.length;
	// The primary course is the most recently updated one; the same order is
	// stable when two courses share an updated_at (the server's list order wins).
	const orderedCourses = useMemo(
		() => [...visibleCourses].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
		[visibleCourses],
	);
	const primaryCourse = orderedCourses[0];
	const dailyByCourse = useMemo(() => {
		const map = new Map<string, CourseDailyPlan>();
		for (const plan of courseState.daily?.courses ?? []) map.set(plan.course_id, plan);
		return map;
	}, [courseState.daily]);
	const primaryDaily = primaryCourse ? dailyByCourse.get(primaryCourse.course_id) : undefined;
	const primaryTask = pickCurrentTask(primaryDaily);

	const taskRefs = useMemo(() => {
		const refs: Array<{ item: Extract<DailyPlanItem, { kind: "task" }>; plan: CourseDailyPlan }> = [];
		for (const plan of courseState.daily?.courses ?? []) {
			for (const item of plan.items) {
				if (item.kind === "task") refs.push({ item, plan });
			}
		}
		return refs;
	}, [courseState.daily]);

	const allTasks = taskRefs.map((ref) => ref.item);
	const done = allTasks.length > 0 && allTasks.every((task) => task.status === "completed");
	const restTaskRefs = primaryTask
		? taskRefs.filter((ref) => ref.item.task_id !== primaryTask.task_id)
		: taskRefs;
	// Keep the first screen at three cards: two remaining tasks plus the review
	// card. Extra tasks stay one click away instead of pushing the grid into a
	// lone fourth column.
	const visibleRestTaskRefs = showAllTasks ? restTaskRefs : restTaskRefs.slice(0, 2);

	const dueReviews = useMemo(() => {
		const now = Date.now();
		// Same evidence standard as GET /api/learner/recommendations.
		return (profile?.knowledge_states ?? [])
			.filter((state) => isActionableReviewDue(state, now))
			.sort((a, b) => Date.parse(a.review_due_at!) - Date.parse(b.review_due_at!));
	}, [profile]);

	const activeGoals = useMemo(
		() => (profile?.goals ?? []).filter((goal) => goal.status === "active").sort((a, b) => b.priority - a.priority),
		[profile],
	);
	const visibleSessions = useMemo(() => sessions.filter(isDailyVisible), [sessions]);
	const recentSessions = useMemo(() => visibleSessions.slice(0, 3), [visibleSessions]);

	const coursesPending = courseState.coursesLoading && courseState.courses.length === 0;
	const dailyPending = courseState.dailyLoading && !courseState.daily;
	const mainPending = coursesPending || dailyPending;
	const coursesFailed = !courseState.coursesLoading && Boolean(courseState.coursesError) && courseState.courses.length === 0;
	const dailyFailed = !courseState.dailyLoading && Boolean(courseState.dailyError) && !courseState.daily;
	const noCourses = !courseState.coursesLoading && !coursesFailed && visibleCourses.length === 0;

	const heroVariant: TodayHeroVariant = primaryCourse
		? primaryCourse.status === "paused"
			? "paused"
			: primaryDaily?.status === "no_active_plan"
				? "no-plan"
				: done
					? "done"
					: primaryTask
						? "task"
						: "course"
		: "course";

	const anyWrite = Boolean(courseState.pendingAction);
	const startBusy = Boolean(pendingTask) || Boolean(pendingResume) || courseState.pendingAction === "start_learning" || courseState.pendingAction === "resume_course";

	const openCourse = (courseId: string, view: "plan" | "library" | "records" | "overview" = "plan") => {
		navigate("course", { history: "push", course: { id: courseId, view } });
	};

	const openSession = (id: string) => {
		// One history entry: the page and the conversation are written together,
		// so Back returns here instead of stepping through an empty learn page.
		navigate("learn", { history: "push", session: id });
		void sessionsStore.openSession(id, { historyMode: "none" });
	};

	const startReview = (conceptId: string) => {
		// Navigation only: the practice page re-reads the L1 profile and refuses a
		// stale concept before any model call. No session is created here.
		navigate("practice", {
			history: "push",
			session: currentSessionId ?? null,
			review: { conceptId },
		});
		if (currentSessionId) void sessionsStore.openSession(currentSessionId, { historyMode: "none" });
	};

	const openRecommendation = (item: LearningRecommendation) => {
		// Navigation only. Opening AI learning must not call the model on its own.
		if (item.action === "learn") navigate("learn", { history: "push" });
		else if (item.action === "review") startReview(item.concept_id);
		else navigate("practice", { history: "push" });
	};

	/** Start or resume the bound AI session, then show it. Never the reverse. */
	const startCourseLearning = async (courseId: string, taskId: string) => {
		setPendingTask({ courseId, taskId });
		setLastAttempt({ courseId, taskId });
		try {
			const result = await coursesStore.startLearning(courseId, taskId);
			if (!result) return;
			navigate("learn", { history: "push", session: result.session.session_id });
			await sessionsStore.openSession(result.session.session_id, { historyMode: "none" });
			await coursesStore.loadSessionContext(result.session.session_id);
			coursesStore.recordStartWarnings(result.session.session_id, result.warnings);
		} finally {
			setPendingTask(null);
		}
	};

	/** Status only: resuming never opens a session or creates a learning record. */
	const resumeCourse = async (courseId: string) => {
		setPendingResume(courseId);
		try {
			await coursesStore.resumeCourse(courseId);
		} finally {
			setPendingResume(null);
		}
	};

	const retryStart = () => {
		if (!lastAttempt) return;
		void startCourseLearning(lastAttempt.courseId, lastAttempt.taskId);
	};

	const openArchive = () => navigate("settings", { history: "push", settingsTab: "archive" });

	const now = new Date();
	const dateText = `${now.toLocaleDateString(currentLocale(), { year: "numeric", month: "long", day: "numeric" })} · ${now.toLocaleDateString(currentLocale(), { weekday: "long" })}`;

	const reviewPanel = (
		<TodayReviews
			reviews={dueReviews}
			onReview={startReview}
			onKnowledge={() => navigate("profile", { history: "push" })}
		/>
	);

	const pageFeedback = !createOpen && courseState.feedback && courseState.feedback.tone !== "success"
		? courseState.feedback
		: null;
	const pageFeedbackText = courseFeedbackText(pageFeedback);

	const remainingMeta = dueReviews.length > 0
		? t("today.remaining.meta", { tasks: restTaskRefs.length, reviews: dueReviews.length })
		: t("today.remaining.metaNoReviews", { tasks: restTaskRefs.length });

	return (
		<>
			<div className="mla-today">
				<div className="mla-today-head">
					<div>
						<h1>{t("today.header.title")}</h1>
						<p>{dateText}</p>
					</div>
					<Button
						variant="primary"
						size="sm"
						onClick={() => setCreateOpen(true)}
						aria-label={t("today.courses.create")}
						disabled={anyWrite}
					>
						<Plus size={14} aria-hidden="true" />
						<span className="mla-today-create-label">{t("today.courses.create")}</span>
					</Button>
				</div>

				{mainPending ? (
					<TodaySkeleton />
				) : coursesFailed ? (
					<TodayError
						title={t("today.errorUi.title")}
						message={courseErrorText(courseState.coursesError) ?? t("today.errorUi.body")}
						onRetry={() => void coursesStore.loadCourses()}
						onArchive={openArchive}
					/>
				) : noCourses ? (
					<TodayEmpty
						archivedCount={archivedCount}
						onCreate={() => setCreateOpen(true)}
						onArchive={openArchive}
					/>
				) : dailyFailed ? (
					<TodayError
						title={t("today.errorUi.dailyTitle")}
						message={courseErrorText(courseState.dailyError) ?? t("today.errorUi.body")}
						onRetry={() => void coursesStore.loadDaily()}
						onArchive={openArchive}
					/>
				) : primaryCourse ? (
					<TodayHero
						variant={heroVariant}
						course={primaryCourse}
						daily={primaryDaily}
						task={primaryTask}
						busy={
							(Boolean(primaryTask) && pendingTask?.taskId === primaryTask!.task_id) ||
							pendingResume === primaryCourse.course_id
						}
						doneCount={allTasks.length}
						courseCount={new Set(taskRefs.map((ref) => ref.plan.course_id)).size || visibleCourses.length}
						totalMinutes={allTasks.reduce((sum, task) => sum + task.estimated_minutes, 0)}
						reviewCount={dueReviews.length}
						onStart={() => {
							if (primaryTask) void startCourseLearning(primaryCourse.course_id, primaryTask.task_id);
						}}
						onResume={() => void resumeCourse(primaryCourse.course_id)}
						onOpen={() => openCourse(primaryCourse.course_id)}
						onPlan={() => openCourse(primaryCourse.course_id, "plan")}
						onRecords={() => openCourse(primaryCourse.course_id, "records")}
						onLearn={() => navigate("learn", { history: "push" })}
					/>
				) : null}

				{courseState.coursesError && courseState.courses.length > 0 ? (
					<div className="mla-today-alert" role="alert">
						<AlertCircle size={16} aria-hidden="true" />
						<div>
							<strong>{t("today.errorUi.title")}</strong>
							<p>{courseErrorText(courseState.coursesError)}</p>
						</div>
						<Button size="xs" onClick={() => void coursesStore.loadCourses()}>{t("today.retry")}</Button>
					</div>
				) : null}

				{courseState.dailyError && courseState.daily ? (
					<div className="mla-today-alert" role="alert">
						<AlertCircle size={16} aria-hidden="true" />
						<div>
							<strong>{t("today.errorUi.dailyTitle")}</strong>
							<p>{courseErrorText(courseState.dailyError)}</p>
						</div>
						<Button size="xs" onClick={() => void coursesStore.loadDaily()}>{t("today.retry")}</Button>
					</div>
				) : null}

				{pageFeedback ? (
					<div className="mla-today-alert" role="alert">
						<AlertCircle size={16} aria-hidden="true" />
						<div>
							<strong>{lastAttempt ? t("today.startError.title") : t("today.errorUi.actionFailed")}</strong>
							<p>{pageFeedbackText}</p>
						</div>
						{lastAttempt ? (
							<Button size="xs" disabled={anyWrite} onClick={retryStart}>
								{t("today.startError.retry")}
							</Button>
						) : null}
					</div>
				) : null}

				{restTaskRefs.length > 0 && !mainPending && !coursesFailed && !noCourses && !dailyFailed ? (
					<section className="mla-today-section" aria-labelledby="today-remaining-title">
						<div className="mla-today-section-head">
							<h2 id="today-remaining-title">{t("today.remaining.title")}</h2>
							<div className="mla-today-section-meta">
								<span>{remainingMeta}</span>
								{restTaskRefs.length > 2 ? (
									<Button
										variant="ghost"
										size="xs"
										aria-expanded={showAllTasks}
										onClick={() => setShowAllTasks((value) => !value)}
									>
										{showAllTasks
											? t("today.adviceUi.collapse")
											: t("today.remaining.more", { count: restTaskRefs.length - 2 })}
									</Button>
								) : null}
							</div>
						</div>
						<div className="mla-today-grid">
							{visibleRestTaskRefs.map(({ item, plan }) => {
								const course = visibleCourses.find((candidate) => candidate.course_id === plan.course_id);
								if (!course) return null;
								return (
									<CourseCard
										key={item.task_id}
										course={course}
										daily={plan}
										task={item}
										busy={Boolean(pendingTask && pendingTask.courseId === course.course_id && pendingTask.taskId === item.task_id)}
										disabled={startBusy || anyWrite}
										onStart={() => void startCourseLearning(course.course_id, item.task_id)}
										onOpen={() => openCourse(course.course_id)}
									/>
								);
							})}
							{reviewPanel}
						</div>
					</section>
				) : (
					<div className="mla-today-reviews-standalone">{reviewPanel}</div>
				)}

				<TodayAdvice
					snapshot={recommendations}
					loading={recommendationsLoading}
					error={recommendationsError}
					onOpen={openRecommendation}
				/>

				<div className={`mla-today-lower${visibleCourses.length === 0 ? " mla-today-lower--solo" : ""}`}>
					{visibleCourses.length > 0 ? (
						<TodayCourses
							courses={visibleCourses}
							dailyByCourse={dailyByCourse}
							onOpen={openCourse}
							onArchive={(courseId) => { void coursesStore.archiveCourse(courseId); }}
							onDelete={(course) => setDeletionTarget({
								kind: "course",
								courseId: course.course_id,
								title: course.title,
							})}
						/>
					) : null}
					<div className="mla-today-aside">
						<TodaySessions
							sessions={recentSessions}
							loading={sessionsLoading}
							total={visibleSessions.length}
							onOpen={openSession}
							onAll={() => navigate("learn", { history: "push" })}
						/>
						<TodayGoal
							goal={activeGoals[0]}
							loading={profileLoading}
							error={profileError}
							moreGoals={Math.max(0, activeGoals.length - 1)}
							onOpen={() => navigate("profile", { history: "push" })}
						/>
					</div>
				</div>
			</div>

			<CreateCourseDialog
				open={createOpen}
				pending={courseState.pendingAction === "create_course"}
				error={createOpen && courseState.feedback?.tone === "error" ? courseFeedbackText(courseState.feedback) : null}
				onClose={() => setCreateOpen(false)}
				onCreate={async (input) => {
					const created = await coursesStore.createCourse(input);
					if (!created) return false;
					setCreateOpen(false);
					// A new course has no plan yet: land on its plan tab so the next
					// step (goals → material → plan) is one click away.
					openCourse(created.course_id, "plan");
					return true;
				}}
			/>

			{/* E4.7: deletion is a separate, two-step confirmation. The menu item
			    only opens this dialog; nothing is removed until 「永久删除」. */}
			<DeletionDialog
				target={deletionTarget}
				onClose={() => setDeletionTarget(null)}
				onArchive={async () => {
					if (!deletionTarget) return false;
					return coursesStore.archiveCourse(deletionTarget.courseId);
				}}
			/>
		</>
	);
}
