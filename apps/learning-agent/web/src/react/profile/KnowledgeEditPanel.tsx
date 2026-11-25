import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KnowledgeState } from "../../types/learner.js";
import { Button, Textarea } from "../ui/index.js";
import { useKnowledgeDraftGuard, type KnowledgeEditingStatus } from "./KnowledgeDraftGuard.js";
import { masteryPercent } from "./knowledge-format.js";

/**
 * Draft editing for one knowledge state (E4.9i-P2-2 / R1).
 *
 * The panel owns the draft and the failure text, and hands the finished patch
 * back through `onSave`. It deliberately does **not** import `learnerStore`:
 * the container decides which store call to make, so the course view can keep
 * this panel out of reach while the all-courses view wires it to
 * `patchKnowledge()`.
 *
 * R1 changes:
 *
 * - `dirty` is a *comparison*, not an onChange flag. Typing a value and typing
 *   it back leaves nothing to confirm. The baseline is a snapshot taken when
 *   the editor opened, so a server refresh that changes `state` does not
 *   silently rewrite what the learner is editing.
 * - The editor registers with `KnowledgeDraftGuard`, which is the one place
 *   that decides whether a collapse or a course switch may proceed.
 * - Every control is disabled while a save is in flight, so the draft cannot
 *   change underneath the request.
 */
export interface KnowledgeDraft {
	diagnosis: string;
	nextActions: string[];
	mastery: number;
}

export interface KnowledgeEditPanelProps {
	state: KnowledgeState;
	onSave: (patch: KnowledgeDraft) => Promise<void>;
	onCancel: () => void;
	/** True while a save is in flight; blocks a second submit. */
	saving: boolean;
	/**
	 * True when the latest profile no longer contains this concept (E4.9i-P2-4-R2).
	 *
	 * The editor stays mounted so the learner can read and copy the draft, but a
	 * save would PATCH a concept the server has already dropped. The control is
	 * disabled *and* `submit()` refuses, so neither a click nor a stray call gets
	 * through; the panel is not made read-only by dropping `onSave`, which would
	 * unmount the draft instead of protecting it.
	 */
	saveDisabled?: boolean;
}

function snapshotOf(state: KnowledgeState): KnowledgeDraft {
	return {
		diagnosis: state.diagnosis,
		nextActions: state.next_actions,
		mastery: state.mastery,
	};
}

/** Same three fields, same order — a draft that returned to the saved values is not dirty. */
function sameDraft(a: KnowledgeDraft, b: KnowledgeDraft): boolean {
	return a.mastery === b.mastery
		&& a.diagnosis === b.diagnosis
		&& a.nextActions.length === b.nextActions.length
		&& a.nextActions.every((value, index) => value === b.nextActions[index]);
}

export function KnowledgeEditPanel({ state, onSave, onCancel, saving, saveDisabled = false }: KnowledgeEditPanelProps) {
	const { t } = useTranslation();
	const guard = useKnowledgeDraftGuard();
	// The baseline never follows later props: a refresh must not redefine
	// "unchanged" while the learner is typing.
	const baseline = useRef<KnowledgeDraft>(snapshotOf(state));
	const [draft, setDraft] = useState<KnowledgeDraft>(baseline.current);
	const [error, setError] = useState<string | null>(null);

	const dirty = !sameDraft(draft, baseline.current);

	/**
	 * Register once per editor mount, not on every dirty/saving flip.
	 *
	 * E4.9i-P2-4-R1: re-registering on each change runs the previous cleanup
	 * first, which momentarily removed the concept from the guard's map. A
	 * container that keeps rows mounted while an editor is open could then see
	 * "no editor" for one commit and unmount the row mid-edit. The registration
	 * now carries a mutable status object that this effect keeps current, so the
	 * map entry lives exactly as long as the editor does.
	 */
	const statusRef = useRef<KnowledgeEditingStatus>({ conceptId: state.concept_id, dirty, saving });
	// One object for the whole mount: the guard keeps it by reference, so
	// replacing it would leave the map pointing at stale data.
	statusRef.current.conceptId = state.concept_id;
	statusRef.current.dirty = dirty;
	statusRef.current.saving = saving;

	useEffect(() => {
		return guard.register(statusRef.current);
	}, [guard, state.concept_id]);

	function update(next: Partial<KnowledgeDraft>) {
		if (saving) return;
		setDraft((current) => ({ ...current, ...next }));
	}

	async function submit() {
		// R2: the disabled control is the first line; this is the second, so a
		// keyboard submit or a future caller cannot PATCH a dropped concept.
		if (saving || saveDisabled) return;
		setError(null);
		try {
			await onSave(draft);
		} catch (err) {
			// Stay in the editor with the learner's own words: a failed save must
			// not look like a successful one, and retyping it would be worse.
			setError(t("profile.knowledge.saveFailed", {
				message: err instanceof Error ? err.message : String(err),
			}));
		}
	}

	/** Cancelling goes through the same guard as every other exit. */
	function cancel() {
		if (saving) return;
		if (dirty && !guard.confirmLeave()) return;
		onCancel();
	}

	const pct = useMemo(() => masteryPercent(draft.mastery), [draft.mastery]);

	return (
		<div className="grid gap-2 rounded-xl bg-[var(--inno-surface-muted)] p-3">
			<label className="block text-xs">
				<span className="mb-0.5 block text-[var(--inno-text-subtle)]">
					{t("profile.knowledge.mastery")}: {pct}%
				</span>
				<input
					type="range"
					min={0}
					max={100}
					aria-label={t("profile.knowledge.mastery")}
					value={pct}
					disabled={saving}
					onChange={(e) => update({ mastery: Number(e.target.value) / 100 })}
					className="w-full"
				/>
			</label>
			<label className="block text-xs">
				<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.knowledge.diagnosis")}</span>
				<Textarea
					className="h-20 max-w-[780px] rounded-lg px-2 py-1.5 text-sm"
					placeholder={t("profile.knowledge.diagnosisPlaceholder") ?? ""}
					aria-label={t("profile.knowledge.diagnosis")}
					value={draft.diagnosis}
					disabled={saving}
					onChange={(e) => update({ diagnosis: e.target.value })}
				/>
			</label>
			<label className="block text-xs">
				<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.knowledge.nextActions")}</span>
				<Textarea
					className="h-20 max-w-[780px] rounded-lg px-2 py-1.5 text-sm"
					placeholder={t("profile.knowledge.nextActionsPlaceholder") ?? ""}
					aria-label={t("profile.knowledge.nextActions")}
					value={draft.nextActions.join("\n")}
					disabled={saving}
					onChange={(e) => update({ nextActions: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
				/>
			</label>
			{error ? (
				<p role="alert" className="m-0 text-xs text-[var(--inno-danger)]">{error}</p>
			) : null}
			<p className="m-0 text-[11px] leading-snug text-[var(--inno-text-subtle)]">
				{t("profile.knowledge.manualNotice")}
			</p>
			<div className="flex justify-end gap-2 pt-1">
				<Button variant="secondary" size="xs" disabled={saving} onClick={cancel}>
					{t("common.cancel")}
				</Button>
				<Button variant="primary" size="xs" disabled={saving || saveDisabled} onClick={() => void submit()}>
					{saving ? t("common.saving") : t("common.save")}
				</Button>
			</div>
		</div>
	);
}
