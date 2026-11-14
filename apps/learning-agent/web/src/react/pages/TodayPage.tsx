import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
	Archive, ArrowRight, BookOpen, CalendarClock, Lightbulb, Loader2, Plus, Target,
} from "lucide-react";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore, type CourseDailyPlan } from "../../stores/courses-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";
import { isActionableReviewDue } from "../../utils/review-eligibility.js";
import { isDailyVisible } from "../../utils/session-visibility.js";
import type { LearningRecommendation } from "../../types/learner.js";
import { CourseCard } from "../courses/CourseCard.js";
import { CreateCourseDialog } from "../courses/CreateCourseDialog.js";
import { DeletionDialog, type DeletionTarget } from "../courses/DeletionDialog.js";

/**
 * 今日学习 — multi-course homepage (E4.5b).
 *
 * The page composes four sources, each owned by its own store:
 *   - `coursesStore.courses` + `coursesStore.daily`: course cards and the
 *     cross-course task list, both computed by the server;
 *   - `learnerStore`: the existing C4 next-step suggestions and due reviews;
 *   - `sessionsStore`: the recent-conversation rail.
 *
 * Nothing is invented here. A course card shows the task the daily plan
 * already picked, and 开始/继续学习 only navigates after
 * `POST /learning/start` has returned a bound session, so a failed start
 * leaves the learner on this page instead of opening an empty chat.
 */

function formatDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

const ACTION_LABEL_KEY: Record<LearningRecommendation["action"], string> = {
	learn: "today.action.learn",
	review: "today.action.review",
	practice: "today.action.practice",
	diagnose: "today.action.diagnose",
	transfer: "today.action.transfer",
};

const KIND_LABEL_KEY: Record<NonNullable<LearningRecommendation["suggested_kind"]>, string> = {
	free_recall: "today.kind.free_recall",
	application: "today.kind.application",
	transfer: "today.kind.transfer",
};

const RESULT_LABEL_KEY: Record<NonNullable<LearningRecommendation["evidence_basis"]["last_result"]>, string> = {
	correct: "today.lastResult.correct",
	partial: "today.lastResult.partial",
	incorrect: "today.lastResult.incorrect",
	unknown: "today.lastResult.unknown",
};

/** Machine-readable basis, rendered as small facts — never as a mastery claim. */
function basisFacts(item: LearningRecommendation, t: TFunction): string[] {
	const basis = item.evidence_basis;
	const facts: string[] = [];
	if (basis.has_active_misconception) facts.push(t("today.basis.activeMisconception"));
	if (basis.review_due_at) {
		facts.push(t("today.basis.reviewAt", { date: formatDate(basis.review_due_at) || t("today.basis.reviewDueNow") }));
	}
	facts.push(t("today.basis.evidenceCount", { count: basis.evidence_count }));
	if (basis.last_result) facts.push(t(RESULT_LABEL_KEY[basis.last_result]));
	if (basis.exposure_only) facts.push(t("today.basis.exposureOnly"));
	if (basis.provenance_limited) facts.push(t("today.basis.provenanceLimited"));
	return facts;
}

