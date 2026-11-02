import { useEffect, useMemo } from "react";
import { ArrowRight, BookOpen, CalendarClock, Target } from "lucide-react";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";

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

export function TodayPage() {
	const { profile, isLoading: profileLoading, error: profileError } = useStoreSnapshot(learnerStore, () => ({
		profile: learnerStore.profile,
		isLoading: learnerStore.isLoading,
		error: learnerStore.error,
	}));
	const { sessions, sessionsLoading } = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		sessionsLoading: sessionsStore.isLoading,
	}));

	useEffect(() => {
		void learnerStore.load();
		void sessionsStore.load();
	}, []);

	const activeGoals = useMemo(
		() => (profile?.goals ?? []).filter((goal) => goal.status === "active").sort((a, b) => b.priority - a.priority),
		[profile],
	);

	const dueReviews = useMemo(() => {
		const now = Date.now();
		return (profile?.knowledge_states ?? [])
			.filter((state) => Boolean(state.review_due_at) && Date.parse(state.review_due_at!) <= now)
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
										<span className="mla-small mla-muted">应复习 {formatDate(state.review_due_at)}</span>
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
