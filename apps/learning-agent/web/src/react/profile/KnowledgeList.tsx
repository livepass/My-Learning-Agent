import { useTranslation } from "react-i18next";
import type { KnowledgeState } from "../../types/learner.js";
import { KnowledgeRow } from "./KnowledgeRow.js";
import type { KnowledgeDraft } from "./KnowledgeEditPanel.js";

/**
 * The knowledge list itself (E4.9i-P2-2).
 *
 * A pure renderer: it takes the array the server returned, keeps that order,
 * keys rows by `concept_id`, and shows the empty state. It does not fetch, read
 * the course scope, compute a mastery state or decide review eligibility —
 * those belong to the container and the server respectively.
 */
export interface KnowledgeListProps {
	states: KnowledgeState[];
	/** Absent in the course-scoped view, which stays read-only. */
	onSave?: (conceptId: string, patch: KnowledgeDraft) => Promise<void>;
	emptyMessage?: string;
}

export function KnowledgeList({ states, onSave, emptyMessage }: KnowledgeListProps) {
	const { t } = useTranslation();
	if (states.length === 0) {
		return (
			<p className="py-4 text-center text-[13px] text-[var(--inno-text-subtle)]">
				{emptyMessage ?? t("profile.knowledge.empty")}
			</p>
		);
	}
	return (
		<div className="flex flex-col">
			{states.map((state) => (
				<KnowledgeRow
					key={state.concept_id}
					state={state}
					onSave={onSave ? (patch) => onSave(state.concept_id, patch) : undefined}
				/>
			))}
		</div>
	);
}
