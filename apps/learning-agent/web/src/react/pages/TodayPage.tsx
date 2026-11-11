import { useEffect, useMemo, useState } from "react";
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

const ACTION_LABELS: Record<LearningRecommendation["action"], string> = {
	learn: "学习与澄清",
	review: "到期复习",
	practice: "巩固练习",
	diagnose: "补充诊断",
	transfer: "迁移检验",
};

const KIND_LABELS: Record<NonNullable<LearningRecommendation["suggested_kind"]>, string> = {
	free_recall: "自由回忆",
	application: "应用题",
	transfer: "迁移题",
};

const RESULT_LABELS: Record<NonNullable<LearningRecommendation["evidence_basis"]["last_result"]>, string> = {
	correct: "最近一次答对",
	partial: "最近一次部分答对",
	incorrect: "最近一次答错",
	unknown: "最近一次无法判定",
};

/** Machine-readable basis, rendered as small facts — never as a mastery claim. */
function basisFacts(item: LearningRecommendation): string[] {
	const basis = item.evidence_basis;
	const facts: string[] = [];
	if (basis.has_active_misconception) facts.push("存在活跃误区记录");
	if (basis.review_due_at) facts.push(`复习时间 ${formatDate(basis.review_due_at) || "已到"}`);
	facts.push(`可追溯证据 ${basis.evidence_count} 条`);
	if (basis.last_result) facts.push(RESULT_LABELS[basis.last_result]);
	if (basis.exposure_only) facts.push("仅有接触记录");
	if (basis.provenance_limited) facts.push("来源受限，仅供谨慎参考");
	return facts;
}

