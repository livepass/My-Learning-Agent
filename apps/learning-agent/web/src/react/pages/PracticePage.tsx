import { useEffect, useMemo, useState } from "react";
import { CircleDashed, GraduationCap, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { learningStore } from "../../stores/learning-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, inputCls } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";
import type { PublicLearningQuestion } from "../../api/learning.js";

/**
 * 练习与反馈 — C1 出题、C2 作答与评分、C3 证据记录、C4 连续出题。
 *
 * The server owns knowledge selection, provenance, question ids and the model
 * identity; this page only collects the concept, asks for a question and shows
 * the public result. A question is "current" only while the checkpoint is at
 * `awaiting_answer`: after C3 the checkpoint moves to `feedback` and the same
 * question ref is history, not something still waiting for an answer.
 */
export function PracticePage() {
	const { currentSessionId } = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
	}));
	const learning = useStoreSnapshot(learningStore, () => ({
		sessionId: learningStore.sessionId,
		state: learningStore.state,
		isLoading: learningStore.isLoading,
		isSaving: learningStore.isSaving,
		isGenerating: learningStore.isGenerating,
		generateError: learningStore.generateError,
		isSubmitting: learningStore.isSubmitting,
		submitError: learningStore.submitError,
		isEvaluating: learningStore.isEvaluating,
		evaluateError: learningStore.evaluateError,
		isFinalizing: learningStore.isFinalizing,
		finalizeError: learningStore.finalizeError,
		assessment: learningStore.assessment,
		currentAttempt: learningStore.currentAttempt,
	}));
	const { profile } = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));

	const isCurrentSession = Boolean(currentSessionId && learning.sessionId === currentSessionId);
	const currentAttempt = isCurrentSession ? learning.currentAttempt : undefined;

	const [concept, setConcept] = useState("");
	const [conceptId, setConceptId] = useState<string | undefined>(undefined);
	const [goalId, setGoalId] = useState("");
	const [kind, setKind] = useState<PublicLearningQuestion["kind"] | "">("");
	const [allowModelFallback, setAllowModelFallback] = useState(true);
	const [nextQuestionOpen, setNextQuestionOpen] = useState(false);
	// Unsubmitted drafts are keyed by session *and question identity*: a draft for
	// question A must never appear in question B, and continuing to B must not be
	// overwritten by A1's saved answer.
	const [draftsByQuestion, setDraftsByQuestion] = useState<Record<string, string>>({});
	const stateCheckpoint = isCurrentSession ? learning.state?.checkpoint : undefined;
	const draftKey = currentSessionId && stateCheckpoint?.question
		? `${currentSessionId}::${stateCheckpoint.question.question_id}::${stateCheckpoint.question.question_version}`
		: null;
	const currentDraft = draftKey ? (draftsByQuestion[draftKey] ?? "") : "";
	// Already submitted / loaded attempt displays the server's durable answer verbatim.
	const displayedAnswer = currentAttempt ? currentAttempt.answer : currentDraft;

	const onAnswerChange = (value: string) => {
		if (draftKey) {
			setDraftsByQuestion((prev) => ({ ...prev, [draftKey]: value }));
		}
	};

	useEffect(() => {
		if (currentSessionId) void learningStore.load(currentSessionId);
	}, [currentSessionId]);

	useEffect(() => {
		void learnerStore.load();
	}, []);

	const checkpoint = stateCheckpoint;
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
	const hasQuestion = Boolean(checkpoint?.question);
	// Only `awaiting_answer` means the current question really waits for an answer.
	// At `feedback` the same question ref is history: its attempt is completed.
	const isAwaitingAnswer = checkpoint?.step === "awaiting_answer" && hasQuestion;
	/**
	 * Where a new question may come from, mirroring the server's pure
	 * `canCommitNextQuestion`: a fresh conversation, or a fully recorded feedback
	 * state with the completed attempt named. A form is never offered in between.
	 */
	const generationMode: "initial" | "continuation" | null = !currentSessionId || !hasRecord || !checkpoint
		? null
		: checkpoint.status !== "active" || checkpoint.pending_attempt_id ? null
			: checkpoint.step === "conversation" && !checkpoint.question ? "initial"
				: checkpoint.step === "feedback" && checkpoint.question && checkpoint.last_completed_attempt_id ? "continuation"
					: null;
	const canGenerate = Boolean(currentSessionId) && generationMode !== null && !learning.isGenerating;

	const onConceptChange = (value: string) => {
		setConcept(value);
		const matched = concepts.find((item) => item.concept_name === value.trim());
		setConceptId(matched?.concept_id);
	};

	const generate = async () => {
		const label = concept.trim();
		if (!label || !canGenerate) return;
		const ok = await learningStore.generate({
			concept: label,
			...(conceptId ? { concept_id: conceptId } : {}),
			...(goalId ? { goal_id: goalId } : {}),
			...(kind ? { kind } : {}),
			allow_model_fallback: allowModelFallback,
			// Only a continuation names the attempt it follows; the server verifies
			// it independently, so this is a binding, not a claim of completion.
			...(generationMode === "continuation" && checkpoint?.last_completed_attempt_id
				? { after_attempt_id: checkpoint.last_completed_attempt_id }
				: {}),
		});
		if (ok) setNextQuestionOpen(false);
	};

	/**
	 * Open the continuation form, suggesting the same concept when the profile has
	 * a trusted label for it. Without one the field stays empty on purpose: the
	 * page must not invent a concept name from an id.
	 */
	const openNextQuestion = () => {
		if (!concept.trim()) {
			const matched = concepts.find((item) => item.concept_id === question?.concept_id);
			if (matched) {
				setConcept(matched.concept_name);
				setConceptId(matched.concept_id);
			}
		}
		setNextQuestionOpen(true);
	};

	const sourceLabel = checkpoint?.knowledge
		? checkpoint.knowledge.kind === "model_knowledge" ? "模型知识" : "L2 学习资料"
		: null;

	const hasPendingAttempt = Boolean(checkpoint?.pending_attempt_id);
	// The durable attempt stage, not a local flag: this is what decides whether
	// the page shows "开始评分 / 评分中 / 重新评分 / 已评分".
	const attemptStage = currentAttempt?.stage;
	const attemptFailed = attemptStage === "evaluation_failed";
	const attemptEvaluated = attemptStage === "evaluated" || attemptStage === "evidence_recorded"
		|| attemptStage === "profile_projected";
	const attemptCompleted = attemptStage === "completed";
	const attemptScored = attemptEvaluated || attemptCompleted;
	const attemptRetryable = Boolean(currentAttempt?.retryable);
	// `currentAttempt` is already scoped to the current question; last_completed is
	// deliberately not consulted, or a new question would look answered.
	const hasAttempt = hasPendingAttempt || Boolean(currentAttempt);

	const submit = async () => {
		if (!currentDraft.trim() || !isAwaitingAnswer || hasAttempt) return;
		const ok = await learningStore.submitAnswer(currentDraft);
		if (ok && draftKey) {
			setDraftsByQuestion((prev) => {
				const next = { ...prev };
				delete next[draftKey];
				return next;
			});
		}
	};
	const evaluate = () => {
		if (!hasPendingAttempt) return;
		void learningStore.evaluateAnswer(attemptFailed);
	};
	const finalize = async () => {
		if (!currentAttempt) return;
		const ok = await learningStore.finalizeAttempt();
		if (ok) {
			void learnerStore.load();
		}
	};

	// Prefer the persisted assessment from the attempt view; fall back to the
	// response-scoped assessment while a re-read is still in flight.
	const shownAssessment = isCurrentSession ? (currentAttempt?.assessment ?? learning.assessment) : null;
	const resultLabel = shownAssessment?.result
		? shownAssessment.result === "correct" ? "答对"
			: shownAssessment.result === "partial" ? "部分答对"
				: shownAssessment.result === "incorrect" ? "答错"
					: "无法判定"
		: null;

	/**
	 * The one generation form, shared by the first question and "再练一道".
	 *
	 * Everything is chosen explicitly before the request is sent: a concept (prefilled
	 * only from a trusted profile label), an optional goal, an optional kind. The
	 * primary action stays disabled while the concept is empty.
	 */
	const generatorForm = (options: { conceptInputId: string; actionLabel: string; onCancel?: () => void }) => (
		<div className="mla-stack" style={{ gap: 14 }}>
			<div className="mla-stack" style={{ gap: 10 }}>
				<label className="mla-small" htmlFor={options.conceptInputId}>知识点</label>
				<input
					id={options.conceptInputId}
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
					<label className="mla-small" htmlFor={`${options.conceptInputId}-goal`}>关联学习目标（可选）</label>
					<select
						id={`${options.conceptInputId}-goal`}
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

			<div className="mla-stack" style={{ gap: 10 }}>
				<label className="mla-small" htmlFor={`${options.conceptInputId}-kind`}>题型</label>
				<select
					id={`${options.conceptInputId}-kind`}
					className={inputCls}
					value={kind}
					onChange={(event) => setKind(event.target.value as PublicLearningQuestion["kind"] | "")}
					disabled={learning.isGenerating}
				>
					<option value="">由系统决定</option>
					<option value="free_recall">自由回忆</option>
					<option value="application">应用</option>
					<option value="transfer">迁移</option>
				</select>
			</div>

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
					onClick={() => void generate()}
				>
					{learning.isGenerating ? <Loader2 size={14} className="mla-spin" /> : <Sparkles size={14} />}
					{learning.isGenerating ? "正在生成…" : options.actionLabel}
				</Button>
				{options.onCancel ? (
					<Button onClick={options.onCancel} disabled={learning.isGenerating}>取消</Button>
				) : null}
				<span className="mla-small mla-muted">
					{generationMode === "continuation"
						? "新题目会接在上一题之后，历史题目与评分保持不变。"
						: "生成一次只出一道题。"}
				</span>
			</div>

			{learning.generateError ? (
				<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
					{learning.generateError}
				</p>
			) : null}
		</div>
	);

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

								{generatorForm({ conceptInputId: "practice-concept", actionLabel: "生成练习题" })}
							</div>
						)}
					</section>

					<section className="mla-card" aria-labelledby="practice-answer">
						<div className="mla-card-header">
							<h2 id="practice-answer">我的作答</h2>
							{resultLabel ? <span className="mla-badge mla-badge--accent">{resultLabel}</span> : null}
						</div>

						{!hasQuestion ? (
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
									value={displayedAnswer}
									onChange={(event) => onAnswerChange(event.target.value)}
									disabled={hasAttempt || learning.isSubmitting || learning.isEvaluating}
								/>

								{!hasAttempt ? (
									<div className="mla-inline">
										<Button
											variant="primary"
											disabled={!currentDraft.trim() || learning.isSubmitting}
											onClick={() => void submit()}
										>
											{learning.isSubmitting ? <Loader2 size={14} className="mla-spin" /> : <Sparkles size={14} />}
											{learning.isSubmitting ? "正在保存…" : "提交作答"}
										</Button>
									</div>
								) : attemptCompleted ? (
									<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
										<span className="mla-badge mla-badge--accent">本题已记录</span>
										<span className="mla-small mla-muted">已将正式证据纳入学习档案。</span>
										<Button onClick={() => navigate("profile", { history: "push" })}>
											查看我的学习档案
										</Button>
									</div>
								) : attemptEvaluated ? (
									<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
										<span className="mla-small mla-muted">已评分。</span>
										<Button
											variant="primary"
											disabled={learning.isFinalizing}
											onClick={finalize}
										>
											{learning.isFinalizing ? <Loader2 size={14} className="mla-spin" /> : <GraduationCap size={14} />}
											{learning.isFinalizing ? "正在记录…" : "记录本次学习结果"}
										</Button>
										<span className="mla-small mla-muted">
											将评分与作答依据转化为学习档案证据，更新对应知识点状态。
										</span>
									</div>
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
								{learning.finalizeError ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										{learning.finalizeError}
									</p>
								) : null}

								{currentAttempt?.failure && !attemptScored ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										评分失败：{currentAttempt.failure.message}
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

					{generationMode === "continuation" ? (
						<section className="mla-card" aria-labelledby="practice-next">
							<div className="mla-card-header">
								<h2 id="practice-next">继续练习</h2>
								<span className="mla-badge">同一会话</span>
							</div>
							{nextQuestionOpen ? (
								generatorForm({
									conceptInputId: "practice-next-concept",
									actionLabel: "生成下一题",
									onCancel: () => setNextQuestionOpen(false),
								})
							) : (
								<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
									<Button variant="primary" disabled={learning.isGenerating} onClick={openNextQuestion}>
										<Sparkles size={14} />
										再练一道
									</Button>
									<span className="mla-small mla-muted">
										默认继续同一知识点；下一步可以修改知识点、题型与学习目标。
									</span>
								</div>
							)}
						</section>
					) : null}

					<section className="mla-card" aria-labelledby="practice-feedback">
						<div className="mla-card-header">
							<h2 id="practice-feedback">反馈与证据</h2>
							{attemptCompleted ? (
								<span className="mla-badge mla-badge--accent">已记录</span>
							) : attemptEvaluated ? (
								<span className="mla-badge">待记录</span>
							) : (
								<span className="mla-badge">练习中</span>
							)}
						</div>
						<ul className="mla-list">
							{attemptCompleted ? (
								<>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>本题作答已转化为正式学习证据，对应知识点的掌握度已根据评分与提示折扣完成投影。</span>
									</li>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>可随时前往「我的学习档案」查看长期掌握状态与复习间隔。</span>
									</li>
								</>
							) : (
								<>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>评分完成并查看反馈后，可点击「记录本次学习结果」将作答转化为学习档案证据。</span>
									</li>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>提示使用情况会被如实记录；未作答、跳过与评估失败都不会被计为答错。</span>
									</li>
								</>
							)}
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
