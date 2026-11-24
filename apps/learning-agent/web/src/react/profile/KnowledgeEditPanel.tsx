import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { KnowledgeState } from "../../types/learner.js";
import { Button, Textarea } from "../ui/index.js";
import { masteryPercent } from "./knowledge-format.js";

/**
 * Draft editing for one knowledge state (E4.9i-P2-2).
 *
 * The panel owns the draft and the failure text, and hands the finished patch
 * back through `onSave`. It deliberately does **not** import `learnerStore`:
 * the container decides which store call to make, so the course view can keep
 * this panel out of reach while the all-courses view wires it to
 * `patchKnowledge()`.
 *
 * What the panel must never do:
 * - write `state_label`, `review_due_at`, `evidence_ids` or `course_id` — the
 *   patch stays exactly the three fields the server accepts from a learner;
 * - treat a local draft as saved. Only the container's resolved promise closes
 *   the editor, so a rejected save leaves the user's text in place.
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
}

export function KnowledgeEditPanel({ state, onSave, onCancel, saving }: KnowledgeEditPanelProps) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<KnowledgeDraft>({
		diagnosis: state.diagnosis,
		nextActions: state.next_actions,
		mastery: state.mastery,
	});
	const [error, setError] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);

	function update(next: Partial<KnowledgeDraft>) {
		setDraft((current) => ({ ...current, ...next }));
		setDirty(true);
	}

	async function submit() {
		if (saving) return;
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

	function cancel() {
		if (dirty && typeof window !== "undefined" && !window.confirm(t("profile.knowledge.discardConfirm"))) return;
		onCancel();
	}

	return (
		<div className="grid gap-2 rounded-xl bg-[var(--inno-surface-muted)] p-3">
			<label className="block text-xs">
				<span className="mb-0.5 block text-[var(--inno-text-subtle)]">
					{t("profile.knowledge.mastery")}: {masteryPercent(draft.mastery)}%
				</span>
				<input
					type="range"
					min={0}
					max={100}
					aria-label={t("profile.knowledge.mastery")}
					value={masteryPercent(draft.mastery)}
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
				<Button variant="primary" size="xs" disabled={saving} onClick={() => void submit()}>
					{saving ? t("common.saving") : t("common.save")}
				</Button>
			</div>
		</div>
	);
}
