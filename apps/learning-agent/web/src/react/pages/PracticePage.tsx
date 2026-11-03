import { useEffect, useMemo, useState } from "react";
import { CircleDashed, GraduationCap, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { learningStore } from "../../stores/learning-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, inputCls } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";

/**
 * 练习与反馈 — C1: one generated question at a time.
 *
 * The server owns knowledge selection, provenance, question ids and the model
 * identity; this page only collects the concept, asks for a question and shows
 * the public result. Answering and scoring remain C2 and are still placeholders
 * — nothing here fabricates a score or a learning-progress claim.
 */
export function PracticePage() {
	const { currentSessionId } = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
	}));
	const learning = useStoreSnapshot(learningStore, () => ({
		state: learningStore.state,
		isLoading: learningStore.isLoading,
		isSaving: learningStore.isSaving,
		isGenerating: learningStore.isGenerating,
		generateError: learningStore.generateError,
		isSubmitting: learningStore.isSubmitting,
		submitError: learningStore.submitError,
		isEvaluating: learningStore.isEvaluating,
		evaluateError: learningStore.evaluateError,
		assessment: learningStore.assessment,
		currentAttempt: learningStore.currentAttempt,
	}));
	const { profile } = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));

	const [concept, setConcept] = useState("");
	const [conceptId, setConceptId] = useState<string | undefined>(undefined);
	const [goalId, setGoalId] = useState("");
	const [allowModelFallback, setAllowModelFallback] = useState(true);
	const [answer, setAnswer] = useState("");

	useEffect(() => {
		if (currentSessionId) void learningStore.load(currentSessionId);
	}, [currentSessionId]);

	useEffect(() => {
		void learnerStore.load();
	}, []);

	const checkpoint = learning.state?.checkpoint;
	const question = checkpoint?.question
		? learning.state?.questions?.find(
			(item) =>
				item.question_id === checkpoint.question!.question_id &&
				item.question_version === checkpoint.question!.question_version,
		)
		: undefined;

	const concepts = useMemo(() => profile?.knowledge_states ?? [], [profile]);
	const goals = useMemo(
		() => (profile?.goals ?? []).filter((goal) => goal.status === "active"),
		[profile],
	);

	const hasRecord = learning.state?.exists === true;
	const hasPendingQuestion = Boolean(checkpoint?.question);
	const canGenerate = Boolean(currentSessionId) && hasRecord && !hasPendingQuestion && !learning.isGenerating;

	const onConceptChange = (value: string) => {
		setConcept(value);
		const matched = concepts.find((item) => item.concept_name === value.trim());
		setConceptId(matched?.concept_id);
	};

	const generate = () => {
		const label = concept.trim();
		if (!label || !canGenerate) return;
		void learningStore.generate({
			concept: label,
			...(conceptId ? { concept_id: conceptId } : {}),
			...(goalId ? { goal_id: goalId } : {}),
			allow_model_fallback: allowModelFallback,
		});
	};

	const sourceLabel = checkpoint?.knowledge
		? checkpoint.knowledge.kind === "model_knowledge" ? "模型知识" : "L2 学习资料"
		: null;

	const hasPendingAttempt = Boolean(checkpoint?.pending_attempt_id);
	// The durable attempt stage, not a local flag: this is what decides whether
	// the page shows "开始评分 / 评分中 / 重新评分 / 已评分".
	const attemptStage = learning.currentAttempt?.stage;
	const attemptFailed = attemptStage === "evaluation_failed";
	const attemptScored = attemptStage === "evaluated" || attemptStage === "evidence_recorded"
		|| attemptStage === "profile_projected" || attemptStage === "completed";
	const attemptRetryable = Boolean(learning.currentAttempt?.retryable);

	const submit = () => {
		if (!answer.trim() || !hasPendingQuestion || hasPendingAttempt) return;
		void learningStore.submitAnswer(answer);
	};
	const evaluate = () => {
		if (!hasPendingAttempt) return;
		void learningStore.evaluateAnswer(attemptFailed);
	};

	// Prefer the persisted assessment from the attempt view; fall back to the
	// response-scoped assessment while a re-read is still in flight.
	const shownAssessment = learning.currentAttempt?.assessment ?? learning.assessment;
	const resultLabel = shownAssessment?.result
		? shownAssessment.result === "correct" ? "答对"
			: shownAssessment.result === "partial" ? "部分答对"
				: shownAssessment.result === "incorrect" ? "答错"
					: "无法判定"
		: null;

	return (
		<>
			<div className="mla-page-head">
				<div>
					<h1>练习与反馈</h1>
					<p>把「看懂了」，变成一次能独立完成的回答。</p>
				</div>
				<div className="mla-page-meta">
					<Button onClick={() => navigate("learn", { history: "push" })}>返回 AI 学习</Button>
				</div>
			</div>

			<div className="mla-split">
				<div className="mla-stack">
					<section className="mla-card" aria-labelledby="practice-question">
						<div className="mla-card-header">
							<h2 id="practice-question">当前题目</h2>
							{sourceLabel ? <span className="mla-badge mla-badge--accent">{sourceLabel}</span> : null}
						</div>

						{!currentSessionId ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								先打开或新建一段学习会话，再回到这里出题。
							</p>
						) : learning.isLoading && !learning.state ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								正在读取学习状态…
							</p>
						) : !hasRecord ? (
							<div className="mla-stack" style={{ gap: 10 }}>
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									这段会话还没有学习检查点。出题需要先建立学习记录；系统不会在读取时自动创建。
								</p>
								<Button
									variant="primary"
									disabled={learning.isSaving}
									onClick={() => void learningStore.init()}
								>
									初始化学习记录
								</Button>
							</div>
						) : question ? (
							<div className="mla-stack" style={{ gap: 10 }}>
								<p className="mla-text" style={{ margin: 0 }}>{question.prompt}</p>
								<span className="mla-small mla-muted">
									题号 {question.question_id} · 版本 {question.question_version} · 修订 #{checkpoint?.revision}
								</span>
							</div>
						) : (
							<div className="mla-stack" style={{ gap: 14 }}>
								<div className="mla-empty" style={{ padding: "8px 0" }}>
									<GraduationCap size={30} aria-hidden="true" />
									<strong>还没有待作答的题目</strong>
									<p className="mla-small" style={{ margin: 0, maxWidth: 420 }}>
										告诉系统你想练哪个知识点，它会选好知识依据并生成一道题。生成后会立即保存，刷新或重启都能回到同一道题。
									</p>
								</div>

								<div className="mla-stack" style={{ gap: 10 }}>
									<label className="mla-small" htmlFor="practice-concept">知识点</label>
									<input
										id="practice-concept"
										className={inputCls}
										list="practice-concept-options"
										placeholder="例如：Python 闭包"
										value={concept}
										maxLength={120}
										onChange={(event) => onConceptChange(event.target.value)}
										disabled={learning.isGenerating}
									/>
									<datalist id="practice-concept-options">
										{concepts.map((item) => (
											<option key={item.concept_id} value={item.concept_name} />
										))}
									</datalist>
									<span className="mla-small mla-muted">
										从学习档案里选一个已有知识点，出题会复用同一个知识点标识。
									</span>
								</div>

								{goals.length > 0 ? (
									<div className="mla-stack" style={{ gap: 10 }}>
										<label className="mla-small" htmlFor="practice-goal">关联学习目标（可选）</label>
										<select
											id="practice-goal"
											className={inputCls}
											value={goalId}
											onChange={(event) => setGoalId(event.target.value)}
											disabled={learning.isGenerating}
										>
											<option value="">不关联</option>
											{goals.map((goal) => (
												<option key={goal.goal_id} value={goal.goal_id}>{goal.title}</option>
											))}
										</select>
									</div>
								) : null}

								<label className="mla-small mla-inline" style={{ gap: 8, cursor: "pointer" }}>
									<input
										type="checkbox"
										checked={allowModelFallback}
										onChange={(event) => setAllowModelFallback(event.target.checked)}
										disabled={learning.isGenerating}
									/>
									没有可用资料时，允许使用模型知识出题
								</label>

								<div className="mla-inline">
									<Button
										variant="primary"
										disabled={!canGenerate || !concept.trim()}
										onClick={generate}
									>
										{learning.isGenerating ? <Loader2 size={14} className="mla-spin" /> : <Sparkles size={14} />}
										{learning.isGenerating ? "正在生成…" : "生成练习题"}
									</Button>
									<span className="mla-small mla-muted">生成一次只出一道题。</span>
								</div>

								{learning.generateError ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										{learning.generateError}
									</p>
								) : null}
							</div>
						)}
					</section>

					<section className="mla-card" aria-labelledby="practice-answer">
						<div className="mla-card-header">
							<h2 id="practice-answer">我的作答</h2>
							{resultLabel ? <span className="mla-badge mla-badge--accent">{resultLabel}</span> : null}
						</div>

						{!hasPendingQuestion ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								还没有待作答的题目。先在上面生成一道题，再回来作答。
							</p>
						) : (
							<div className="mla-stack" style={{ gap: 12 }}>
								<label className="mla-small" htmlFor="practice-answer-input">你的回答</label>
								<textarea
									id="practice-answer-input"
									className={inputCls}
									rows={5}
									placeholder="用自己的话回答题目…"
									value={answer}
									onChange={(event) => setAnswer(event.target.value)}
									disabled={hasPendingAttempt || learning.isSubmitting || learning.isEvaluating}
								/>

								{!hasPendingAttempt ? (
									<div className="mla-inline">
										<Button
											variant="primary"
											disabled={!answer.trim() || learning.isSubmitting}
											onClick={submit}
										>
											{learning.isSubmitting ? <Loader2 size={14} className="mla-spin" /> : <Sparkles size={14} />}
											{learning.isSubmitting ? "正在保存…" : "提交作答"}
										</Button>
									</div>
								) : attemptScored ? (
									<span className="mla-small mla-muted">已评分。</span>
								) : (
									<div className="mla-inline">
										<Button
											variant="primary"
											disabled={learning.isEvaluating || (attemptFailed && !attemptRetryable)}
											onClick={evaluate}
										>
											{learning.isEvaluating ? <Loader2 size={14} className="mla-spin" /> : <Lightbulb size={14} />}
											{learning.isEvaluating
												? "评分中…"
												: attemptFailed ? "重新评分" : "开始评分"}
										</Button>
										<span className="mla-small mla-muted">
											{attemptFailed
												? (attemptRetryable ? "上次评分失败，可重新评分。" : "评分重试次数已用尽。")
												: "作答已保存，等待评分。"}
										</span>
									</div>
								)}

								{learning.submitError ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										{learning.submitError}
									</p>
								) : null}
								{learning.evaluateError ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										{learning.evaluateError}
									</p>
								) : null}

								{learning.currentAttempt?.failure && !attemptScored ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										评分失败：{learning.currentAttempt.failure.message}
									</p>
								) : null}

								{shownAssessment ? (
									<div className="mla-stack" style={{ gap: 8 }}>
										<strong className="mla-small">评分反馈</strong>
										<p className="mla-text" style={{ margin: 0 }}>{shownAssessment.feedback}</p>
										{shownAssessment.unknown_reason ? (
											<p className="mla-small mla-muted" style={{ margin: 0 }}>
												无法判定的原因：{shownAssessment.unknown_reason}
											</p>
										) : null}
										{typeof shownAssessment.score === "number" ? (
											<span className="mla-small mla-muted">
												得分 {Math.round(shownAssessment.score * 100)} / 100
											</span>
										) : null}
										<ul className="mla-list">
											{shownAssessment.criteria.map((item) => (
												<li key={item.criterion_id}>
													<CircleDashed size={14} aria-hidden="true" />
													<span>{item.criterion_id}：{item.explanation}</span>
												</li>
											))}
										</ul>
									</div>
								) : null}
							</div>
						)}
					</section>

					<section className="mla-card" aria-labelledby="practice-feedback">
						<div className="mla-card-header">
							<h2 id="practice-feedback">反馈与证据</h2>
							<span className="mla-badge">待开放</span>
						</div>
						<ul className="mla-list">
							<li>
								<CircleDashed size={14} aria-hidden="true" />
								<span>评分结果与判定依据已在评分后显示；学习证据与掌握度更新属后续能力。</span>
							</li>
							<li>
								<CircleDashed size={14} aria-hidden="true" />
								<span>未作答、跳过与评估失败都不会被计为答错。</span>
							</li>
						</ul>
					</section>
				</div>

				<aside className="mla-rail" aria-label="练习说明">
					<section className="mla-card">
						<h2>这道题在验证什么</h2>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							练习会围绕当前学习目标与检查点推进：先独立作答，再理解反馈，最后记录证据并安排复习。
						</p>
					</section>
					<section className="mla-card">
						<h2>答案会保存在哪里</h2>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							参考答案、评分标准与知识依据都随题目一起保存在本机学习记录里，只在服务端使用；
							页面上只展示题目本身。
						</p>
					</section>
					<section className="mla-card">
						<h2>帮助会被如实记录</h2>
						<div className="mla-inline">
							<Lightbulb size={16} aria-hidden="true" style={{ color: "var(--inno-accent)" }} />
							<span className="mla-small mla-muted">提示后答对与无提示答对会分开记录。</span>
						</div>
					</section>
				</aside>
			</div>
		</>
	);
}
