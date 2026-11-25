import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { KnowledgeState } from "../../types/learner.js";
import { KnowledgeStateBadge } from "./KnowledgeStateBadge.js";
import { useKnowledgeDraftGuard } from "./KnowledgeDraftGuard.js";
import { KnowledgeEditPanel, type KnowledgeDraft } from "./KnowledgeEditPanel.js";
import { KnowledgeReadView } from "./KnowledgeReadView.js";
import { formatReviewDate, masteryPercent } from "./knowledge-format.js";

/**
 * One knowledge row and its three-level interaction (E4.9i-P2-2 / R1).
 *
 *   collapsed  → the summary line only
 *   reading    → the stored diagnosis / next actions, no inputs
 *   editing    → the draft form, reached only by pressing 「编辑」
 *
 * Expanding a row must never open the editor: that was the P1 behaviour and it
 * forced anyone who wanted to read a diagnosis into an editable form.
 *
 * R1 closes the exit paths:
 *
 * - the header click now asks `KnowledgeDraftGuard` first, so a dirty draft
 *   needs one confirmation and a save in flight blocks the collapse;
 * - the collapse is recorded in `mode`, and a save that resolves later only
 *   returns to `reading` when the row is *still* editing. Before R1 the late
 *   resolve called `setMode("reading")` unconditionally and re-opened a row the
 *   learner had closed.
 */
export type KnowledgeRowMode = "collapsed" | "reading" | "editing";

export interface KnowledgeRowProps {
	state: KnowledgeState;
	/**
	 * Absent makes the row read-only. The course view passes nothing, which is
	 * why it cannot reach the editor at all rather than hiding it behind a flag.
	 */
	onSave?: (patch: KnowledgeDraft) => Promise<void>;
	/** Colour of the mastery bar; the same neutral accent in both views. */
	barColor?: string;
	/**
	 * True when this row is on screen only because an editor is open, after the
	 * server moved the concept out of the selected filter (E4.9i-P2-4-R1).
	 *
	 * The row is not a filter result and is not counted as one; it says so once
	 * so the learner understands why it is still here.
	 */
	protectedByFilter?: boolean;
	/**
	 * True when the latest profile no longer contains this concept at all.
	 *
	 * The row is kept only so the learner can read and copy an unsaved draft. It
	 * is not a profile record any more: saving it is refused by the store (the
	 * request would 404), and nothing here re-creates or overwrites it.
	 */
	missingFromProfile?: boolean;
}

export function KnowledgeRow({
	state,
	onSave,
	barColor,
	protectedByFilter = false,
	missingFromProfile = false,
}: KnowledgeRowProps) {
	const { t } = useTranslation();
	const guard = useKnowledgeDraftGuard();
	const [mode, setMode] = useState<KnowledgeRowMode>("collapsed");
	const [saving, setSaving] = useState(false);
	// Mirrors `mode` for the async path, which must read the value at resolve
	// time rather than the one captured when `save()` started.
	const modeRef = useRef<KnowledgeRowMode>("collapsed");
	const pct = masteryPercent(state.mastery);
	const expanded = mode !== "collapsed";

	const changeMode = useCallback((next: KnowledgeRowMode) => {
		modeRef.current = next;
		setMode(next);
	}, []);

	/**
	 * Header click.
	 *
	 * Collapsing while editing leaves the editor, so it takes the same verdict
	 * as every other exit: a pending save refuses, a dirty draft asks once.
	 */
	function toggle() {
		if (!expanded) {
			changeMode("reading");
			return;
		}
		if (mode === "editing") {
			if (saving) return;
			if (!guard.confirmLeave()) return;
		}
		changeMode("collapsed");
	}

	async function save(patch: KnowledgeDraft) {
		if (!onSave) return;
		// R2: the row's own entry refuses too, so the guarantee does not depend on
		// the panel's disabled button. A concept the latest profile dropped must
		// not receive a new PATCH, and this is the only path to `onSave`.
		if (missingFromProfile) return;
		setSaving(true);
		try {
			await onSave(patch);
			// Only a row that is still editing returns to reading. A row the
			// learner collapsed mid-save stays collapsed; a rejection propagates
			// to the edit panel, which keeps the draft and shows the error.
			if (modeRef.current === "editing") changeMode("reading");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="mla-knowledge-row">
			<button
				className="mla-knowledge-row__header"
				onClick={toggle}
				aria-expanded={expanded}
			>
				{/*
				 * E4.9i-P2-5: the fixed 170/42/110px columns were the mobile
				 * defect. Below the container breakpoint the header regroups: the
				 * name takes the first line beside the badge and chevron, then the
				 * mastery bar and the date each span a full line — so the name
				 * wraps instead of being clipped, the bar keeps a real width and
				 * the badge stays visible.
				 */}
				<div className="mla-knowledge-row__identity">
					<div className="mla-knowledge-row__name">{state.concept_name}</div>
					<div className="mla-knowledge-row__domain">{state.domain || state.concept_id}</div>
				</div>
				<div className="mla-knowledge-row__mastery">
					<div className="mla-knowledge-row__progress">
						<div
							className="mla-knowledge-row__bar"
							style={{ width: `${pct}%`, background: barColor ?? "var(--inno-accent)" }}
						/>
					</div>
					<span className="mla-knowledge-row__percentage">{pct}%</span>
				</div>
				<KnowledgeStateBadge stateLabel={state.state_label} className="mla-knowledge-row__badge" />
				{/*
				 * Only a real date renders. A dash would claim "no review", which
				 * is the server's review-eligibility answer, not this row's.
				 */}
				{state.review_due_at ? (
					<span className="mla-knowledge-row__date">
						<span className="mla-knowledge-row__date-label">{t("profile.knowledge.reviewDate")}</span>
						<span className="mla-knowledge-row__date-value">{formatReviewDate(state.review_due_at)}</span>
					</span>
				) : null}
				<ChevronDown
					size={14}
					aria-hidden="true"
					className={`mla-knowledge-row__toggle ${expanded ? "" : "-rotate-90"}`}
				/>
			</button>
			{expanded ? (
				<div className="mla-knowledge-row__body">
					{protectedByFilter ? (
						<p role="status" className="m-0 mb-2 rounded-lg bg-[var(--inno-warning-bg)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--inno-warning)]">
							{missingFromProfile
								? t("profile.knowledge.missingDraft")
								: t("profile.knowledge.protectedDraft")}
						</p>
					) : null}
					{mode === "editing" && onSave ? (
						<KnowledgeEditPanel
							state={state}
							saving={saving}
							saveDisabled={missingFromProfile}
							onCancel={() => changeMode("reading")}
							onSave={save}
						/>
					) : (
						<KnowledgeReadView
							state={state}
							onEdit={onSave ? () => changeMode("editing") : undefined}
						/>
					)}
				</div>
			) : null}
		</div>
	);
}
