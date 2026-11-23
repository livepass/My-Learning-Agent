import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { GraduationCap, Lightbulb, Loader2, Sparkles } from "lucide-react";
import type { PublicAttemptView } from "../../../api/learning.js";
import { Badge, Button, Textarea } from "../../ui/index.js";
import { PracticeProgress, derivePracticeProgress } from "./PracticeProgress.js";

export type PracticeAnswerPanelProps = {
	/** Shared with the page's auto-height effect. */
	answerRef: RefObject<HTMLTextAreaElement | null>;
	/** The value to show: the server's answer once submitted, else the draft. */
	answer: string;
	/** Raw draft, used only to decide whether submit is allowed. */
	draft: string;
	readOnly: boolean;
	disabled: boolean;
	attempt: PublicAttemptView | undefined;
	/**
	 * True once an answer exists for the current question, from either the
	 * attempt view or the checkpoint's `pending_attempt_id`.
	 *
	 * These are two different signals with different timing: right after a
	 * submit the checkpoint carries the pending id before the attempt view is
	 * re-read, and using only the attempt view briefly re-enabled the submit
	 * form. The page computes the union; this component must not re-derive it.
	 */
	hasAttempt: boolean;
	reviewActive: boolean;
	submitting: boolean;
	evaluating: boolean;
	finalizing: boolean;
	submitError: string | null;
	evaluateError: string | null;
	finalizeError: string | null;
	onAnswerChange: (value: string) => void;
	onSubmit: () => void;
	onEvaluate: () => void;
	onRecord: () => void;
	onViewProfile: () => void;
	onBackToToday: () => void;
	/** The feedback block, rendered after the answer so the two stay together. */
	feedback?: ReactNode;
};

/**
 * E4.9h-P2-1 — the answer region: input, submit, evaluate, record.
 *
 * Extracted from the `.mla-practice-answer` block with the markup and class
 * names unchanged. Every state arrives through props and every action leaves
 * through a callback, so the page keeps ownership of `draftsByQuestion`, the
 * store calls and the async guards.
 *
 * The four business distinctions the UI must never blur:
 *
 * 1. submit ≠ evaluated  — after submit the button becomes 「开始评分」;
 * 2. evaluated ≠ recorded — 「记录本次学习结果」 is its own step;
 * 3. a failed evaluation keeps the saved answer (the textarea is read-only
 *    because the server has it, not because scoring succeeded);
 * 4. a new question never shows the previous answer or score — the page
 *    scopes `attempt` to the current question before passing it in.
 */
