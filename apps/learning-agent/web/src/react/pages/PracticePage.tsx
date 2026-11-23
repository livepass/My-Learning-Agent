import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { recommendationReasonText } from "./recommendation-copy.js";
import { CircleDashed, GraduationCap, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { learningStore } from "../../stores/learning-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Badge, Button, Card, EmptyState, Textarea, inputCls } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";
import type { PublicLearningQuestion } from "../../api/learning.js";
import { getLearningRecommendations } from "../../api/learner.js";
import type { LearningRecommendation, RecommendationSnapshot } from "../../types/learner.js";
import { looksLikeSyntheticConceptLabel, trustedConceptLabel } from "../../utils/concept-label.js";
import { reviewIntentFromLocation, type ReviewIntent } from "../../utils/review-intent.js";
import { PracticeAnswerPanel } from "./practice/PracticeAnswerPanel.js";
import { PracticeFeedback } from "./practice/PracticeFeedback.js";
import { PracticeGeneratorForm } from "./practice/PracticeGeneratorForm.js";
import { PracticeQuestionCard } from "./practice/PracticeQuestionCard.js";

/**
 * 练习与反馈 — C1 出题、C2 作答与评分、C3 证据记录、C4 连续出题与建议。
 *
 * The server owns knowledge selection, provenance, question ids and the model
 * identity; this page only collects the concept, asks for a question and shows
 * the public result. A question is "current" only while the checkpoint is at
 * `awaiting_answer`: after C3 the checkpoint moves to `feedback` and the same
 * question ref is history, not something still waiting for an answer.
 */
const ACTION_LABEL_KEY: Record<LearningRecommendation["action"], string> = {
	learn: "practice.recommendation.action.learn",
	review: "practice.recommendation.action.review",
	practice: "practice.recommendation.action.practice",
	diagnose: "practice.recommendation.action.diagnose",
	transfer: "practice.recommendation.action.transfer",
};

const KIND_LABEL_KEY: Record<NonNullable<LearningRecommendation["suggested_kind"]>, string> = {
	free_recall: "practice.generator.kind.freeRecall",
	application: "practice.generator.kind.application",
	transfer: "practice.generator.kind.transfer",
};

export function PracticePage() {
	const { t, i18n } = useTranslation();
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
	/**
	 * Live mirrors of the review identity.
	 *
	 * An async generation cannot read React state safely: the closure keeps the
	 * values from the render that started it. These refs always hold the newest
	 * intent, and `reviewTicketRef` is bumped whenever that identity changes, so a
	 * response can be recognised as belonging to an action the learner left.
	 */
	const reviewIntentRef = useRef<ReviewIntent | null>(reviewIntent);
	const reviewTicketRef = useRef(0);
	const reviewGeneratingRef = useRef(false);
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
	const answerRef = useRef<HTMLTextAreaElement | null>(null);
	const stateCheckpoint = isCurrentSession ? learning.state?.checkpoint : undefined;
	const draftKey = currentSessionId && stateCheckpoint?.question
		? `${currentSessionId}::${stateCheckpoint.question.question_id}::${stateCheckpoint.question.question_version}`
		: null;
	const currentDraft = draftKey ? (draftsByQuestion[draftKey] ?? "") : "";
	// Already submitted / loaded attempt displays the server's durable answer verbatim.
	const displayedAnswer = currentAttempt ? currentAttempt.answer : currentDraft;

	/**
	 * E4.8g — the answer field grows with its content up to a ceiling.
	 *
	 * A fixed `rows={5}` box was either a large empty area for a one-line answer
	 * or too short for a paragraph, and the native resize handle is invisible on
	 * touch. The height follows `scrollHeight` (which is correct for CJK and for
	 * wrapped English), and past the ceiling the field scrolls.
	 */
	useEffect(() => {
		const node = answerRef.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(Math.max(node.scrollHeight, 88), 320)}px`;
	}, [displayedAnswer]);

	const onAnswerChange = (value: string) => {
		if (draftKey) {
			setDraftsByQuestion((prev) => ({ ...prev, [draftKey]: value }));
		}
	};

	useEffect(() => {
		if (currentSessionId) void learningStore.load(currentSessionId);
	}, [currentSessionId]);

	// A different conversation invalidates whatever review action was confirmed
	// against the previous one, even if the learner later navigates back to it.
	useEffect(() => {
		reviewTicketRef.current += 1;
	}, [currentSessionId]);

	useEffect(() => {
		void learnerStore.load();
	}, []);

	/**
	 * Single entry point for changing the review identity.
	 *
	 * The ref is written synchronously (React state commits later), and any change
	 * of concept or question bumps the ticket so an in-flight generation started
	 * for the old target can tell that it no longer belongs here.
	 */
	const applyReviewIntent = (next: ReviewIntent | null) => {
		const previous = reviewIntentRef.current;
		const changed = previous?.conceptId !== next?.conceptId || previous?.questionId !== next?.questionId;
		if (changed) reviewTicketRef.current += 1;
		reviewIntentRef.current = next;
		setReviewIntent(next);
	};

	// Back/forward between review entries must swap the target concept, not keep
	// the previous one. The page can stay mounted while only the query changes.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onPopState = () => {
			const next = reviewIntentFromLocation();
			const previous = reviewIntentRef.current;
			if (previous?.conceptId !== next?.conceptId || previous?.questionId !== next?.questionId) {
				reviewTicketRef.current += 1;
			}
			reviewIntentRef.current = next;
			setReviewIntent(next);
		};
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
					setReviewCheck({ loading: false, error: t("practice.review.mismatch"), snapshot: null });
					return;
				}
				setReviewCheck({ loading: false, error: null, snapshot });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const status = (err as { status?: number } | undefined)?.status;
				setReviewCheck({
					loading: false,
					error: status === 503
						? t("practice.review.profileUnavailable")
						: t("practice.review.checkFailed"),
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
		? t("practice.review.sessionBlocked")
		: reviewSessionReadiness === "unavailable"
			? (learning.error ?? t("practice.review.sessionUnavailable"))
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
	// A review badge belongs to the question the *server* saved from a review
	// request. The URL can only narrow that down (same concept, same question);
	// it can never promote an ordinary question by editing the address, and a
	// review question whose HTTP response was lost is still a review after a
	// refresh because the provenance lives in B2, not in the query string.
	const reviewQuestionActive = Boolean(
		question?.review === true
		&& (!reviewIntent
			|| (reviewIntent.conceptId === question.concept_id
				&& (!reviewIntent.questionId || reviewIntent.questionId === question.question_id))),
	);
	/**
	 * The URL names a question that exists but is *not* a review question.
	 *
	 * Editing the query string cannot relabel a plain question, and it must not
	 * hide it behind the preparation form either: the learner keeps seeing their
	 * real question and feedback, just without any review claim.
	 */
	const reviewIntentPointsAtPlainQuestion = Boolean(
		reviewIntent?.questionId
		&& question
		&& question.question_id === reviewIntent.questionId
		&& question.concept_id === reviewIntent.conceptId
		&& question.review !== true,
	);
	const reviewPrepMode = Boolean(reviewIntent && !reviewQuestionActive && !reviewIntentPointsAtPlainQuestion);

	const exitReviewMode = () => {
		// Cancels any in-flight review action: leaving review mode must not let a
		// late response re-enter it or navigate.
		applyReviewIntent(null);
		navigate("practice", { history: "replace", session: currentSessionId ?? null });
		setReviewActionError(null);
	};

	const chooseReviewSession = (sessionId: string) => {
		if (!sessionId) return;
		setReviewActionError(null);
		void sessionsStore.openSession(sessionId, { historyMode: "replace" });
	};

	/**
	 * E4.8: only a course-bound conversation is a learning conversation. A review
	 * session created here has no course, so the learner is told they can read it
	 * but not chat in it — the workbench only accepts course-bound messages.
	 */
	const currentSessionHasCourse = Boolean(
		sessions.find((session) => session.id === currentSessionId)?.course,
	);

	const createReviewSession = async () => {
		setCreatingReviewSession(true);
		setReviewActionError(null);
		try {
			const id = await sessionsStore.createSessionWith();
			if (!id) setReviewActionError(t("practice.review.createSessionFailed"));
		} finally {
			setCreatingReviewSession(false);
		}
	};

	/**
	 * Everything the learner confirmed when they pressed "生成复习题".
	 *
	 * React state is not a concurrency guard: the closure that runs after the L1
	 * read still sees the render it started in. This snapshot is compared against
	 * the live stores after every await, so switching conversation, switching
	 * concept, leaving review mode or a moved checkpoint cancels the action instead
	 * of writing a question into a page the learner has already left.
	 */
	interface ReviewRequestContext {
		ticket: number;
		conceptId: string;
		sessionId: string | null;
		/** Checkpoint revision confirmed by the learner; null when the record did not exist yet. */
		revision: number | null;
	}

	/** The action still belongs to the same conversation, concept and review mode. */
	const reviewScopeProblem = (context: ReviewRequestContext): string | null => {
		if (context.ticket !== reviewTicketRef.current) return t("practice.review.cancelled");
		const intent = reviewIntentRef.current;
		if (!intent || intent.conceptId !== context.conceptId) return t("practice.review.exited");
		if (sessionsStore.currentSessionId !== context.sessionId || learningStore.sessionId !== context.sessionId) {
			return t("practice.review.sessionSwitched");
		}
		return null;
	};

	/** Nobody else advanced the checkpoint while the due status was being re-read. */
	const reviewRevisionProblem = (context: ReviewRequestContext): string | null => {
		if (context.revision === null) return null;
		return learningStore.state?.checkpoint?.revision === context.revision
			? null
			: t("practice.review.revisionMoved");
	};

	/**
	 * Generate the review question through the existing C1 endpoint.
	 *
	 * Due status is re-checked immediately before the model call, so a link that
	 * was valid on entry cannot silently start a review that is no longer due.
	 * The concept id is the one carried by the URL; it is never derived from the
	 * display name, so a corrected label cannot move evidence to another concept.
	 * The request carries `intent: "review"` so the saved question, not the URL,
	 * becomes the durable record of why it exists.
	 */
	const generateReviewQuestion = async () => {
		const intent = reviewIntentRef.current;
		if (!intent || !reviewCanGenerate || reviewGeneratingRef.current) return;
		const context: ReviewRequestContext = {
			ticket: ++reviewTicketRef.current,
			conceptId: intent.conceptId,
			sessionId: sessionsStore.currentSessionId,
			revision: learningStore.state?.exists ? (learningStore.state.checkpoint?.revision ?? null) : null,
		};
		reviewGeneratingRef.current = true;
		setReviewGenerating(true);
		setReviewActionError(null);
		/** Paint a failure only while this action still owns the screen. */
		const fail = (message: string) => {
			if (context.ticket === reviewTicketRef.current) setReviewActionError(message);
		};
		try {
			const snapshot = await getLearningRecommendations(3, context.conceptId);
			if (snapshot.concept_id !== context.conceptId) {
				throw new Error(t("practice.review.mismatch"));
			}
			const fresh = snapshot.recommendations.find((item) => item.concept_id === context.conceptId);
			const stillDue = Boolean(fresh && (
				fresh.reason_code === "review_due" || fresh.also_matches.includes("review_due")
			));
			// Checked before touching any state: this read is exactly the window in
			// which the learner can switch session, concept or leave review mode.
			const scopeAfterRead = reviewScopeProblem(context);
			if (scopeAfterRead) {
				fail(scopeAfterRead);
				return;
			}
			const movedAfterRead = reviewRevisionProblem(context);
			if (movedAfterRead) {
				fail(movedAfterRead);
				return;
			}
			if (!stillDue) {
				setReviewCheck({ loading: false, error: null, snapshot });
				setReviewActionError(t("practice.review.noLongerDue"));
				return;
			}

			if (!learningStore.state?.exists) {
				// Initialising the B2 record is part of this explicit generation
				// action; merely opening the page never creates one.
				await learningStore.init();
				const scopeAfterInit = reviewScopeProblem(context);
				if (scopeAfterInit) {
					fail(scopeAfterInit);
					return;
				}
			}
			const state = learningStore.state;
			const cp = state?.checkpoint;
			if (!state?.exists || !cp) throw new Error(t("practice.review.recordNotReady"));
			if (cp.status !== "active" || cp.pending_attempt_id) {
				throw new Error(t("practice.review.sessionChanged"));
			}
			const afterAttemptId = cp.step === "feedback" ? cp.last_completed_attempt_id : undefined;
			if (cp.step === "feedback" && !afterAttemptId) {
				throw new Error(t("practice.review.sessionIncomplete"));
			}

			const ok = await learningStore.generate({
				concept: reviewLabelValue,
				concept_id: context.conceptId,
				kind: reviewKind,
				allow_model_fallback: reviewFallback,
				intent: "review",
				...(afterAttemptId ? { after_attempt_id: afterAttemptId } : {}),
			}, { sessionId: context.sessionId ?? undefined });
			// The store refuses a switched session, and its late result is not
			// applied; the page must not read that state as the review question
			// either. Bail out before any navigation or error is painted.
			const scopeAfterGenerate = reviewScopeProblem(context);
			if (scopeAfterGenerate) {
				fail(scopeAfterGenerate);
				return;
			}
			if (!ok) {
				setReviewActionError(learningStore.generateError ?? t("practice.review.generateFailed"));
				return;
			}
			const generatedId = learningStore.state?.checkpoint?.question?.question_id;
			if (generatedId) {
				navigate("practice", {
					history: "replace",
					session: context.sessionId,
					review: { conceptId: context.conceptId, questionId: generatedId },
				});
				applyReviewIntent({
					conceptId: context.conceptId,
					...(context.sessionId ? { sessionId: context.sessionId } : {}),
					questionId: generatedId,
				});
			}
		} catch (err) {
			fail(err instanceof Error ? err.message : t("practice.review.generateFailed"));
		} finally {
			reviewGeneratingRef.current = false;
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
		? checkpoint.knowledge.kind === "model_knowledge"
			? t("practice.question.source.model")
			: t("practice.question.source.library")
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
		: t("practice.recommendation.unnamed");
	const recommendationIsLearn = currentRecommendation?.action === "learn";

	/**
	 * The one generation form, shared by the first question and 「再练一道」.
	 *
	 * E4.9h-P2-1: the markup moved to `PracticeGeneratorForm`; this wrapper
	 * keeps the page's own decisions (eligibility, `after_attempt_id`, the
	 * trusted-name rule) and passes them down as props.
	 */
	const generatorForm = (options: { conceptInputId: string; actionLabel: string; onCancel?: () => void }) => (
		<PracticeGeneratorForm
			conceptInputId={options.conceptInputId}
			concept={concept}
			kind={kind}
			goalId={goalId}
			allowModelFallback={allowModelFallback}
			concepts={concepts}
			goals={goals}
			generating={learning.isGenerating}
			generateError={learning.generateError}
			canGenerate={canGenerate}
			conceptIsUsable={conceptIsUsable}
			conceptIsSynthetic={conceptIsSynthetic}
			continuation={generationMode === "continuation"}
			actionLabel={options.actionLabel}
			onConceptChange={onConceptChange}
			onKindChange={setKind}
			onGoalChange={setGoalId}
			onAllowFallbackChange={setAllowModelFallback}
			onGenerate={() => void generate()}
			onCancel={options.onCancel}
		/>
	);

	if (reviewPrepMode && reviewIntent) {
		const dueDate = reviewRecommendation?.evidence_basis.review_due_at;
		const dueLabel = dueDate && !Number.isNaN(Date.parse(dueDate))
			? new Date(dueDate).toLocaleDateString(i18n.language, { month: "long", day: "numeric" })
			: null;
		return (
			<>
				<div className="mla-page-head">
					<div>
						<h1>{t("practice.review.title")}</h1>
						<p>{t("practice.review.subtitle")}</p>
					</div>
					<div className="mla-page-meta">
						<Button onClick={() => navigate("today", { history: "push" })}>{t("practice.review.backToToday")}</Button>
					</div>
				</div>

				{/*
				 * E4.9h-P2-4 — one centred column, the same 860px measure the
				 * practice card uses. The old `.mla-split` + `.mla-rail` put the
				 * two explainer cards in a 224px sidebar, which on a phone left
				 * the preparation form squeezed beside prose nobody was reading.
				 *
				 * Only the explanatory copy is folded; every condition the learner
				 * must act on (concept, due status, session, errors) stays visible.
				 */}
				<div className="mla-practice mla-review-prep">
					<section className="mla-card" aria-labelledby="review-prepare">
						<div className="mla-card-header">
							<h2 id="review-prepare">{t("practice.review.heading")}</h2>
							<Badge tone="accent">{t("practice.review.badge")}</Badge>
						</div>
						<div className="mla-stack" style={{ gap: 14 }}>
							<div className="mla-stack" style={{ gap: 6 }}>
								<span className="mla-small mla-muted">{t("practice.review.concept")}</span>
								{trustedReviewName ? (
									<>
										<strong className="mla-review-concept">{trustedReviewName}</strong>
										<span className="mla-small mla-muted">{t("practice.review.nameFromProfile")}</span>
									</>
								) : (
									<>
										<label className="mla-small" htmlFor="review-concept-name">
											{t("practice.review.confirmLabel")}
										</label>
										<input
											id="review-concept-name"
											className={inputCls}
											value={reviewLabel}
											maxLength={120}
											placeholder={t("practice.review.conceptPlaceholder")}
											onChange={(event) => {
												setReviewLabel(event.target.value);
												setReviewLabelConfirmed(false);
											}}
										/>
										<span className="mla-small mla-muted">
											{t("practice.review.confirmHint")}
										</span>
										<label className="mla-small mla-inline" style={{ gap: 8, cursor: "pointer" }}>
											<input
												type="checkbox"
												checked={reviewLabelConfirmed}
												onChange={(event) => setReviewLabelConfirmed(event.target.checked)}
											/>
											{t("practice.review.confirmCheckbox")}
										</label>
										{looksLikeSyntheticConceptLabel(reviewLabel) ? (
											<span className="mla-small" style={{ color: "var(--inno-danger)" }}>
												{t("practice.review.syntheticName")}
											</span>
										) : null}
									</>
								)}
							</div>

							<div className="mla-stack" style={{ gap: 6 }}>
								<span className="mla-small mla-muted">{t("practice.review.basis")}</span>
								{reviewCheck.loading ? (
									<span className="mla-small mla-muted mla-inline">
										<Loader2 size={14} className="mla-spin" aria-hidden="true" />
										{t("practice.review.checking")}
									</span>
								) : reviewCheck.error ? (
									<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										{reviewCheck.error}
									</p>
								) : reviewIsDue ? (
									<span className="mla-small mla-muted">
										{dueLabel ? t("practice.review.dueAt", { date: dueLabel }) : ""}
										{t("practice.review.evidenceCount", {
											count: reviewRecommendation?.evidence_basis.evidence_count ?? 0,
										})}
									</span>
								) : (
									<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
										{t("practice.review.notDue")}
									</p>
								)}
								{reviewPrimaryMisconception ? (
									<EmptyState
										compact
										icon={Lightbulb}
										title={t("practice.review.misconceptionTitle")}
										description={t("practice.review.misconceptionBody")}
										action={(
											<Button onClick={() => navigate("learn", { history: "push" })}>
												{t("practice.review.goLearn")}
											</Button>
										)}
									/>
								) : null}
							</div>

							<div className="mla-stack" style={{ gap: 8 }}>
								<label className="mla-small" htmlFor="review-session">{t("practice.review.session")}</label>
								<select
									id="review-session"
									className={inputCls}
									value={currentSessionId ?? ""}
									onChange={(event) => chooseReviewSession(event.target.value)}
									disabled={sessionsLoading}
								>
									<option value="">{t("practice.review.selectSession")}</option>
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
										{creatingReviewSession ? t("practice.review.creating") : t("practice.review.createSession")}
									</Button>
									{currentSessionId ? (
										<Button onClick={() => navigate("learn", { history: "push", session: currentSessionId })}>
											{currentSessionHasCourse
												? t("practice.review.continueLearning")
												: t("practice.review.viewSession")}
										</Button>
									) : null}
								</div>
								<span className="mla-small mla-muted">
									{reviewSessionReadiness === "none" ? t("practice.review.readiness.none") : null}
									{reviewSessionReadiness === "loading" ? t("practice.review.readiness.loading") : null}
									{reviewSessionReadiness === "needs_init" ? t("practice.review.readiness.needsInit") : null}
									{reviewSessionReadiness === "ready" ? t("practice.review.readiness.ready") : null}
									{reviewSessionBlockedMessage}
								</span>
							</div>

							<div className="mla-stack" style={{ gap: 8 }}>
								<label className="mla-small" htmlFor="review-kind">{t("practice.review.kind")}</label>
								<select
									id="review-kind"
									className={inputCls}
									value={reviewKind}
									onChange={(event) => setReviewKind(event.target.value as typeof reviewKind)}
								>
									<option value="free_recall">{t("practice.review.kindFreeRecall")}</option>
									<option value="application">{t("practice.review.kindApplication")}</option>
									<option value="transfer">{t("practice.review.kindTransfer")}</option>
								</select>
								<label className="mla-small mla-inline" style={{ gap: 8, cursor: "pointer" }}>
									<input
										type="checkbox"
										checked={reviewFallback}
										onChange={(event) => setReviewFallback(event.target.checked)}
									/>
									{t("practice.review.allowFallback")}
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
									{reviewGenerating ? t("practice.review.generating") : t("practice.review.generate")}
								</Button>
								<Button onClick={exitReviewMode}>{t("practice.review.toPlainPractice")}</Button>
							</div>
						</div>
					</section>

					{/*
					 * The two explainer blocks move below the form as one native
					 * disclosure: `<details>`/`<summary>` gives keyboard and touch
					 * expansion for free, and closed-by-default keeps the form the
					 * only thing on screen. Copy is unchanged.
					 */}
					<details className="mla-review-notes">
						<summary>{t("practice.review.notesAria")}</summary>
						<div className="mla-review-notes-body">
							<div className="mla-stack" style={{ gap: 4 }}>
								<h3>{t("practice.review.howTitle")}</h3>
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									{t("practice.review.howBody")}
								</p>
							</div>
							<div className="mla-stack" style={{ gap: 4 }}>
								<h3>{t("practice.review.notAutomaticTitle")}</h3>
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									{t("practice.review.notAutomaticBody")}
								</p>
							</div>
						</div>
					</details>
				</div>
			</>
		);
	}

	return (
		<>
			<div className="mla-page-head">
				<div>
					<h1>{t("practice.page.title")}</h1>
					<p>{t("practice.page.subtitle")}</p>
				</div>
				<div className="mla-page-meta">
					<Button onClick={() => navigate("learn", { history: "push" })}>{t("practice.page.backToLearn")}</Button>
				</div>
			</div>

			<div className="mla-practice">
				<div className="mla-practice-main">
					{/*
					 * E4.8g — one practice card: question, explanation, divider, answer,
					 * submit, then the scored feedback. The old layout split the prompt and
					 * the answer into two cards, so the question scrolled out of sight while
					 * the learner was writing, and the two halves read as unrelated blocks.
					 */}
					<Card variant="practice" aria-labelledby="practice-question">
						<PracticeQuestionCard
							question={question ?? null}
							reviewActive={reviewQuestionActive}
							sourceLabel={sourceLabel}
							checkpointRevision={checkpoint ? checkpoint.revision : null}
							loading={learning.isLoading && !learning.state}
							noSessionCopy={currentSessionId ? "" : t("practice.question.noSession")}
							noRecord={!hasRecord}
							onInit={() => void learningStore.init()}
							initBusy={learning.isSaving}
						>
							<PracticeAnswerPanel
								answerRef={answerRef}
								answer={displayedAnswer}
								draft={currentDraft}
								readOnly={hasAttempt}
								disabled={learning.isSubmitting || learning.isEvaluating}
								attempt={currentAttempt}
								hasAttempt={hasAttempt}
								reviewActive={reviewQuestionActive}
								submitting={learning.isSubmitting}
								evaluating={learning.isEvaluating}
								finalizing={learning.isFinalizing}
								submitError={learning.submitError}
								evaluateError={learning.evaluateError}
								finalizeError={learning.finalizeError}
								onAnswerChange={onAnswerChange}
								onSubmit={() => void submit()}
								onEvaluate={evaluate}
								onRecord={finalize}
								onViewProfile={() => navigate("profile", { history: "push" })}
								onBackToToday={() => navigate("today", { history: "push" })}
								feedback={<PracticeFeedback assessment={shownAssessment} />}
							/>
						</PracticeQuestionCard>
						{/*
						 * The generator only appears when a record exists and no
						 * question is open — the other branches (no session,
						 * loading, no record) are rendered by the card itself.
						 */}
						{currentSessionId && hasRecord && !question && !(learning.isLoading && !learning.state) ? (
							<div className="mla-stack" style={{ gap: 14 }}>
								<EmptyState
									icon={GraduationCap}
									title={t("practice.empty.title")}
									description={t("practice.empty.description")}
								/>

								{generatorForm({
									conceptInputId: "practice-concept",
									actionLabel: t("practice.generator.generate"),
								})}
							</div>
						) : null}
					</Card>

					{generationMode === "continuation" ? (
						<section className="mla-card" aria-labelledby="practice-next">
							<div className="mla-card-header">
								<h2 id="practice-next">{t("practice.next.title")}</h2>
								<Badge>{t("practice.next.badge")}</Badge>
							</div>
							{nextQuestionOpen ? (
								generatorForm({
									conceptInputId: "practice-next-concept",
									actionLabel: t("practice.generator.generateNext"),
									onCancel: () => setNextQuestionOpen(false),
								})
							) : (
								<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
									<Button variant="primary" disabled={learning.isGenerating} onClick={openNextQuestion}>
										<Sparkles size={14} />
										{t("practice.next.another")}
									</Button>
									<span className="mla-small mla-muted">
										{t("practice.next.hint")}
									</span>
								</div>
							)}
						</section>
					) : null}

					<section className="mla-card" aria-labelledby="practice-feedback">
						<div className="mla-card-header">
							<h2 id="practice-feedback">{t("practice.evidence.title")}</h2>
							{attemptCompleted ? (
								<Badge tone="accent">{t("practice.evidence.recorded")}</Badge>
							) : attemptEvaluated ? (
								<Badge>{t("practice.evidence.pending")}</Badge>
							) : (
								<Badge>{t("practice.evidence.inProgress")}</Badge>
							)}
						</div>
						<ul className="mla-list">
							{attemptCompleted ? (
								<>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>{t("practice.evidence.recordedLine1")}</span>
									</li>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>{t("practice.evidence.recordedLine2")}</span>
									</li>
								</>
							) : (
								<>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>{t("practice.evidence.pendingLine1")}</span>
									</li>
									<li>
										<CircleDashed size={14} aria-hidden="true" />
										<span>{t("practice.evidence.pendingLine2")}</span>
									</li>
								</>
							)}
						</ul>
					</section>
					{attemptCompleted && question ? (
						<section className="mla-card" aria-labelledby="practice-recommendation">
							<div className="mla-card-header">
								<h2 id="practice-recommendation">{t("practice.recommendation.title")}</h2>
								<span className="mla-small mla-muted">{t("practice.recommendation.subtitle")}</span>
							</div>
							{conceptRecommendationLoading || (!conceptRecommendation && !conceptRecommendationError) ? (
								<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
									<Loader2 size={14} className="mla-spin" aria-hidden="true" />
									{t("practice.recommendation.loading")}
								</p>
							) : conceptRecommendationError ? (
								<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
									{conceptRecommendationError}
								</p>
							) : currentRecommendation ? (
								<div className="mla-stack" style={{ gap: 8 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong>{recommendationTitle}</strong>
										<Badge tone="accent">{t(ACTION_LABEL_KEY[currentRecommendation.action])}</Badge>
										{currentRecommendation.suggested_kind ? (
											<Badge>
												{t("practice.recommendation.suggestedKind", {
													kind: t(KIND_LABEL_KEY[currentRecommendation.suggested_kind]),
												})}
											</Badge>
										) : null}
									</div>
									<p className="mla-text" style={{ margin: 0 }}>{recommendationReasonText(t, currentRecommendation)}</p>
									<div className="mla-inline mla-small mla-muted" style={{ gap: 8, flexWrap: "wrap" }}>
										<span>{t("practice.recommendation.evidenceCount", { count: currentRecommendation.evidence_basis.evidence_count })}</span>
										{currentRecommendation.evidence_basis.exposure_only ? <span>{t("practice.recommendation.exposureOnly")}</span> : null}
										{currentRecommendation.evidence_basis.provenance_limited ? <span>{t("practice.recommendation.provenanceLimited")}</span> : null}
									</div>
									{!currentRecommendation.name_available ? (
										<p className="mla-small mla-muted" style={{ margin: 0 }}>
											{t("practice.recommendation.nameUnavailable")}
										</p>
									) : null}
									{recommendationIsLearn ? (
										<Button onClick={() => navigate("learn", { history: "push" })}>
											{t("practice.recommendation.goLearn")}
										</Button>
									) : (
										<span className="mla-small mla-muted">
											{t("practice.recommendation.adviceOnly")}
										</span>
									)}
								</div>
							) : (
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									{t("practice.recommendation.none")}
								</p>
							)}
						</section>
					) : null}
				</div>

				{/*
				 * E4.8g: the three explainer cards became one collapsed block. They
				 * answer "how does this work", not "what is the question", and a
				 * 224px rail of prose beside the practice card competed with it for
				 * attention.
				 */}
				<details className="mla-practice-notes">
					<summary>{t("practice.notes.title")}</summary>
					<ul className="mla-list">
						<li>
							<CircleDashed size={14} aria-hidden="true" />
							<span>{t("practice.notes.line1")}</span>
						</li>
						<li>
							<CircleDashed size={14} aria-hidden="true" />
							<span>{t("practice.notes.line2")}</span>
						</li>
						<li>
							<Lightbulb size={14} aria-hidden="true" />
							<span>{t("practice.notes.line3")}</span>
						</li>
					</ul>
				</details>
			</div>
		</>
	);
}
