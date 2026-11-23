import { useTranslation } from "react-i18next";
import { CircleDashed } from "lucide-react";
import type { PublicAssessment } from "../../../api/learning.js";

/**
 * E4.9h-P2-1 — the scored feedback block.
 *
 * Extracted from `.mla-practice-feedback` with the markup unchanged. The page
 * decides *which* assessment applies (the durable one on the current attempt,
 * falling back to the response-scoped copy while a re-read is in flight, and
 * always scoped to the open conversation and question); this component only
 * renders what it is given.
 *
 * It holds no state of its own on purpose: a second copy of the score is how
 * "the previous question's result" would reappear.
 */
export function PracticeFeedback({ assessment }: { assessment: PublicAssessment | null }) {
	const { t } = useTranslation();
	if (!assessment) return null;

	return (
		<div className="mla-practice-feedback">
			<strong className="mla-small">{t("practice.evaluate.feedbackTitle")}</strong>
			<p className="mla-text" style={{ margin: 0 }}>{assessment.feedback}</p>
			{assessment.unknown_reason ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("practice.evaluate.unknownReason", { reason: assessment.unknown_reason })}
				</p>
			) : null}
			{typeof assessment.score === "number" ? (
				<span className="mla-small mla-muted">
					{t("practice.evaluate.score", { score: Math.round(assessment.score * 100) })}
				</span>
			) : null}
			<ul className="mla-list">
				{assessment.criteria.map((item) => (
					<li key={item.criterion_id}>
						<CircleDashed size={14} aria-hidden="true" />
						<span>{t("practice.evaluate.criterion", { criterion: item.criterion_id, explanation: item.explanation })}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
