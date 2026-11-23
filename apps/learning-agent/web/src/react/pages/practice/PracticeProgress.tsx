import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import type { PublicAttemptView } from "../../../api/learning.js";

/**
 * E4.9h-P2-2 — 提交答案 → AI 评分 → 记录证据.
 *
 * This component is display-only: it reads no Store, calls no API, touches no
 * URL and writes nothing. Every state arrives already derived from the current
 * question's server stage, so a new question or another conversation cannot
 * inherit the previous progress.
 */

/**
 * `active` is the step the learner can act on now. It carries the same copy as
 * `pending`; only the emphasis differs, because "highlighted" must never be
 * mistaken for "done" (that is why it is not a `done` variant).
 */
export type PracticeProgressStepState = "pending" | "active" | "working" | "done" | "failed";

export type PracticeProgressState = {
	submit: PracticeProgressStepState;
	evaluate: PracticeProgressStepState;
	record: PracticeProgressStepState;
};

export type PracticeProgressInput = {
	/** The durable stage of the current question's attempt, when one exists. */
	stage: PublicAttemptView["stage"] | undefined;
	/** `pending_attempt_id || currentAttempt`: the server already has an answer. */
	hasAttempt: boolean;
	submitting: boolean;
	evaluating: boolean;
	finalizing: boolean;
	submitFailed: boolean;
	evaluateFailed: boolean;
	finalizeFailed: boolean;
};

/**
 * The single place that maps server stage + request flags to the three steps.
 *
 * Precedence follows one rule: a server stage always wins over a local flag,
 * and a request in flight never means success. In particular:
 *
 * - `evidence_recorded` / `profile_projected` are NOT "recorded": only
 *   `completed` is, matching what the rest of the page already claims;
 * - `evaluation_failed` stays failed even after the retry limit is exhausted —
 *   a failure is never painted as a score;
 * - `isSubmitting` can only mean "saving", `isEvaluating` "scoring" and
 *   `isFinalizing` "recording", never the step after it.
 */
export function derivePracticeProgress(input: PracticeProgressInput): PracticeProgressState {
	const {
		stage, hasAttempt, submitting, evaluating, finalizing,
		submitFailed, evaluateFailed, finalizeFailed,
	} = input;

	const submit: PracticeProgressStepState = hasAttempt
		? "done"
		: submitting ? "working"
			: submitFailed ? "failed"
				: "pending";

	// `evaluating` from the store and `stage === "evaluating"` from the server
	// are the same claim; the server copy also covers a reload mid-scoring.
	const evaluated = stage === "evaluated" || stage === "evidence_recorded"
		|| stage === "profile_projected" || stage === "completed";
	const evaluate: PracticeProgressStepState = evaluated
		? "done"
		: evaluating || stage === "evaluating" ? "working"
			: stage === "evaluation_failed" || evaluateFailed ? "failed"
				: "pending";

	// Only `completed` means the evidence flow finished. The two intermediate
	// server stages are shown as work in progress, never as a completed step.
	const record: PracticeProgressStepState = stage === "completed"
		? "done"
		: finalizing ? "working"
			: finalizeFailed ? "failed"
				: stage === "evidence_recorded" || stage === "profile_projected" ? "working"
					: "pending";

	const state: PracticeProgressState = { submit, evaluate, record };
	const steps = ["submit", "evaluate", "record"] as const;
	// The first unfinished step is emphasised only when nothing is blocking it:
	// after a failure the learner must retry that step, so the next one is not
	// advertised as the current action.
	const firstOpen = steps.find((step) => state[step] !== "done");
	if (firstOpen && state[firstOpen] === "pending") state[firstOpen] = "active";
	return state;
}

/** Copy keys per step and state. Literal so the i18n scan can verify both locales. */
const STEP_COPY: Record<keyof PracticeProgressState, Record<PracticeProgressStepState, string>> = {
	submit: {
		pending: "practice.progress.submit.pending",
		active: "practice.progress.submit.pending",
		working: "practice.progress.submit.working",
		done: "practice.progress.submit.done",
		failed: "practice.progress.submit.failed",
	},
	evaluate: {
		pending: "practice.progress.evaluate.pending",
		active: "practice.progress.evaluate.pending",
		working: "practice.progress.evaluate.working",
		done: "practice.progress.evaluate.done",
		failed: "practice.progress.evaluate.failed",
	},
	record: {
		pending: "practice.progress.record.pending",
		active: "practice.progress.record.pending",
		working: "practice.progress.record.working",
		done: "practice.progress.record.done",
		failed: "practice.progress.record.failed",
	},
};

const STEP_NAME: Record<keyof PracticeProgressState, string> = {
	submit: "practice.progress.submit.name",
	evaluate: "practice.progress.evaluate.name",
	record: "practice.progress.record.name",
};

const STEPS = ["submit", "evaluate", "record"] as const;

export type PracticeProgressProps = {
	state: PracticeProgressState;
	/**
	 * True while the record request is in flight. It only chooses the copy:
	 * "正在记录" for the learner's own request, "记录处理中" for the server's
	 * internal stages, which are still unfinished.
	 */
	recording: boolean;
};

export function PracticeProgress({ state, recording }: PracticeProgressProps) {
	const { t } = useTranslation();

	return (
		<ol className="mla-practice-progress" aria-label={t("practice.progress.label")}>
			{STEPS.map((step, index) => {
				const stepState = state[step];
				const copyKey = step === "record" && stepState === "working" && !recording
					? "practice.progress.record.processing"
					: STEP_COPY[step][stepState];
				return [
					index > 0 ? (
						<li key={`${step}-sep`} className="mla-practice-progress-sep" aria-hidden="true">→</li>
					) : null,
					<li
						key={step}
						className="mla-practice-progress-step"
						data-state={stepState}
						aria-current={stepState === "active" ? "step" : undefined}
					>
						<span className="mla-practice-progress-dot" aria-hidden="true">
							{stepState === "done" ? <Check size={11} strokeWidth={3} />
								: stepState === "working" ? <Loader2 size={11} className="mla-spin" />
									: stepState === "failed" ? <AlertCircle size={11} />
										: index + 1}
						</span>
						<span className="mla-practice-progress-name">{t(STEP_NAME[step])}</span>
						<span className="mla-practice-progress-state">{t(copyKey)}</span>
					</li>,
				];
			})}
		</ol>
	);
}
