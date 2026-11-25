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
	/**
	 * Concept ids with an editor currently open (E4.9i-P2-4-R1).
	 *
	 * The container appends rows outside the current filter so a refresh cannot
	 * unmount a draft; those rows are marked here so the learner can see why a
	 * concept that does not match the filter is still on screen.
	 */
	protectedIds?: ReadonlySet<string>;
	/** Protected rows whose concept is gone from the latest profile. */
	missingIds?: ReadonlySet<string>;
}

export function KnowledgeList({ states, onSave, emptyMessage, protectedIds, missingIds }: KnowledgeListProps) {
	const { t } = useTranslation();
	if (states.length === 0) {
		return (
			<p className="py-4 text-center text-[13px] text-[var(--inno-text-subtle)]">
				{emptyMessage ?? t("profile.knowledge.empty")}
			</p>
		);
	}
	return (
		/*
		 * `container-type: inline-size` lives on this element (shell.css), so the
		 * row breakpoint answers to the list's real width rather than the
		 * viewport: the same list sits inside a wide panel on desktop and a
		 * narrow card on a phone.
		 */
		<div className="mla-knowledge-list">
			{states.map((state) => (
				<KnowledgeRow
					key={state.concept_id}
					state={state}
					onSave={onSave ? (patch) => onSave(state.concept_id, patch) : undefined}
					protectedByFilter={protectedIds?.has(state.concept_id) ?? false}
					missingFromProfile={missingIds?.has(state.concept_id) ?? false}
				/>
			))}
		</div>
	);
}
