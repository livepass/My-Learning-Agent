import { useEffect, useMemo } from "react";
import { ArrowRight, BookOpen, CalendarClock, Lightbulb, Target } from "lucide-react";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";
import { isActionableReviewDue } from "../../utils/review-eligibility.js";
import type { LearningRecommendation } from "../../types/learner.js";

/**
 * 今日学习 — real, existing data only.
 *
 * Active goals come from the L1 profile, due reviews from `review_due_at` on
 * knowledge states, and recent sessions from the session list. Nothing here
 * invents study statistics or recommendations: when a section has no real
 * data it renders an explicit empty state.
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

	useEffect(() => {
		void learnerStore.load();
		void learnerStore.loadRecommendations();
		void sessionsStore.load();
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

	const recentSessions = useMemo(
		() => sessions.filter((session) => !session.archived).slice(0, 5),
		[sessions],
	);

	const today = new Date();

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
					<p>欢迎回来，从上次停下的地方继续。</p>
				</div>
				<div className="mla-page-meta">
					{today.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}
					<br />
					{today.toLocaleDateString("zh-CN", { weekday: "long" })}
				</div>
			</div>

			<div className="mla-split">
				<div className="mla-stack-lg">
					<section className="mla-hero" aria-labelledby="today-goal">
						<div className="mla-inline">
							<span className="mla-hero-identity">
								<Target size={16} aria-hidden="true" />
								<span id="today-goal">当前学习目标</span>
							</span>
							{activeGoals[0] ? <span className="mla-badge mla-badge--accent">进行中</span> : null}
						</div>
						{activeGoals[0] ? (
							<>
								<h2>{activeGoals[0].title}</h2>
								{activeGoals[0].success_criteria.length > 0 ? (
									<div>
										<span className="mla-overline">完成标准</span>
										<ul className="mla-list" style={{ marginTop: 8 }}>
											{activeGoals[0].success_criteria.map((item) => (
												<li key={item}>
													<Target size={14} aria-hidden="true" />
													<span>{item}</span>
												</li>
											))}
										</ul>
									</div>
								) : null}
								<div className="mla-hero-footer">
									<span className="mla-small mla-muted">
										{activeGoals.length > 1 ? `另有 ${activeGoals.length - 1} 个进行中的目标` : "目标来自你的学习档案"}
									</span>
									<div className="mla-inline">
										<Button variant="primary" onClick={() => navigate("learn", { history: "push" })}>
											继续学习
											<ArrowRight size={16} />
										</Button>
										<Button onClick={() => navigate("profile", { history: "push" })}>查看完整目标</Button>
									</div>
								</div>
							</>
						) : (
							<div className="mla-stack">
								<p className="mla-text mla-muted" style={{ margin: 0 }}>
									{profileLoading ? "正在读取学习档案…" : "还没有进行中的学习目标。开始一段对话后，学习助手会随着你的实际学习记录生成目标。"}
								</p>
								<div className="mla-inline">
									<Button variant="primary" onClick={() => navigate("learn", { history: "push" })}>
										开始学习
										<ArrowRight size={16} />
									</Button>
									<Button onClick={() => navigate("profile", { history: "push" })}>打开学习档案</Button>
								</div>
							</div>
						)}
					</section>

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
							<h2>最近学习</h2>
							<span className="mla-small mla-muted">{sessions.length} 个会话</span>
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
								目标、掌握状态与复习时间都来自本机的学习档案和真实证据记录。没有证据的知识点会显示为「证据不足」，而不是自动判定为已掌握。
							</p>
						</section>
					)}
				</aside>
			</div>
		</>
	);
}
