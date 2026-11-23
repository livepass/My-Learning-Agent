import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import type { PublicLearningQuestion } from "../../../api/learning.js";
import { Button, inputCls } from "../../ui/index.js";

export type PracticeGeneratorKind = PublicLearningQuestion["kind"] | "";

export interface PracticeConceptOption {
	concept_id: string;
	concept_name: string;
}

export interface PracticeGoalOption {
	goal_id: string;
	title: string;
}

export type PracticeGeneratorFormProps = {
	/** Unique per mounted form, so two forms never share label/input ids. */
	conceptInputId: string;
	concept: string;
	kind: PracticeGeneratorKind;
	goalId: string;
	allowModelFallback: boolean;
	/** Profile concepts, used for the datalist and trusted-name matching. */
	concepts: PracticeConceptOption[];
	goals: PracticeGoalOption[];
	generating: boolean;
	generateError: string | null;
	/** False when the checkpoint is not at a state that accepts a new question. */
	canGenerate: boolean;
	/** False for an empty concept or a synthetic id used as a name. */
	conceptIsUsable: boolean;
	conceptIsSynthetic: boolean;
	/** True for 「再练一道」; only changes the hint copy. */
	continuation: boolean;
	actionLabel: string;
	onConceptChange: (value: string) => void;
	onKindChange: (value: PracticeGeneratorKind) => void;
	onGoalChange: (value: string) => void;
	onAllowFallbackChange: (value: boolean) => void;
	onGenerate: () => void;
	onCancel?: () => void;
};

/**
 * E4.9h-P2-1 — the one generation form, shared by the first question and
 * 「再练一道」.
 *
 * Extracted from `PracticePage.generatorForm()` with the markup, class names
 * and aria wiring unchanged. Every value and every write goes through props:
 * this component owns no request, no store and no draft state, so the page
 * stays the single place where generation is decided and dispatched.
 *
 * What stays with the page (deliberately):
 *
 * - whether generating is allowed at all (`canGenerate`, i.e. the server's
 *   `canCommitNextQuestion` mirror — it already folds in "not generating");
 * - `after_attempt_id` for a continuation — the page decides it, not the form;
 * - the trusted-name rule: a synthetic id is never usable as a concept label.
 */
export function PracticeGeneratorForm({
	conceptInputId,
	concept,
	kind,
	goalId,
	allowModelFallback,
	concepts,
	goals,
	generating,
	generateError,
	canGenerate,
	conceptIsUsable,
	conceptIsSynthetic,
	continuation,
	actionLabel,
	onConceptChange,
	onKindChange,
	onGoalChange,
	onAllowFallbackChange,
	onGenerate,
	onCancel,
}: PracticeGeneratorFormProps) {
	const { t } = useTranslation();

	return (
		<div className="mla-stack" style={{ gap: 14 }}>
			<div className="mla-stack" style={{ gap: 10 }}>
				<label className="mla-small" htmlFor={conceptInputId}>{t("practice.generator.concept")}</label>
				<input
					id={conceptInputId}
					className={inputCls}
					list="practice-concept-options"
					placeholder={t("practice.generator.conceptPlaceholder")}
					value={concept}
					maxLength={120}
					onChange={(event) => onConceptChange(event.target.value)}
					disabled={generating}
				/>
				<datalist id="practice-concept-options">
					{concepts.map((item) => (
						<option key={item.concept_id} value={item.concept_name} />
					))}
				</datalist>
				<span className="mla-small mla-muted">
					{conceptIsSynthetic
						? t("practice.generator.conceptSynthetic")
						: t("practice.generator.conceptHint")}
				</span>
			</div>

			{goals.length > 0 ? (
				<div className="mla-stack" style={{ gap: 10 }}>
					<label className="mla-small" htmlFor={`${conceptInputId}-goal`}>
						{t("practice.generator.goal")}
					</label>
					<select
						id={`${conceptInputId}-goal`}
						className={inputCls}
						value={goalId}
						onChange={(event) => onGoalChange(event.target.value)}
						disabled={generating}
					>
						<option value="">{t("practice.generator.noGoal")}</option>
						{goals.map((goal) => (
							<option key={goal.goal_id} value={goal.goal_id}>{goal.title}</option>
						))}
					</select>
				</div>
			) : null}

			<div className="mla-stack" style={{ gap: 10 }}>
				<label className="mla-small" htmlFor={`${conceptInputId}-kind`}>{t("practice.generator.kindLabel")}</label>
				<select
					id={`${conceptInputId}-kind`}
					className={inputCls}
					value={kind}
					onChange={(event) => onKindChange(event.target.value as PracticeGeneratorKind)}
					disabled={generating}
				>
					<option value="">{t("practice.generator.kindAuto")}</option>
					<option value="free_recall">{t("practice.generator.kind.freeRecall")}</option>
					<option value="application">{t("practice.generator.kind.application")}</option>
					<option value="transfer">{t("practice.generator.kind.transfer")}</option>
				</select>
			</div>

			<label className="mla-small mla-inline" style={{ gap: 8, cursor: "pointer" }}>
				<input
					type="checkbox"
					checked={allowModelFallback}
					onChange={(event) => onAllowFallbackChange(event.target.checked)}
					disabled={generating}
				/>
				{t("practice.generator.allowFallback")}
			</label>

			<div className="mla-inline">
				<Button
					variant="primary"
					disabled={!canGenerate || !conceptIsUsable}
					onClick={onGenerate}
				>
					{generating ? <Loader2 size={14} className="mla-spin" /> : <Sparkles size={14} />}
					{generating ? t("practice.generator.generating") : actionLabel}
				</Button>
				{onCancel ? (
					<Button onClick={onCancel} disabled={generating}>{t("practice.generator.cancel")}</Button>
				) : null}
				<span className="mla-small mla-muted">
					{continuation
						? t("practice.generator.continuationHint")
						: t("practice.generator.singleHint")}
				</span>
			</div>

			{generateError ? (
				<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
					{generateError}
				</p>
			) : null}
		</div>
	);
}