export function TodayPage() {
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
	// 「系统设置 → 归档课程」 with their plans, tasks and records intact.
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
					<h1>今日学习</h1>
					<p>按课程安排今天的任务，从上次停下的地方继续。</p>
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
								<h2 id="today-courses">我的课程</h2>
								<span className="mla-small mla-muted">
									每门课程有独立的目标、教材、计划与学习记录
								</span>
							</div>
							<div className="mla-toolbar">
								<Button size="xs" variant="primary" onClick={() => setCreateOpen(true)}>
									<Plus size={14} />
									创建课程
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
								正在读取课程…
							</p>
						) : courseState.coursesError ? (
							<div>
								<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
									{courseState.coursesError}
								</p>
								<Button size="xs" style={{ marginTop: 8 }} onClick={() => void coursesStore.loadCourses()}>
									重试
								</Button>
							</div>
						) : visibleCourses.length === 0 ? (
							<div className="mla-empty">
								<BookOpen size={26} aria-hidden="true" />
								<strong>{archivedCourseCount > 0 ? "课程都在归档中" : "还没有课程"}</strong>
								<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
									{archivedCourseCount > 0
										? "归档的课程不会出现在今日学习。可前往「系统设置 → 归档课程」查看记录或恢复课程。"
										: "创建第一门课程，然后设置学习目标、上传教材，让 AI 生成学习计划。之后每天的任务都会出现在这里。"}
								</p>
								{archivedCourseCount > 0 ? (
									<Button onClick={() => navigate("settings", { history: "push", settingsTab: "archived-courses" })}>
										<Archive size={14} />
										查看归档课程
									</Button>
								) : (
									<Button variant="primary" onClick={() => setCreateOpen(true)}>
										<Plus size={14} />
										创建课程
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
							<h2 id="today-tasks">今日跨课程任务</h2>
							<span className="mla-small mla-muted">
								{courseState.daily
									? `共 ${courseState.daily.courses.length} 门课程 · 预计 ${courseState.daily.total_planned_minutes} 分钟`
									: "按课程计划与到期复习汇总"}
							</span>
						</div>
						{courseState.dailyLoading && !courseState.daily ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								正在汇总今日任务…
							</p>
						) : courseState.dailyError ? (
							<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
								{courseState.dailyError}
							</p>
						) : (courseState.daily?.courses.length ?? 0) === 0 ? (
							<div className="mla-empty">
								<CalendarClock size={26} aria-hidden="true" />
								<strong>今天还没有课程安排</strong>
								<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
									进行中的课程会在启用学习计划后自动出现在这里。已暂停或已归档的课程不会进入每日推荐。
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
												{course.plan ? `${course.plan.title} · 每日 ${course.daily_minutes} 分钟` : `每日 ${course.daily_minutes} 分钟`}
											</span>
										</div>
										{course.items.length === 0 ? (
											<p className="mla-small mla-muted" style={{ margin: "6px 0 0" }}>
												{course.status === "no_active_plan"
													? "还没有启用中的学习计划，去课程详情制定计划。"
													: course.status === "empty_plan"
														? "当前计划还没有任务。"
														: "当前计划的全部任务都已完成。"}
											</p>
										) : (
											<div className="mla-state-list" style={{ marginTop: 6 }}>
												{course.items.map((item) => item.kind === "task" ? (
													<div className="mla-state-row" key={`task:${item.task_id}`}>
														<div>
															<div className="mla-inline" style={{ flexWrap: "wrap" }}>
																<strong>{item.title}</strong>
																<span className={`mla-badge${item.reason_code === "in_progress" ? " mla-badge--accent" : ""}`}>
																	{item.reason_code === "in_progress" ? "进行中" : item.reason_code === "over_budget" ? "超出今日预算" : "下一项"}
																</span>
																{item.stage_title ? <span className="mla-badge">{item.stage_title}</span> : null}
															</div>
															<p>{item.reason}</p>
														</div>
														<Button
															disabled={courseBusy}
															onClick={() => void startCourseLearning(course.course_id, item.task_id)}
														>
															{item.reason_code === "in_progress" ? "继续学习" : "开始学习"}
														</Button>
													</div>
												) : (
													<div className="mla-state-row" key={`review:${item.concept_id}`}>
														<div>
															<div className="mla-inline" style={{ flexWrap: "wrap" }}>
																<strong>{item.name_available && item.concept_name ? item.concept_name : "知识点名称待确认"}</strong>
																<span className="mla-badge mla-badge--warning">到期复习</span>
																<span className="mla-badge">{course.course_title}</span>
															</div>
															<p>{item.reason}</p>
														</div>
														<Button onClick={() => startReview(item.concept_id)}>开始复习</Button>
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
							<h2 id="today-recommendations">下一步学习建议</h2>
							<span className="mla-small mla-muted">根据学习档案中的真实证据生成，最多 3 条</span>
						</div>
						{recommendationsLoading || (!recommendations && !recommendationsError) ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Lightbulb size={14} aria-hidden="true" />
								正在根据学习档案生成建议…
							</p>
						) : recommendationsError ? (
							<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
								{recommendationsError}
							</p>
						) : nextActions.length === 0 ? (
							<div className="mla-empty">
								<Lightbulb size={26} aria-hidden="true" />
								<strong>暂时没有个性化建议</strong>
								<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
									目前没有足够的可靠学习记录来生成个性化建议。可以先完成一次练习，系统会根据实际表现逐渐调整建议。
								</p>
							</div>
						) : (
							<div className="mla-state-list">
								{nextActions.map((item) => (
									<div className="mla-state-row" key={item.concept_id}>
										<div>
											<div className="mla-inline" style={{ flexWrap: "wrap" }}>
												<strong>{item.name_available && item.concept_name ? item.concept_name : "知识点名称待确认"}</strong>
												<span className="mla-badge mla-badge--accent">{ACTION_LABELS[item.action]}</span>
												{item.suggested_kind ? (
													<span className="mla-badge">建议题型：{KIND_LABELS[item.suggested_kind]}</span>
												) : null}
											</div>
											<p>{item.reason}</p>
											<div className="mla-inline mla-small mla-muted" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
												{basisFacts(item).map((fact) => (
													<span key={fact}>{fact}</span>
												))}
											</div>
											{!item.name_available ? (
												<p>知识点名称无法可靠显示，去练习时需要重新确认主题。</p>
											) : null}
										</div>
										<Button onClick={() => openRecommendation(item)}>
											{item.action === "learn" ? "前往 AI 学习" : item.action === "review" ? "开始复习" : "前往练习页"}
										</Button>
									</div>
								))}
							</div>
						)}
					</section>

					<section className="mla-card" aria-labelledby="today-review">
						<div className="mla-card-header">
							<h2 id="today-review">到期复习</h2>
							<span className="mla-small mla-muted">来自知识掌握状态中的复习时间</span>
						</div>
						{dueReviews.length === 0 ? (
							<div className="mla-empty">
								<CalendarClock size={26} aria-hidden="true" />
								<strong>暂无到期复习</strong>
								<p className="mla-small" style={{ margin: 0 }}>
									只有产生过真实学习证据、并记录了复习时间的知识点才会出现在这里。
								</p>
							</div>
						) : (
							<div className="mla-state-list">
								{dueReviews.map((state) => (
									<div className="mla-state-row" key={state.concept_id}>
										<div>
											<div className="mla-inline">
												<strong>{state.concept_name}</strong>
												<span className="mla-badge mla-badge--warning">到期复习</span>
											</div>
											<p>{state.diagnosis || "尚无诊断说明"}</p>
										</div>
										<div className="mla-stack" style={{ gap: 6, justifyItems: "end" }}>
											<span className="mla-small mla-muted">应复习 {formatDate(state.review_due_at)}</span>
											<Button onClick={() => startReview(state.concept_id)}>开始复习</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</section>
				</div>

				<aside className="mla-rail" aria-label="最近学习">
					<section className="mla-card">
						<div className="mla-card-header">
							<h2>当前学习目标</h2>
							{activeGoals[0] ? <span className="mla-badge mla-badge--accent">进行中</span> : null}
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
									{activeGoals.length > 1 ? `另有 ${activeGoals.length - 1} 个进行中的目标` : "目标来自你的学习档案"}
								</span>
								<Button onClick={() => navigate("profile", { history: "push" })}>查看完整目标</Button>
							</div>
						) : (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{profileLoading ? "正在读取学习档案…" : "还没有进行中的学习目标。可以在课程详情里关联或新建目标。"}
							</p>
						)}
					</section>

					<section className="mla-card">
						<div className="mla-card-header">
							<h2>最近学习</h2>
							<span className="mla-small mla-muted">{visibleSessions.length} 个会话</span>
						</div>
						{sessionsLoading && recentSessions.length === 0 ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>正在读取学习会话…</p>
						) : recentSessions.length === 0 ? (
							<div className="mla-empty">
								<BookOpen size={24} aria-hidden="true" />
								<strong>还没有学习对话</strong>
								<p className="mla-small" style={{ margin: 0 }}>在「AI 学习」里提出第一个问题。</p>
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
										<strong style={{ fontWeight: 500 }}>{session.name || "未命名对话"}</strong>
										<span>{session.preview || `${session.messageCount} 条消息`}</span>
									</button>
								))}
							</div>
						)}
						<Button onClick={() => navigate("learn", { history: "push" })}>
							进入 AI 学习
							<ArrowRight size={16} />
						</Button>
					</section>

					{profileError ? (
						<section className="mla-card">
							<h2>学习档案暂不可用</h2>
							<p className="mla-small mla-muted" style={{ margin: 0 }}>{profileError}</p>
						</section>
					) : (
						<section className="mla-card">
							<h2>这些数字从哪来</h2>
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								课程任务、进度与复习时间都由服务端根据课程计划和真实学习证据计算。没有证据的知识点会显示为「证据不足」，而不是自动判定为已掌握。
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