export function PracticeAnswerPanel({
	answerRef,
	answer,
	draft,
	readOnly,
	disabled,
	attempt,
	hasAttempt,
	reviewActive,
	submitting,
	evaluating,
	finalizing,
	submitError,
	evaluateError,
	finalizeError,
	onAnswerChange,
	onSubmit,
	onEvaluate,
	onRecord,
	onViewProfile,
	onBackToToday,
	feedback,
}: PracticeAnswerPanelProps) {
	const { t } = useTranslation();

	const stage = attempt?.stage;
	const attemptFailed = stage === "evaluation_failed";
	const attemptEvaluated = stage === "evaluated" || stage === "evidence_recorded"
		|| stage === "profile_projected";
	const attemptCompleted = stage === "completed";
	const attemptRetryable = Boolean(attempt?.retryable);

	/**
	 * E4.9h-P2-2 — the three-step progress is derived here, from props only.
	 *
	 * No second business state is created: `stage` is the server's durable
	 * attempt stage (the page already scoped it to the current question),
	 * `hasAttempt` is the page's `pending_attempt_id || currentAttempt` union,
	 * and the three busy flags are the store's request flags. The pure
	 * `derivePracticeProgress` is unit-tested on its own.
	 */
	const progress = derivePracticeProgress({
		stage,
		hasAttempt,
		submitting,
		evaluating,
		finalizing,
		submitFailed: Boolean(submitError),
		evaluateFailed: Boolean(evaluateError),
		finalizeFailed: Boolean(finalizeError),
	});

	return (
		<div className="mla-practice-answer">
			<div className="mla-practice-answer-head">
				{/*
				 * E4.9h-P2-3: the result badge moved into the feedback overview.
				 * One score must produce exactly one result label, and the score it
				 * belongs to lives in `PracticeFeedback`.
				 */}
				<label className="mla-small" htmlFor="practice-answer-input">{t("practice.answer.label")}</label>
			</div>
			<Textarea
				id="practice-answer-input"
				ref={answerRef}
				variant="prose"
				rows={3}
				placeholder={t("practice.answer.placeholder")}
				value={answer}
				onChange={(event) => onAnswerChange(event.target.value)}
				disabled={readOnly || disabled}
			/>

			{/*
			 * E4.9h-P2-2 — the whole sequence is visible at once, next to the
			 * action it describes. It never replaces a button: submit, score and
			 * record stay three separate actions in the blocks below.
			 */}
			<PracticeProgress state={progress} recording={finalizing} />

			{!hasAttempt ? (
				<div className="mla-practice-submit">
					<span className="mla-small mla-muted">
						{t("practice.answer.submitHint")}
					</span>
					<Button
						variant="primary"
						disabled={!draft.trim() || submitting}
						onClick={onSubmit}
					>
						{submitting ? <Loader2 size={14} className="mla-spin" /> : <Sparkles size={14} />}
						{submitting ? t("practice.answer.saving") : t("practice.answer.submit")}
					</Button>
				</div>
			) : attemptCompleted ? (
				<div className="mla-practice-status">
					<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
						<Badge tone="accent">
							{reviewActive ? t("practice.answer.recordedReviewBadge") : t("practice.answer.recordedBadge")}
						</Badge>
						<span className="mla-small mla-muted">
							{reviewActive ? t("practice.answer.recordedReview") : t("practice.answer.recorded")}
						</span>
						<Button onClick={onViewProfile}>
							{t("practice.answer.viewProfile")}
						</Button>
						{reviewActive ? (
							<Button onClick={onBackToToday}>{t("practice.answer.backToToday")}</Button>
						) : null}
					</div>
					{reviewActive ? (
						<span className="mla-small mla-muted">
							{t("practice.answer.reviewOnlyEvidence")}
						</span>
					) : null}
				</div>
			) : attemptEvaluated ? (
				<div className="mla-practice-status">
					<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
						<span className="mla-small mla-muted">{t("practice.answer.scored")}</span>
						<Button
							variant="primary"
							disabled={finalizing}
							onClick={onRecord}
						>
							{finalizing ? <Loader2 size={14} className="mla-spin" /> : <GraduationCap size={14} />}
							{finalizing ? t("practice.answer.recording") : t("practice.answer.record")}
						</Button>
					</div>
					<span className="mla-small mla-muted">
						{t("practice.answer.recordHint")}
					</span>
				</div>
			) : (
				<div className="mla-practice-status">
					<div className="mla-inline" style={{ gap: 10, flexWrap: "wrap" }}>
						<Button
							variant="primary"
							disabled={evaluating || (attemptFailed && !attemptRetryable)}
							onClick={onEvaluate}
						>
							{evaluating ? <Loader2 size={14} className="mla-spin" /> : <Lightbulb size={14} />}
							{evaluating
								? t("practice.answer.evaluating")
								: attemptFailed ? t("practice.answer.retryEvaluate") : t("practice.answer.evaluate")}
						</Button>
						<span className="mla-small mla-muted">
							{attemptFailed
								? (attemptRetryable ? t("practice.answer.evaluateFailedRetryable") : t("practice.answer.evaluateRetryExhausted"))
								: t("practice.answer.awaitingEvaluate")}
						</span>
					</div>
				</div>
			)}

			{submitError ? (
				<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
					{submitError}
				</p>
			) : null}
			{evaluateError ? (
				<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
					{evaluateError}
				</p>
			) : null}
			{finalizeError ? (
				<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
					{finalizeError}
				</p>
			) : null}

			{attempt?.failure && !attemptEvaluated && !attemptCompleted ? (
				<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
					{t("practice.evaluate.failed", { message: attempt.failure.message })}
				</p>
			) : null}

			{feedback}
		</div>
	);
}
