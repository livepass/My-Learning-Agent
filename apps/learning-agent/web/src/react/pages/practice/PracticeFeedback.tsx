import { useTranslation } from "react-i18next";
import { Check, CircleDashed, Minus, X } from "lucide-react";
import type { PublicAssessment, PublicCriterionJudgment } from "../../../api/learning.js";
import { Badge, type BadgeTone } from "../../ui/index.js";

/**
 * E4.9h-P2-3 — the scored feedback block, in three reading layers.
 *
 *   1. overview  — the result badge and the score, read first;
 *   2. criteria  — each rubric dimension with its judgment and explanation;
 *   3. body      — the model's feedback verbatim, plus `unknown_reason`.
 *
 * The page decides *which* assessment applies (the durable one on the current
 * attempt, falling back to the response-scoped copy while a re-read is in
 * flight, and always scoped to the open conversation and question); this
 * component only renders what it is given.
 *
 * It holds no state of its own on purpose: a second copy of the score is how
 * "the previous question's result" would reappear.
 */

/**
 * Result → badge tone. A display mapping only: nothing here can change the
 * business state, and the labels themselves come from `practice.result.*`.
 */
const RESULT_TONE: Record<PublicAssessment["result"], BadgeTone> = {
	correct: "success",
	partial: "warning",
	incorrect: "danger",
	unknown: "neutral",
};

/**
 * Judgment → copy key, icon and tone.
 *
 * `unknown` is deliberately *not* the same as `not_met`: "could not judge" is
 * not "did not meet", so it keeps its own word and a neutral mark.
 */
const JUDGMENT: Record<
	PublicCriterionJudgment["judgment"],
	{ key: string; tone: "success" | "warning" | "danger" | "neutral"; icon: typeof Check }
> = {
	met: { key: "practice.evaluate.judgment.met", tone: "success", icon: Check },
	partially_met: { key: "practice.evaluate.judgment.partiallyMet", tone: "warning", icon: Minus },
	not_met: { key: "practice.evaluate.judgment.notMet", tone: "danger", icon: X },
	unknown: { key: "practice.evaluate.judgment.unknown", tone: "neutral", icon: CircleDashed },
};

export function PracticeFeedback({ assessment }: { assessment: PublicAssessment | null }) {
	const { t } = useTranslation();
	if (!assessment) return null;

	const { result, score, feedback, unknown_reason: unknownReason, criteria } = assessment;

	return (
		<section className="mla-practice-feedback" aria-label={t("practice.evaluate.feedbackTitle")}>
			{/* 1 — result and score */}
			<div className="mla-practice-feedback-head">
				<strong className="mla-practice-feedback-title">{t("practice.evaluate.feedbackTitle")}</strong>
				<Badge tone={RESULT_TONE[result]}>{t(`practice.result.${result}`)}</Badge>
				{/*
				 * The existing `practice.evaluate.score` key formats the line, so
				 * both locales read as one sentence. `typeof === "number"` keeps a
				 * real 0 visible and never invents a score the server did not send.
				 */}
				{typeof score === "number" ? (
					<span className="mla-practice-feedback-score">
						{t("practice.evaluate.score", { score: Math.round(score * 100) })}
					</span>
				) : null}
			</div>

			{/* `unknown` explains itself; it is never painted as a wrong answer. */}
			{unknownReason ? (
				<div className="mla-practice-feedback-unknown">
					<span className="mla-practice-feedback-label">{t("practice.evaluate.unknownReasonLabel")}</span>
					<p className="mla-small" style={{ margin: 0 }}>{unknownReason}</p>
				</div>
			) : null}

			{/* 2 — rubric dimensions, in the server's own order */}
			{criteria.length > 0 ? (
				<div className="mla-practice-feedback-criteria">
					<span className="mla-practice-feedback-label">{t("practice.evaluate.criteriaTitle")}</span>
					<ul className="mla-practice-criteria">
						{criteria.map((item) => {
							const judgment = JUDGMENT[item.judgment] ?? JUDGMENT.unknown;
							const Icon = judgment.icon;
							return (
								<li key={item.criterion_id} className="mla-practice-criterion" data-judgment={item.judgment}>
									<span
										className="mla-practice-criterion-mark"
										data-tone={judgment.tone}
										aria-hidden="true"
									>
										<Icon size={12} strokeWidth={2.5} />
									</span>
									<div className="mla-practice-criterion-body">
										<div className="mla-practice-criterion-head">
											<code className="mla-practice-criterion-id">{item.criterion_id}</code>
											<span className="mla-practice-criterion-state" data-tone={judgment.tone}>
												{t(judgment.key)}
											</span>
										</div>
										<p className="mla-practice-criterion-explain">{item.explanation}</p>
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}

			{/* 3 — the model's own words, complete and unedited */}
			<div className="mla-practice-feedback-body">
				<span className="mla-practice-feedback-label">{t("practice.evaluate.aiFeedbackTitle")}</span>
				<p className="mla-practice-feedback-text">{feedback}</p>
			</div>
		</section>
	);
}
