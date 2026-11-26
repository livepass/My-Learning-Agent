import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import type { KnowledgeState } from "../../types/learner.js";
import {
	knowledgeStateLabelKey,
	knowledgeStateTone,
	normalizeKnowledgeStateLabel,
} from "../knowledge-state.js";
import { Badge, Button } from "../ui/index.js";
import { formatReviewDate, masteryPercent } from "./knowledge-format.js";
import { KnowledgeProvenance } from "./KnowledgeProvenance.js";

/**
 * Read-only knowledge detail (E4.9i-P2-2).
 *
 * P2-1 made the state trustworthy; this component keeps the *reading* task
 * separate from editing it. Before P2-2, expanding a row immediately mounted a
 * mastery slider and two textareas, so simply reading a diagnosis meant facing
 * an editable form.
 *
 * It renders only what the server stored: name, state, the mastery reference
 * number, the review date, the diagnosis and the next actions. It never
 * invents a diagnosis or a suggestion.
 */
export interface KnowledgeReadViewProps {
	state: KnowledgeState;
	/** Absent in the course-scoped view, which stays read-only. */
	onEdit?: () => void;
}

export function KnowledgeReadView({ state, onEdit }: KnowledgeReadViewProps) {
	const { t } = useTranslation();
	const label = normalizeKnowledgeStateLabel(state.state_label);
	const pct = masteryPercent(state.mastery);

	return (
		<div className="grid gap-2 rounded-xl bg-[var(--inno-surface-muted)] p-3">
			{/*
			 * E4.9i-P2-5-R1 (F01): the collapsed header clips a long name to one
			 * line on desktop (`.mla-knowledge-row__name` is ellipsised there), so
			 * before this the full name existed nowhere in the UI and the
			 * acceptance report's claim that it could be read was wrong.
			 *
			 * It is labelled rather than rendered bare: the other fields here read
			 * 「掌握度: …」「复习日期: …」, and a bare name would be a second exact
			 * match for the header's name text, which the existing tests (and a
			 * reader scanning for the row) resolve by text.
			 */}
			<div className="mla-knowledge-row__full-name">
				{t("profile.knowledge.concept")}: {state.concept_name}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={knowledgeStateTone(label)}>{t(knowledgeStateLabelKey(label))}</Badge>
				<span className="text-xs text-[var(--inno-text-subtle)]">
					{t("profile.knowledge.mastery")}: {pct}%
				</span>
				<span className="text-xs text-[var(--inno-text-subtle)]">
					{t("profile.knowledge.reviewDate")}: {formatReviewDate(state.review_due_at)}
				</span>
			</div>

			<div>
				<div className="mb-0.5 text-xs text-[var(--inno-text-subtle)]">{t("profile.knowledge.diagnosis")}</div>
				<p className="m-0 whitespace-pre-wrap text-sm text-[var(--inno-text-muted)]">
					{state.diagnosis || t("profile.knowledge.noDiagnosis")}
				</p>
			</div>

			{/*
			 * E4.9i-P2-6 (T02): where this record came from and what its evidence
			 * count means, placed after the state/mastery/date block and before the
			 * diagnosis detail. `withNotes` is on here because the reading view has
			 * room for the two caveats; the course row shows the same facts without
			 * the paragraphs.
			 */}
			<KnowledgeProvenance
				origin={state.origin}
				provenance_unknown={state.provenance_unknown}
				evidenceIds={state.evidence_ids}
				withNotes
				className="mla-knowledge-row__provenance"
			/>

			<div>
				<div className="mb-0.5 text-xs text-[var(--inno-text-subtle)]">{t("profile.knowledge.nextActions")}</div>
				{state.next_actions.length > 0 ? (
					<ul className="m-0 list-disc pl-5 text-sm text-[var(--inno-text-muted)]">
						{state.next_actions.map((action) => (
							<li key={action}>{action}</li>
						))}
					</ul>
				) : (
					<p className="m-0 text-sm text-[var(--inno-text-subtle)]">{t("profile.knowledge.noNextActions")}</p>
				)}
			</div>

			{onEdit ? (
				<div className="flex justify-end">
					<Button variant="secondary" size="xs" onClick={onEdit}>
						<Pencil size={12} aria-hidden="true" />
						{t("profile.knowledge.edit")}
					</Button>
				</div>
			) : null}
		</div>
	);
}