export function TodayPage() {
	const { t } = useTranslation();
	const { profile, isLoading: profileLoading, error: profileError } = useStoreSnapshot(learnerStore, () => ({
		profile: learnerStore.profile,
		isLoading: learnerStore.isLoading,
		error: learnerStore.error,
	}));
	const {
		recommendations, recommendationsLoading, recommendationsError,
	} = useStoreSnapshot(learnerStore, () => ({
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
	const [startingCourseId, setStartingCourseId] = useState<string | null>(null);
	const [resumingCourseId, setResumingCourseId] = useState<string | null>(null);
	const [deletionTarget, setDeletionTarget] = useState<DeletionTarget | null>(null);

	useEffect(() => {
		void learnerStore.load();
		void learnerStore.loadRecommendations();
		void sessionsStore.load();
		void coursesStore.loadCourses();
		void coursesStore.loadDaily();
	}, []);

	const nextActions = recommendations?.recommendations ?? [];

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
		// Navigation only: opening the practice page must not generate a question,
		// and opening AI learning must not call the model on its own.
		if (item.action === "learn") navigate("learn", { history: "push" });
		else if (item.action === "review") startReview(item.concept_id);
		else navigate("practice", { history: "push" });
	};

	/** Start or resume the bound AI session, then show it. Never the reverse. */
	const startCourseLearning = async (courseId: string, taskId: string | null) => {
		setStartingCourseId(courseId);
		try {
			const result = await coursesStore.startLearning(courseId, taskId);
			if (!result) return;
			// One history entry: the page and the conversation are written together.
			navigate("learn", { history: "push", session: result.session.session_id });
			await sessionsStore.openSession(result.session.session_id, { historyMode: "none" });
			await coursesStore.loadSessionContext(result.session.session_id);
			coursesStore.recordStartWarnings(result.session.session_id, result.warnings);
		} finally {
			setStartingCourseId(null);
		}
	};

	/** Status only: resuming never opens a session or creates a learning record. */
	const resumeCourse = async (courseId: string) => {
		setResumingCourseId(courseId);
		try {
			await coursesStore.resumeCourse(courseId);
		} finally {
			setResumingCourseId(null);
		}
	};

	const openCourse = (courseId: string, view: "plan" | "library" | "records" | "overview" = "plan") => {
		navigate("course", { history: "push", course: { id: courseId, view } });
	};

	const activeGoals = useMemo(
		() => (profile?.goals ?? []).filter((goal) => goal.status === "active").sort((a, b) => b.priority - a.priority),
		[profile],
	);

	const dueReviews = useMemo(() => {
		const now = Date.now();
		// Same evidence standard as GET /api/learner/recommendations: a stored due
		// date only becomes a review task when the state is projection-derived and
		// has traceable evidence. Otherwise the two pages would disagree.
		return (profile?.knowledge_states ?? [])
			.filter((state) => isActionableReviewDue(state, now))
			.sort((a, b) => Date.parse(a.review_due_at!) - Date.parse(b.review_due_at!));
	}, [profile]);

	// E4.7-R1: the rail follows the server's derived visibility, not the
	// session's own flag. A conversation hidden only because its course is
	// archived used to stay here — it is history now, not a recent study.
	const visibleSessions = useMemo(() => sessions.filter(isDailyVisible), [sessions]);
	const recentSessions = useMemo(() => visibleSessions.slice(0, 5), [visibleSessions]);

	const dailyByCourse = useMemo(() => {
		const map = new Map<string, CourseDailyPlan>();
		for (const course of courseState.daily?.courses ?? []) map.set(course.course_id, course);
		return map;
	}, [courseState.daily]);

	const today = new Date();
	const courseBusy = courseState.pendingAction === "start_learning";
	// E4.7-R1b: archived courses leave the homepage. They stay reachable in
	// 「系统设置 → 归档」 with their plans, tasks and records intact.
	const visibleCourses = courseState.courses.filter((course) => course.status !== "archived");
	const archivedCourseCount = courseState.courses.length - visibleCourses.length;

	const openSession = (id: string) => {
		// One history entry: the page and the conversation are written together,
		// so Back returns here instead of stepping through an empty learn page.
		navigate("learn", { history: "push", session: id });
		void sessionsStore.openSession(id, { historyMode: "none" });
	};

	return (
		<>
			<div className="mla-page-head">
				<div>
					<h1>{t("today.header.title")}</h1>
					<p>{t("today.header.subtitle")}</p>
				</div>
				<div className="mla-page-meta">
					{today.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}
					<br />
					{today.toLocaleDateString("zh-CN", { weekday: "long" })}
				</div>
			</div>

			<div className="mla-split">
				<div className="mla-stack-lg">
					{/* ── Courses ─────────────────────────────────────── */}
					<section className="mla-card" aria-labelledby="today-courses">
						<div className="mla-card-header">
							<div>
								<h2 id="today-courses">{t("today.courses.title")}</h2>
								<span className="mla-small mla-muted">
									{t("today.courses.subtitle")}
								</span>
							</div>
							<div className="mla-toolbar">
								<Button size="xs" variant="primary" onClick={() => setCreateOpen(true)}>
									<Plus size={14} />
									{t("today.courses.create")}
								</Button>
							</div>
						</div>

						{courseState.feedback && courseState.feedback.tone !== "success" ? (
							<p role="alert" className={`mla-notice mla-notice--${courseState.feedback.tone}`}>
								{courseState.feedback.message}
							</p>
						) : null}

						{courseState.coursesLoading && courseState.courses.length === 0 ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								{t("today.courses.loading")}
							</p>
						) : courseState.coursesError ? (
							<div>
								<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
									{courseState.coursesError}
								</p>
								<Button size="xs" style={{ marginTop: 8 }} onClick={() => void coursesStore.loadCourses()}>
									{t("today.retry")}
								</Button>
							</div>
						) : visibleCourses.length === 0 ? (
							<div className="mla-empty">
								<BookOpen size={26} aria-hidden="true" />
								<strong>
									{archivedCourseCount > 0 ? t("today.courses.allArchived") : t("today.courses.emptyTitle")}
								</strong>
								<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
									{archivedCourseCount > 0
										? t("today.courses.allArchivedHint")
										: t("today.courses.emptyHint")}
								</p>
								{archivedCourseCount > 0 ? (
									<Button onClick={() => navigate("settings", { history: "push", settingsTab: "archive" })}>
										<Archive size={14} />
										{t("today.courses.viewArchive")}
									</Button>
								) : (
									<Button variant="primary" onClick={() => setCreateOpen(true)}>
										<Plus size={14} />
										{t("today.courses.create")}
									</Button>
								)}
							</div>
						) : (
							<div className="mla-course-grid">
								{visibleCourses.map((course) => (
									<CourseCard
										key={course.course_id}
										course={course}
										daily={dailyByCourse.get(course.course_id)}
										busy={
											courseState.pendingAction === "resume_course"
												? resumingCourseId === course.course_id
												: courseBusy && startingCourseId === course.course_id
										}
										onStart={(taskId) => void startCourseLearning(course.course_id, taskId)}
										onResume={() => void resumeCourse(course.course_id)}
										onOpen={() => openCourse(course.course_id)}
										onArchive={() => void coursesStore.archiveCourse(course.course_id)}
										onDelete={() => setDeletionTarget({
											kind: "course",
											courseId: course.course_id,
											title: course.title,
										})}
									/>
								))}
							</div>
						)}
					</section>

					{/* ── Cross-course tasks ─────────────────────────── */}
					<section className="mla-card" aria-labelledby="today-tasks">
						<div className="mla-card-header">
							<h2 id="today-tasks">{t("today.tasks.title")}</h2>
							<span className="mla-small mla-muted">
								{courseState.daily
									? t("today.tasks.summary", {
										count: courseState.daily.courses.length,
										minutes: courseState.daily.total_planned_minutes,
									})
									: t("today.tasks.summaryPending")}
							</span>
						</div>
						{courseState.dailyLoading && !courseState.daily ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								{t("today.tasks.loading")}
							</p>
						) : courseState.dailyError ? (
							<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
								{courseState.dailyError}
							</p>
						) : (courseState.daily?.courses.length ?? 0) === 0 ? (
							<div className="mla-empty">
								<CalendarClock size={26} aria-hidden="true" />
								<strong>{t("today.tasks.emptyTitle")}</strong>
								<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
									{t("today.tasks.emptyHint")}
								</p>
							</div>
						) : (
							<div className="mla-stack" style={{ gap: 20 }}>
								{courseState.daily!.courses.map((course) => (
									<div key={course.course_id}>
										<div className="mla-inline" style={{ justifyContent: "space-between" }}>
											<button
												type="button"
												className="mla-link-button"
												onClick={() => openCourse(course.course_id)}
											>
												{course.course_title}
											</button>
											<span className="mla-small mla-muted">
												{course.plan
													? t("today.tasks.planWithMinutes", { plan: course.plan.title, minutes: course.daily_minutes })
													: t("today.tasks.minutesOnly", { minutes: course.daily_minutes })}
											</span>
										</div>
										{course.items.length === 0 ? (
											<p className="mla-small mla-muted" style={{ margin: "6px 0 0" }}>
												{course.status === "no_active_plan"
													? t("today.tasks.noActivePlan")
													: course.status === "empty_plan"
														? t("today.tasks.emptyPlan")
														: t("today.tasks.allCompleted")}
											</p>
										) : (
											<div className="mla-state-list" style={{ marginTop: 6 }}>
												{course.items.map((item) => item.kind === "task" ? (
													<div className="mla-state-row" key={`task:${item.task_id}`}>
														<div>
															<div className="mla-inline" style={{ flexWrap: "wrap" }}>
																<strong>{item.title}</strong>
																<span className={`mla-badge${item.reason_code === "in_progress" ? " mla-badge--accent" : ""}`}>
																	{item.reason_code === "in_progress"
																		? t("course.status.in_progress")
																		: item.reason_code === "over_budget"
																			? t("today.tasks.overBudget")
																			: t("today.tasks.nextItem")}
																</span>
																{item.stage_title ? <span className="mla-badge">{item.stage_title}</span> : null}
															</div>
															<p>{item.reason}</p>
														</div>
														<Button
															disabled={courseBusy}
															onClick={() => void startCourseLearning(course.course_id, item.task_id)}
														>
															{item.reason_code === "in_progress" ? t("today.tasks.continueLearning") : t("today.tasks.startLearning")}
														</Button>
													</div>
												) : (
													<div className="mla-state-row" key={`review:${item.concept_id}`}>
														<div>
															<div className="mla-inline" style={{ flexWrap: "wrap" }}>
																<strong>{item.name_available && item.concept_name ? item.concept_name : t("today.conceptNamePending")}</strong>
																<span className="mla-badge mla-badge--warning">{t("today.action.review")}</span>
																<span className="mla-badge">{course.course_title}</span>
															</div>
															<p>{item.reason}</p>
														</div>
														<Button onClick={() => startReview(item.concept_id)}>{t("today.startReview")}</Button>
													</div>
												))}
											</div>
										)}
										{course.notes.length > 0 ? (
											<p className="mla-small mla-muted" style={{ margin: "8px 0 0" }}>
												{course.notes.join("；")}
											</p>
										) : null}
									</div>
								))}
							</div>
						)}
					</section>

					{/* ── Existing C4 suggestions (kept) ─────────────── */}
					<section className="mla-card" aria-labelledby="today-recommendations">
						<div className="mla-card-header">
							<h2 id="today-recommendations">{t("today.recommendations.title")}</h2>
							<span className="mla-small mla-muted">{t("today.recommendations.subtitle")}</span>
						</div>
						{recommendationsLoading || (!recommendations && !recommendationsError) ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Lightbulb size={14} aria-hidden="true" />
								{t("today.recommendations.loading")}
							</p>
						) : recommendationsError ? (
							<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
								{recommendationsError}
							</p>
						) : nextActions.length === 0 ? (
							<div className="mla-empty">
								<Lightbulb size={26} aria-hidden="true" />
								<strong>{t("today.recommendations.emptyTitle")}</strong>
								<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
									{t("today.recommendations.emptyHint")}
								</p>
							</div>
						) : (
							<div className="mla-state-list">
								{nextActions.map((item) => (
									<div className="mla-state-row" key={item.concept_id}>
										<div>
											<div className="mla-inline" style={{ flexWrap: "wrap" }}>
												<strong>{item.name_available && item.concept_name ? item.concept_name : t("today.conceptNamePending")}</strong>
												<span className="mla-badge mla-badge--accent">{t(ACTION_LABEL_KEY[item.action])}</span>
												{item.suggested_kind ? (
													<span className="mla-badge">
														{t("today.recommendations.suggestedKind", { kind: t(KIND_LABEL_KEY[item.suggested_kind]) })}
													</span>
												) : null}
											</div>
											<p>{item.reason}</p>
											<div className="mla-inline mla-small mla-muted" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
												{basisFacts(item, t).map((fact) => (
													<span key={fact}>{fact}</span>
												))}
											</div>
											{!item.name_available ? (
												<p>{t("today.recommendations.nameUnavailable")}</p>
											) : null}
										</div>
										<Button onClick={() => openRecommendation(item)}>
											{item.action === "learn"
												? t("today.recommendations.goLearn")
												: item.action === "review"
													? t("today.startReview")
													: t("today.recommendations.goPractice")}
										</Button>
									</div>
								))}
							</div>
						)}
					</section>

					<section className="mla-card" aria-labelledby="today-review">
						<div className="mla-card-header">
							<h2 id="today-review">{t("today.reviews.title")}</h2>
							<span className="mla-small mla-muted">{t("today.reviews.subtitle")}</span>
						</div>
						{dueReviews.length === 0 ? (
							<div className="mla-empty">
								<CalendarClock size={26} aria-hidden="true" />
								<strong>{t("today.reviews.emptyTitle")}</strong>
								<p className="mla-small" style={{ margin: 0 }}>
									{t("today.reviews.emptyHint")}
								</p>
							</div>
						) : (
							<div className="mla-state-list">
								{dueReviews.map((state) => (
									<div className="mla-state-row" key={state.concept_id}>
										<div>
											<div className="mla-inline">
												<strong>{state.concept_name}</strong>
												<span className="mla-badge mla-badge--warning">{t("today.action.review")}</span>
											</div>
											<p>{state.diagnosis || t("today.reviews.noDiagnosis")}</p>
										</div>
										<div className="mla-stack" style={{ gap: 6, justifyItems: "end" }}>
											<span className="mla-small mla-muted">
												{t("today.reviews.dueOn", { date: formatDate(state.review_due_at) })}
											</span>
											<Button onClick={() => startReview(state.concept_id)}>{t("today.startReview")}</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</section>
				</div>

				<aside className="mla-rail" aria-label={t("today.rail.label")}>
					<section className="mla-card">
						<div className="mla-card-header">
							<h2>{t("today.rail.currentGoal")}</h2>
							{activeGoals[0] ? <span className="mla-badge mla-badge--accent">{t("course.status.in_progress")}</span> : null}
						</div>
						{activeGoals[0] ? (
							<div className="mla-stack" style={{ gap: 10 }}>
								<strong style={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>{activeGoals[0].title}</strong>
								{activeGoals[0].success_criteria.length > 0 ? (
									<ul className="mla-list">
										{activeGoals[0].success_criteria.map((item) => (
											<li key={item}>
												<Target size={14} aria-hidden="true" />
												<span>{item}</span>
											</li>
										))}
									</ul>
								) : null}
								<span className="mla-small mla-muted">
									{activeGoals.length > 1
										? t("today.rail.moreGoals", { count: activeGoals.length - 1 })
										: t("today.rail.goalsFromProfile")}
								</span>
								<Button onClick={() => navigate("profile", { history: "push" })}>{t("today.rail.viewAllGoals")}</Button>
							</div>
						) : (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{profileLoading ? t("today.rail.profileLoading") : t("today.rail.noGoal")}
							</p>
						)}
					</section>

					<section className="mla-card">
						<div className="mla-card-header">
							<h2>{t("today.rail.recentSessions")}</h2>
							<span className="mla-small mla-muted">{t("today.rail.sessionCount", { count: visibleSessions.length })}</span>
						</div>
						{sessionsLoading && recentSessions.length === 0 ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>{t("today.rail.sessionsLoading")}</p>
						) : recentSessions.length === 0 ? (
							<div className="mla-empty">
								<BookOpen size={24} aria-hidden="true" />
								<strong>{t("today.rail.noSessionTitle")}</strong>
								<p className="mla-small" style={{ margin: 0 }}>{t("today.rail.noSessionHint")}</p>
							</div>
						) : (
							<div className="mla-stack" style={{ gap: 4 }}>
								{recentSessions.map((session) => (
									<button
										type="button"
										key={session.id}
										className="mla-session-item"
										onClick={() => openSession(session.id)}
									>
										<strong style={{ fontWeight: 500 }}>{session.name || t("today.rail.untitledSession")}</strong>
										<span>{session.preview || t("today.rail.messageCount", { count: session.messageCount })}</span>
									</button>
								))}
							</div>
						)}
						<Button onClick={() => navigate("learn", { history: "push" })}>
							{t("today.rail.goLearn")}
							<ArrowRight size={16} />
						</Button>
					</section>

					{profileError ? (
						<section className="mla-card">
							<h2>{t("today.rail.profileUnavailable")}</h2>
							<p className="mla-small mla-muted" style={{ margin: 0 }}>{profileError}</p>
						</section>
					) : (
						<section className="mla-card">
							<h2>{t("today.rail.aboutTitle")}</h2>
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{t("today.rail.aboutBody")}
							</p>
						</section>
					)}
				</aside>
			</div>

			<CreateCourseDialog
				open={createOpen}
				pending={courseState.pendingAction === "create_course"}
				error={courseState.feedback?.tone === "error" ? courseState.feedback.message : null}
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
