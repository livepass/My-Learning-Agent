import { useTranslation } from "react-i18next";
import { Loader2, PanelRightClose, PanelRightOpen, Pause, Play, RotateCcw } from "lucide-react";
import type {
	LearningCheckpointStatus,
	LearningCheckpointStep,
	LearningRecoveryAction,
	LearningState,
} from "../../../api/learning.js";
import type { LearningReadOnlyReason } from "../../LearningWorkspace.js";
import { Badge, Button, IconButton } from "../../ui/index.js";

/** Plain-language step labels; never imply a score exists. */
const STEP_LABEL_KEY: Record<LearningCheckpointStep, string> = {
	conversation: "learn.status.step.conversation",
	awaiting_answer: "learn.status.step.awaitingAnswer",
	feedback: "learn.status.step.feedback",
};

const STATUS_LABEL_KEY: Record<LearningCheckpointStatus, string> = {
	active: "learn.status.checkpoint.active",
	paused: "learn.status.checkpoint.paused",
	completed: "learn.status.checkpoint.completed",
};

/**
 * Every recovery action is phrased as "not yet executed": scoring, evidence and
 * profile projection belong to a later package, so the UI must not claim them.
 */
const ACTION_LABEL_KEY: Record<LearningRecoveryAction, string> = {
	evaluate: "learn.status.action.evaluate",
	wait_for_running_evaluation: "learn.status.action.waitForRunningEvaluation",
	await_manual_retry: "learn.status.action.awaitManualRetry",
	mark_retry_limit: "learn.status.action.markRetryLimit",
	publish_saved_evidence: "learn.status.action.publishSavedEvidence",
	project_saved_evidence: "learn.status.action.projectSavedEvidence",
	advance_checkpoint: "learn.status.action.advanceCheckpoint",
	return_saved_result: "learn.status.action.returnSavedResult",
};

/**
 * E4.8f — a checkpoint that is worth showing.
 *
 * `learning/start` writes a placeholder record at `step: "conversation"` with
 * no questions the moment a conversation is created. That is not learning
 * progress, so the status panel starts collapsed for it; a real step, a question
 * or a saved attempt opens it. Nothing here invents progress — it only decides
 * whether the panel has something to show.
 *
 * Exported because `LearnPage` uses the same rule to choose the panel's initial
 * open state; the semantics must stay single-sourced.
 */
export function hasRealCheckpoint(state: LearningState): boolean {
	if (!state.exists || !state.checkpoint) return false;
	const checkpoint = state.checkpoint;
	const hasQuestions = (state.questions?.length ?? 0) > 0;
	const hasAttempts = (state.attempts?.length ?? 0) > 0;
	return checkpoint.step !== "conversation"
		|| hasQuestions
		|| hasAttempts
		|| checkpoint.status !== "active"
		|| checkpoint.revision > 1;
}

/**
 * E4.9g-P2-1 — the collapsible learning-status panel.
 *
 * Display only: loading, initialising, pausing and resuming stay in
 * `LearnPage` / `learningStore`. The panel never calls `learning/start` and
 * never initialises a record on mount; every write starts from an explicit
 * click. It shows what the server returned, and nothing about scores, mastery
 * or evidence that the server did not record.
 */
export function LearnContextPanel({
	open,
	currentSessionId,
	learning,
	readOnlySession,
	canPause,
	canResume,
	onToggle,
	onRetry,
	onInit,
	onPause,
	onResume,
}: {
	open: boolean;
	currentSessionId: string | null;
	learning: {
		state: LearningState | null;
		isLoading: boolean;
		isSaving: boolean;
		error: string | null;
	};
	readOnlySession: LearningReadOnlyReason | false;
	canPause: boolean;
	canResume: boolean;
	onToggle: () => void;
	onRetry: () => void;
	onInit: () => void;
	onPause: () => void;
	onResume: () => void;
}) {
	const { t } = useTranslation();
	const checkpoint = learning.state?.checkpoint;
	const question = (() => {
		const ref = checkpoint?.question;
		if (!ref) return undefined;
		return learning.state?.questions?.find(
			(item) => item.question_id === ref.question_id && item.question_version === ref.question_version,
		);
	})();

	return (
		<aside
			className={`mla-learn-status${open ? "" : " mla-learn-status--collapsed"}`}
			aria-label={t("learn.status.aria")}
		>
			<IconButton
				size="sm"
				className="mla-learn-status-toggle"
				aria-expanded={open}
				aria-label={open ? t("learn.status.collapse") : t("learn.status.expand")}
				onClick={onToggle}
			>
				{open ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
			</IconButton>
			{open ? (
				<section className="mla-card" aria-labelledby="learn-checkpoint">
					<div className="mla-card-header">
						<h2 id="learn-checkpoint">{t("learn.status.title")}</h2>
						{checkpoint ? (
							<Badge tone={checkpoint.status === "active" ? "accent" : "neutral"}>
								{t(STATUS_LABEL_KEY[checkpoint.status])}
							</Badge>
						) : null}
					</div>

					{!currentSessionId ? (
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{t("learn.status.noSession")}
						</p>
					) : learning.isLoading ? (
						<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
							<Loader2 size={14} className="mla-spin" aria-hidden="true" />
							{t("learn.status.loading")}
						</p>
					) : learning.error ? (
						<div>
							<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{learning.error}</p>
							<Button
								className="mla-inline"
								style={{ marginTop: 8 }}
								onClick={onRetry}
							>
								<RotateCcw size={14} />
								{t("learn.status.retry")}
							</Button>
						</div>
					) : !learning.state?.exists ? (
						<div className="mla-stack" style={{ gap: 10 }}>
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{readOnlySession
									? t("learn.status.noCheckpointReadOnly")
									: t("learn.status.noCheckpoint")}
							</p>
							{readOnlySession ? null : (
								<Button
									variant="primary"
									disabled={learning.isSaving}
									onClick={onInit}
								>
									{t("learn.status.initialize")}
								</Button>
							)}
						</div>
					) : checkpoint ? (
						<div className="mla-stack" style={{ gap: 12 }}>
							<dl className="mla-definition">
								<div>
									<dt>{t("learn.status.stepLabel")}</dt>
									<dd>{t(STEP_LABEL_KEY[checkpoint.step])}</dd>
								</div>
								<div>
									<dt>{t("learn.status.revision")}</dt>
									<dd>#{checkpoint.revision}</dd>
								</div>
							</dl>

							{question ? (
								<div>
									<span className="mla-overline">{t("learn.status.currentQuestion")}</span>
									<p className="mla-text" style={{ margin: "6px 0 0" }}>{question.prompt}</p>
									<span className="mla-small mla-muted">
										{t("learn.status.questionMeta", {
											id: question.question_id,
											version: question.question_version,
										})}
									</span>
								</div>
							) : (
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									{t("learn.status.noQuestion")}
								</p>
							)}

							{learning.state.pending_action ? (
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									{t(ACTION_LABEL_KEY[learning.state.pending_action])}
								</p>
							) : null}

							<div className="mla-inline">
								{canPause ? (
									<Button disabled={learning.isSaving} onClick={onPause}>
										<Pause size={14} />
										{t("learn.status.pause")}
									</Button>
								) : null}
								{canResume ? (
									<Button variant="primary" disabled={learning.isSaving} onClick={onResume}>
										<Play size={14} />
										{t("learn.status.resume")}
									</Button>
								) : null}
								{checkpoint.status === "completed" ? (
									<span className="mla-small mla-muted">{t("learn.status.completedLocked")}</span>
								) : null}
							</div>
						</div>
					) : null}
				</section>
			) : null}
		</aside>
	);
}
