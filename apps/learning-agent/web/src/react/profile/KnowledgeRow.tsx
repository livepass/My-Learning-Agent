import { useCallback, useRef, useState } from "react";
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
}

export function KnowledgeRow({ state, onSave, barColor }: KnowledgeRowProps) {
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
		<div className="border-b border-[var(--inno-border)] last:border-b-0">
			<button
				className="flex w-full items-center gap-3 px-1 py-[11px] text-left"
				onClick={toggle}
				aria-expanded={expanded}
			>
				<div className="w-[170px] min-w-0 shrink-0">
					<div className="truncate text-[13.5px] font-medium text-[var(--inno-text)]">{state.concept_name}</div>
					<div className="truncate text-xs text-[var(--inno-text-subtle)]">{state.domain || state.concept_id}</div>
				</div>
				<div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-[var(--inno-chip-bg)]">
					<div
						className="h-full rounded"
						style={{ width: `${pct}%`, background: barColor ?? "var(--inno-accent)" }}
					/>
				</div>
				<span className="w-[42px] shrink-0 text-right text-xs text-[var(--inno-text-subtle)]">{pct}%</span>
				<KnowledgeStateBadge stateLabel={state.state_label} className="shrink-0 justify-center" />
				<span className="hidden w-[110px] shrink-0 text-right text-xs text-[var(--inno-text-subtle)] sm:block">
					{state.review_due_at ? formatReviewDate(state.review_due_at) : "-"}
				</span>
				<ChevronDown
					size={14}
					aria-hidden="true"
					className={`shrink-0 text-[var(--inno-text-subtle)] transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`}
				/>
			</button>
			{expanded ? (
				<div className="pb-3 pl-1 pr-1">
					{mode === "editing" && onSave ? (
						<KnowledgeEditPanel
							state={state}
							saving={saving}
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
