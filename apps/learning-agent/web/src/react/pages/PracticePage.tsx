import { useEffect, useMemo, useState } from "react";
import { CircleDashed, GraduationCap, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { learningStore } from "../../stores/learning-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, inputCls } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";
import type { PublicLearningQuestion } from "../../api/learning.js";
import { getLearningRecommendations } from "../../api/learner.js";
import type { LearningRecommendation, RecommendationSnapshot } from "../../types/learner.js";
import { looksLikeSyntheticConceptLabel, trustedConceptLabel } from "../../utils/concept-label.js";
import { reviewIntentFromLocation, type ReviewIntent } from "../../utils/review-intent.js";

/**
 * 练习与反馈 — C1 出题、C2 作答与评分、C3 证据记录、C4 连续出题与建议。
 *
 * The server owns knowledge selection, provenance, question ids and the model
 * identity; this page only collects the concept, asks for a question and shows
 * the public result. A question is "current" only while the checkpoint is at
 * `awaiting_answer`: after C3 the checkpoint moves to `feedback` and the same
 * question ref is history, not something still waiting for an answer.
 */
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

export function PracticePage() {
	const {
		currentSessionId, sessions, sessionsLoading,
	} = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
		sessions: sessionsStore.sessions,
		sessionsLoading: sessionsStore.isLoading,
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
		error: learningStore.error,
	}));
	const { profile } = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));
	const {
		conceptRecommendation, conceptRecommendationLoading, conceptRecommendationError,
	} = useStoreSnapshot(learnerStore, () => ({
		conceptRecommendation: learnerStore.conceptRecommendation,
		conceptRecommendationLoading: learnerStore.conceptRecommendationLoading,
		conceptRecommendationError: learnerStore.conceptRecommendationError,
	}));

	const isCurrentSession = Boolean(currentSessionId && learning.sessionId === currentSessionId);
	const currentAttempt = isCurrentSession ? learning.currentAttempt : undefined;

	const [concept, setConcept] = useState("");
	const [conceptId, setConceptId] = useState<string | undefined>(undefined);
	const [goalId, setGoalId] = useState("");
	const [kind, setKind] = useState<PublicLearningQuestion["kind"] | "">("");
	const [allowModelFallback, setAllowModelFallback] = useState(true);
	const [nextQuestionOpen, setNextQuestionOpen] = useState(false);
	// C4-C: review preparation. The URL names the intent; this state only mirrors
	// it for rendering and is re-read on back/forward.
	const [reviewIntent, setReviewIntent] = useState<ReviewIntent | null>(() => reviewIntentFromLocation());
	const [reviewCheck, setReviewCheck] = useState<{
		loading: boolean;
		error: string | null;
		snapshot: RecommendationSnapshot | null;
	}>({ loading: false, error: null, snapshot: null });
	const [reviewLabel, setReviewLabel] = useState("");
	const [reviewLabelConfirmed, setReviewLabelConfirmed] = useState(false);
	const [reviewKind, setReviewKind] = useState<"free_recall" | "application" | "transfer">("free_recall");
	const [reviewFallback, setReviewFallback] = useState(true);
	const [reviewGenerating, setReviewGenerating] = useState(false);
	const [reviewActionError, setReviewActionError] = useState<string | null>(null);
	const [creatingReviewSession, setCreatingReviewSession] = useState(false);
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

	// Back/forward between review entries must swap the target concept, not keep
	// the previous one. The page can stay mounted while only the query changes.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onPopState = () => setReviewIntent(reviewIntentFromLocation());
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	useEffect(() => {
		if (reviewIntent) void sessionsStore.load();
	}, [reviewIntent]);

	const checkpoint = stateCheckpoint;
	const question = checkpoint?.question
		? learning.state?.questions?.find(
			(item) =>
				item.question_id === checkpoint.question!.question_id &&
				item.question_version === checkpoint.question!.question_version,
		)
		: undefined;

	// Exact-concept advice for the question currently on screen. A concept that
	// ranks below the global Top 3 still gets its own server-side read; the store
	// ticket drops a response addressed to a question the learner already left.
	const activeConceptId = question?.concept_id;
	useEffect(() => {
		if (!currentSessionId || !activeConceptId) return;
		void learnerStore.loadConceptRecommendation(activeConceptId);
	}, [currentSessionId, activeConceptId]);

	const concepts = useMemo(() => profile?.knowledge_states ?? [], [profile]);
	const goals = useMemo(
		() => (profile?.goals ?? []).filter((goal) => goal.status === "active"),
		[profile],
	);

	// ---------------------------------------------------------------------
	// C4-C review preparation
	// ---------------------------------------------------------------------
	const reviewConceptId = reviewIntent?.conceptId ?? null;
	const reviewState = reviewConceptId
		? concepts.find((item) => item.concept_id === reviewConceptId)
		: undefined;
	const trustedReviewName = reviewConceptId
		? trustedConceptLabel(reviewConceptId, reviewState?.concept_name)
		: undefined;

	/**
	 * Re-check the due status from the real L1 profile whenever the target
	 * concept changes. The URL is only an intent: a stale link must not turn
	 * into a review task, and a read failure must be shown instead of assumed.
	 */
	useEffect(() => {
		if (!reviewConceptId) {
			setReviewCheck({ loading: false, error: null, snapshot: null });
			return;
		}
		let cancelled = false;
		setReviewCheck({ loading: true, error: null, snapshot: null });
		getLearningRecommendations(3, reviewConceptId)
			.then((snapshot) => {
				if (cancelled) return;
				if (snapshot.concept_id !== reviewConceptId) {
					setReviewCheck({ loading: false, error: "推荐结果与当前知识点不一致，请重新加载。", snapshot: null });
					return;
				}
				setReviewCheck({ loading: false, error: null, snapshot });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const status = (err as { status?: number } | undefined)?.status;
				setReviewCheck({
					loading: false,
					error: status === 503 ? "学习档案暂时不可用，无法核对复习资格。" : "无法核对复习资格，请稍后重试。",
					snapshot: null,
				});
			});
		return () => { cancelled = true; };
	}, [reviewConceptId]);

	useEffect(() => {
		if (!reviewConceptId) return;
		setReviewLabel(trustedReviewName ?? "");
		setReviewLabelConfirmed(false);
		setReviewKind("free_recall");
		setReviewActionError(null);
	}, [reviewConceptId, trustedReviewName]);

	const reviewRecommendation = reviewCheck.snapshot?.recommendations
		.find((item) => item.concept_id === reviewConceptId);
	const reviewIsDue = Boolean(reviewRecommendation && (
		reviewRecommendation.reason_code === "review_due"
		|| reviewRecommendation.also_matches.includes("review_due")
	));
	const reviewPrimaryMisconception = Boolean(reviewRecommendation
		&& reviewRecommendation.reason_code === "active_misconception"
		&& reviewRecommendation.also_matches.includes("review_due"));

	type ReviewSessionReadiness = "none" | "loading" | "unavailable" | "needs_init" | "ready" | "blocked";
	const reviewSessionReadiness: ReviewSessionReadiness = (() => {
		if (!currentSessionId) return "none";
		if (learning.error) return "unavailable";
		if (learning.sessionId !== currentSessionId || !learning.state) return "loading";
		if (!learning.state.exists) return "needs_init";
		const cp = learning.state.checkpoint;
		if (!cp) return "unavailable";
		if (cp.status === "paused" || cp.status === "completed") return "blocked";
		if (cp.pending_attempt_id) return "blocked";
		if (cp.step === "conversation" && !cp.question) return "ready";
		if (cp.step === "feedback" && cp.question && cp.last_completed_attempt_id) return "ready";
		return "blocked";
	})();
	const reviewSessionBlockedMessage = reviewSessionReadiness === "blocked"
		? "当前学习会话还有未完成的内容，请先完成，或选择其他会话开始复习。"
		: reviewSessionReadiness === "unavailable"
			? (learning.error ?? "学习记录暂时不可用，请选择其他会话。")
			: null;

	const reviewLabelValue = (trustedReviewName ?? reviewLabel).trim();
	const reviewLabelUsable = Boolean(reviewLabelValue)
		&& !looksLikeSyntheticConceptLabel(reviewLabelValue)
		&& (Boolean(trustedReviewName) || reviewLabelConfirmed);
	const reviewSessionUsable = reviewSessionReadiness === "ready" || reviewSessionReadiness === "needs_init";
	const reviewCanGenerate = Boolean(reviewConceptId)
		&& reviewIsDue
		&& !reviewCheck.loading
		&& !reviewCheck.error
		&& reviewLabelUsable
		&& reviewSessionUsable
		&& !reviewGenerating;
	// A review badge belongs to the exact question the review flow generated. A
	// pre-existing question on the same concept (or a bare deep link) is not
	// silently relabelled as a review.
	const reviewQuestionActive = Boolean(
		reviewConceptId
		&& reviewIntent?.questionId
		&& question
		&& question.concept_id === reviewConceptId
		&& question.question_id === reviewIntent.questionId,
	);
	const reviewPrepMode = Boolean(reviewIntent && !reviewQuestionActive);

	const exitReviewMode = () => {
		navigate("practice", { history: "replace", session: currentSessionId ?? null });
		setReviewIntent(null);
		setReviewActionError(null);
	};

	const chooseReviewSession = (sessionId: string) => {
		if (!sessionId) return;
		setReviewActionError(null);
		void sessionsStore.openSession(sessionId, { historyMode: "replace" });
	};

	const createReviewSession = async () => {
		setCreatingReviewSession(true);
		setReviewActionError(null);
		try {
			const id = await sessionsStore.createSessionWith();
			if (!id) setReviewActionError("创建复习会话失败，请重试。");
		} finally {
			setCreatingReviewSession(false);
		}
	};

	/**
	 * Generate the review question through the existing C1 endpoint.
	 *
	 * Due status is re-checked immediately before the model call, so a link that
	 * was valid on entry cannot silently start a review that is no longer due.
	 * The concept id is the one carried by the URL; it is never derived from the
	 * display name, so a corrected label cannot move evidence to another concept.
	 */
	const generateReviewQuestion = async () => {
		if (!reviewIntent || !reviewCanGenerate) return;
		setReviewGenerating(true);
		setReviewActionError(null);
		try {
			const snapshot = await getLearningRecommendations(3, reviewIntent.conceptId);
			if (snapshot.concept_id !== reviewIntent.conceptId) {
				throw new Error("推荐结果与当前知识点不一致，请重新加载。");
			}
			const fresh = snapshot.recommendations.find((item) => item.concept_id === reviewIntent.conceptId);
			const stillDue = Boolean(fresh && (
				fresh.reason_code === "review_due" || fresh.also_matches.includes("review_due")
			));
			if (!stillDue) {
				setReviewCheck({ loading: false, error: null, snapshot });
				setReviewActionError("该知识点目前不再显示为到期复习。请改为普通练习，或回到今日学习重新选择。");
				return;
			}

			if (!learningStore.state?.exists) {
				// Initialising the B2 record is part of this explicit generation
				// action; merely opening the page never creates one.
				await learningStore.init();
			}
			const state = learningStore.state;
			const cp = state?.checkpoint;
			if (!state?.exists || !cp) throw new Error("学习记录尚未就绪，请稍后重试。");
			if (cp.status !== "active" || cp.pending_attempt_id) {
				throw new Error("当前学习会话已变化，请重新选择会话。");
			}
			const afterAttemptId = cp.step === "feedback" ? cp.last_completed_attempt_id : undefined;
			if (cp.step === "feedback" && !afterAttemptId) {
				throw new Error("当前学习会话状态不完整，请选择其他会话。");
			}

			const ok = await learningStore.generate({
				concept: reviewLabelValue,
				concept_id: reviewIntent.conceptId,
				kind: reviewKind,
				allow_model_fallback: reviewFallback,
				...(afterAttemptId ? { after_attempt_id: afterAttemptId } : {}),
			});
			if (!ok) {
				setReviewActionError(learningStore.generateError ?? "复习题生成失败，请重试。");
				return;
			}
			const generatedId = learningStore.state?.checkpoint?.question?.question_id;
			if (generatedId) {
				navigate("practice", {
					history: "replace",
					session: currentSessionId,
					review: { conceptId: reviewIntent.conceptId, questionId: generatedId },
				});
				setReviewIntent((current) => (current ? { ...current, questionId: generatedId } : current));
			}
		} catch (err) {
			setReviewActionError(err instanceof Error ? err.message : "复习题生成失败，请重试。");
		} finally {
			setReviewGenerating(false);
		}
	};

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
		if (!label || !canGenerate || looksLikeSyntheticConceptLabel(label)) return;
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
	 * Open the continuation form, suggesting the same concept only when the
	 * profile holds a real name for it.
	 *
	 * A derived id (`concept_<hash>`) or the old title-cased form ("concept
	 * 45125622e640") is an identifier, not a topic. Prefilling it would replace
	 * the learner's words with a hash, so the field stays empty and the learner
	 * confirms the concept explicitly.
	 */
	const openNextQuestion = () => {
		// Continuing with another question leaves the review task behind: the new
		// question is ordinary practice, not a due review the URL still claims.
		if (reviewQuestionActive) exitReviewMode();
		if (!concept.trim()) {
			const matched = concepts.find((item) => item.concept_id === question?.concept_id);
			const label = trustedConceptLabel(matched?.concept_id ?? question?.concept_id ?? "", matched?.concept_name);
			if (matched && label) {
				setConcept(label);
				setConceptId(matched.concept_id);
			}
		}
		setNextQuestionOpen(true);
	};

	const conceptIsSynthetic = looksLikeSyntheticConceptLabel(concept);
	const conceptIsUsable = Boolean(concept.trim()) && !conceptIsSynthetic;

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
			// Recompute both views from the updated L1 profile: the C2 score above
			// is session-scoped, the recommendation is the long-term state. A failed
			// re-read clears the advice instead of implying it was refreshed.
			void learnerStore.load();
			if (question?.concept_id) void learnerStore.loadConceptRecommendation(question.concept_id);
		}
	};

	// Prefer the persisted assessment from the attempt view; fall back to the
	// response-scoped assessment while a re-read is still in flight.
	const shownAssessment = isCurrentSession ? (currentAttempt?.assessment ?? learning.assessment) : null;
	// Only the recommendation for *this* question's concept, and only after the
	// evidence was recorded: a pending or failed finalize must not look like a
	// refreshed long-term state.
	const currentRecommendation: LearningRecommendation | undefined = attemptCompleted && question
		&& conceptRecommendation?.concept_id === question.concept_id
		? conceptRecommendation.recommendations.find((item) => item.concept_id === question.concept_id)
		: undefined;
	const recommendationTitle = currentRecommendation?.name_available && currentRecommendation.concept_name
		? currentRecommendation.concept_name
		: "知识点名称待确认";
	const recommendationIsLearn = currentRecommendation?.action === "learn";
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
					{conceptIsSynthetic
						? "这是系统生成的标识，不是知识点名称，请填写真实的知识点名称。"
						: "从学习档案里选一个已有知识点，出题会复用同一个知识点标识。"}
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
					disabled={!canGenerate || !conceptIsUsable}
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

	if (reviewPrepMode && reviewIntent) {
		const dueDate = reviewRecommendation?.evidence_basis.review_due_at;
		const dueLabel = dueDate && !Number.isNaN(Date.parse(dueDate))
			? new Date(dueDate).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })
			: null;
		return (
			<>
				<div className="mla-page-head">
					<div>
						<h1>练习与反馈</h1>
						<p>先从到期知识点生成一道复习题，再完成作答、评分与正式记录。</p>
					</div>
					<div className="mla-page-meta">
						<Button onClick={() => navigate("today", { history: "push" })}>返回今日学习</Button>
					</div>
				</div>

				<div className="mla-split">
					<div className="mla-stack">
						<section className="mla-card" aria-labelledby="review-prepare">
							<div className="mla-card-header">
								<h2 id="review-prepare">复习准备</h2>
								<span className="mla-badge mla-badge--accent">到期复习</span>
							</div>
							<div className="mla-stack" style={{ gap: 14 }}>
								<div className="mla-stack" style={{ gap: 6 }}>
									<span className="mla-small mla-muted">知识点</span>
									{trustedReviewName ? (
										<>
											<strong>{trustedReviewName}</strong>
											<span className="mla-small mla-muted">名称来自学习档案；复习证据会记录到这个知识点。</span>
										</>
									) : (
										<>
											<label className="mla-small" htmlFor="review-concept-name">
												这个知识点没有可信名称，请确认真实的知识点名称
											</label>
											<input
												id="review-concept-name"
												className={inputCls}
												value={reviewLabel}
												maxLength={120}
												placeholder="例如：Python 闭包"
												onChange={(event) => {
													setReviewLabel(event.target.value);
													setReviewLabelConfirmed(false);
												}}
											/>
											<span className="mla-small mla-muted">
												确认后会复用原有知识点标识，不会新建另一个知识点；如果这是另一个主题，请改为普通练习。
											</span>
											<label className="mla-small mla-inline" style={{ gap: 8, cursor: "pointer" }}>
												<input
													type="checkbox"
													checked={reviewLabelConfirmed}
													onChange={(event) => setReviewLabelConfirmed(event.target.checked)}
												/>
												我确认这个名称属于当前复习知识点
											</label>
											{looksLikeSyntheticConceptLabel(reviewLabel) ? (
												<span className="mla-small" style={{ color: "var(--inno-danger)" }}>
													系统生成的标识不能作为知识点名称。
												</span>
											) : null}
										</>
									)}
								</div>

								<div className="mla-stack" style={{ gap: 6 }}>
									<span className="mla-small mla-muted">到期依据</span>
									{reviewCheck.loading ? (
										<span className="mla-small mla-muted mla-inline">
											<Loader2 size={14} className="mla-spin" aria-hidden="true" />
											正在核对这个知识点是否仍然到期…
										</span>
									) : reviewCheck.error ? (
										<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
											{reviewCheck.error}
										</p>
									) : reviewIsDue ? (
										<span className="mla-small mla-muted">
											{dueLabel ? `复习时间：${dueLabel}；` : ""}
											可追溯证据 {reviewRecommendation?.evidence_basis.evidence_count ?? 0} 条。
										</span>
									) : (
										<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
											该知识点目前不再显示为到期复习，不能按复习任务出题。
										</p>
									)}
									{reviewPrimaryMisconception ? (
										<div className="mla-empty" style={{ padding: "8px 0" }}>
											<Lightbulb size={24} aria-hidden="true" />
											<strong>当前主要建议是先澄清一个活跃误区</strong>
											<p className="mla-small" style={{ margin: 0 }}>
												这个知识点同时存在到期复习和活跃误区记录。你可以先去 AI 学习澄清，也可以仍按到期复习准备。
											</p>
											<Button onClick={() => navigate("learn", { history: "push" })}>前往 AI 学习</Button>
										</div>
									) : null}
								</div>

								<div className="mla-stack" style={{ gap: 8 }}>
									<label className="mla-small" htmlFor="review-session">学习会话</label>
									<select
										id="review-session"
										className={inputCls}
										value={currentSessionId ?? ""}
										onChange={(event) => chooseReviewSession(event.target.value)}
										disabled={sessionsLoading}
									>
										<option value="">请选择学习会话</option>
										{sessions.map((session) => (
											<option key={session.id} value={session.id}>
												{session.name || session.preview || session.id}
											</option>
										))}
									</select>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<Button
											onClick={() => void createReviewSession()}
											disabled={creatingReviewSession}
										>
											{creatingReviewSession ? <Loader2 size={14} className="mla-spin" /> : null}
											{creatingReviewSession ? "正在创建…" : "新建复习会话"}
										</Button>
										{currentSessionId ? (
											<Button onClick={() => navigate("learn", { history: "push", session: currentSessionId })}>
												继续完成原有学习
											</Button>
										) : null}
									</div>
									<span className="mla-small mla-muted">
										{reviewSessionReadiness === "none" ? "尚未选择学习会话，可以新建一段用于复习。" : null}
										{reviewSessionReadiness === "loading" ? "正在读取会话的学习状态…" : null}
										{reviewSessionReadiness === "needs_init" ? "这段会话还没有学习记录，点击生成时会先显式初始化。" : null}
										{reviewSessionReadiness === "ready" ? "这段会话可以接收复习题。" : null}
										{reviewSessionBlockedMessage}
									</span>
								</div>

								<div className="mla-stack" style={{ gap: 8 }}>
									<label className="mla-small" htmlFor="review-kind">题型</label>
									<select
										id="review-kind"
										className={inputCls}
										value={reviewKind}
										onChange={(event) => setReviewKind(event.target.value as typeof reviewKind)}
									>
										<option value="free_recall">自由回忆（默认）</option>
										<option value="application">应用题</option>
										<option value="transfer">迁移题</option>
									</select>
									<label className="mla-small mla-inline" style={{ gap: 8, cursor: "pointer" }}>
										<input
											type="checkbox"
											checked={reviewFallback}
											onChange={(event) => setReviewFallback(event.target.checked)}
										/>
										没有可用资料时，允许使用模型知识出题
									</label>
								</div>

								{reviewActionError ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										{reviewActionError}
									</p>
								) : null}

								<div className="mla-inline" style={{ flexWrap: "wrap" }}>
									<Button
										variant="primary"
										disabled={!reviewCanGenerate}
										onClick={() => void generateReviewQuestion()}
									>
										{reviewGenerating ? <Loader2 size={14} className="mla-spin" /> : <Sparkles size={14} />}
										{reviewGenerating ? "正在生成…" : "生成复习题"}
									</Button>
									<Button onClick={exitReviewMode}>改为普通练习</Button>
								</div>
							</div>
						</section>
					</div>

					<aside className="mla-rail" aria-label="复习说明">
						<section className="mla-card">
							<h2>复习是怎么完成的</h2>
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								生成题目只是开始。只有完成作答、评分，并点击「记录本次学习结果」写入正式证据后，本次复习才算完成。
							</p>
						</section>
						<section className="mla-card">
							<h2>不会自动做的事</h2>
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								打开页面不会创建学习记录或生成题目；复习也不会自动修改掌握度或下次复习时间，这些仍由学习档案按真实证据计算。
							</p>
						</section>
					</aside>
				</div>
			</>
		);
	}

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
							{reviewQuestionActive ? <span className="mla-badge">复习</span> : null}
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
									<div className="mla-stack" style={{ gap: 8 }}>
										<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
											<span className="mla-badge mla-badge--accent">
												{reviewQuestionActive ? "本次复习作答已记录" : "本题已记录"}
											</span>
											<span className="mla-small mla-muted">
												{reviewQuestionActive ? "本次复习作答已记录。" : "已将正式证据纳入学习档案。"}
											</span>
											<Button onClick={() => navigate("profile", { history: "push" })}>
												查看我的学习档案
											</Button>
											{reviewQuestionActive ? (
												<Button onClick={() => navigate("today", { history: "push" })}>返回今日学习</Button>
											) : null}
										</div>
										{reviewQuestionActive ? (
											<span className="mla-small mla-muted">
												这只表示本次作答已写入正式证据；是否答对、长期掌握是否改善，分别以下方评分与学习档案为准。
											</span>
										) : null}
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
					{attemptCompleted && question ? (
						<section className="mla-card" aria-labelledby="practice-recommendation">
							<div className="mla-card-header">
								<h2 id="practice-recommendation">下一步学习建议</h2>
								<span className="mla-small mla-muted">来自学习档案的长期状态</span>
							</div>
							{conceptRecommendationLoading || (!conceptRecommendation && !conceptRecommendationError) ? (
								<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
									<Loader2 size={14} className="mla-spin" aria-hidden="true" />
									正在读取学习档案建议…
								</p>
							) : conceptRecommendationError ? (
								<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
									{conceptRecommendationError}
								</p>
							) : currentRecommendation ? (
								<div className="mla-stack" style={{ gap: 8 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong>{recommendationTitle}</strong>
										<span className="mla-badge mla-badge--accent">{ACTION_LABELS[currentRecommendation.action]}</span>
										{currentRecommendation.suggested_kind ? (
											<span className="mla-badge">建议题型：{KIND_LABELS[currentRecommendation.suggested_kind]}</span>
										) : null}
									</div>
									<p className="mla-text" style={{ margin: 0 }}>{currentRecommendation.reason}</p>
									<div className="mla-inline mla-small mla-muted" style={{ gap: 8, flexWrap: "wrap" }}>
										<span>可追溯证据 {currentRecommendation.evidence_basis.evidence_count} 条</span>
										{currentRecommendation.evidence_basis.exposure_only ? <span>仅有接触记录</span> : null}
										{currentRecommendation.evidence_basis.provenance_limited ? <span>来源受限，仅供谨慎参考</span> : null}
									</div>
									{!currentRecommendation.name_available ? (
										<p className="mla-small mla-muted" style={{ margin: 0 }}>
											知识点名称无法可靠显示，继续练习时需要在上面重新确认主题。
										</p>
									) : null}
									{recommendationIsLearn ? (
										<Button onClick={() => navigate("learn", { history: "push" })}>
											前往 AI 学习
										</Button>
									) : (
										<span className="mla-small mla-muted">
											本轮只提供建议，不会自动出题；可在上方选择知识点继续练习。
										</span>
									)}
								</div>
							) : (
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									该知识点暂时没有基于真实证据的下一步建议。
								</p>
							)}
						</section>
					) : null}
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
