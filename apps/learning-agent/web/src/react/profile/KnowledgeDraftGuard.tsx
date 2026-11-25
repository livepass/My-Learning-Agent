import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * One exit policy for every way out of a knowledge edit (E4.9i-P2-2-R1).
 *
 * Before R1 each exit decided for itself — and mostly decided nothing:
 *
 * - clicking the row header collapsed the row and dropped the draft;
 * - collapsing the 知识状态 section unmounted the editor;
 * - switching course range unmounted the whole panel;
 * - a save that resolved after a collapse re-opened the row.
 *
 * Three components would otherwise each need their own "is anything dirty?"
 * question and their own confirm. Instead every editor registers here, and the
 * *containers* ask once:
 *
 *   canLeave() → "ok" | "dirty" | "saving"
 *
 * `saving` is a hard block: the request is already on the wire, so a collapse
 * or a course switch must not unmount the component that will apply its answer.
 * `dirty` means "ask the learner"; the caller shows one confirm for the whole
 * action, never one per concept.
 */

export type KnowledgeEditingStatus = {
	conceptId: string;
	dirty: boolean;
	saving: boolean;
};

export type LeaveVerdict = "ok" | "dirty" | "saving";

export interface KnowledgeDraftGuardApi {
	/** Editors report their current state; call the returned function on unmount. */
	register: (status: KnowledgeEditingStatus) => () => void;
	/** Aggregate verdict for a would-be exit. */
	verdict: () => LeaveVerdict;
	/** True when at least one editor holds unsaved changes. */
	isDirty: () => boolean;
	/** True when at least one save is in flight. */
	isSaving: () => boolean;
	/**
	 * Ask to leave, confirming once if needed.
	 *
	 * Returns true when the caller may proceed. A `saving` verdict never asks —
	 * it refuses, because discarding a pending request is not the learner's
	 * call to make from a collapse button.
	 */
	confirmLeave: () => boolean;
}

const KnowledgeDraftGuardContext = createContext<KnowledgeDraftGuardApi | null>(null);

export function KnowledgeDraftGuardProvider({ children }: { children: ReactNode }) {
	const { t } = useTranslation();
	// A ref, not state: registration must not re-render every row, and the
	// verdict is only read inside event handlers.
	const editors = useRef(new Map<string, KnowledgeEditingStatus>());

	const register = useCallback((status: KnowledgeEditingStatus) => {
		editors.current.set(status.conceptId, status);
		return () => {
			editors.current.delete(status.conceptId);
		};
	}, []);

	const verdict = useCallback((): LeaveVerdict => {
		let dirty = false;
		for (const status of editors.current.values()) {
			if (status.saving) return "saving";
			if (status.dirty) dirty = true;
		}
		return dirty ? "dirty" : "ok";
	}, []);

	const api = useMemo<KnowledgeDraftGuardApi>(() => ({
		register,
		verdict,
		isDirty: () => verdict() === "dirty",
		isSaving: () => verdict() === "saving",
		confirmLeave: () => {
			const next = verdict();
			if (next === "saving") return false;
			if (next === "ok") return true;
			return typeof window === "undefined" || window.confirm(t("profile.knowledge.discardConfirm"));
		},
	}), [register, verdict, t]);

	return (
		<KnowledgeDraftGuardContext.Provider value={api}>
			{children}
		</KnowledgeDraftGuardContext.Provider>
	);
}

/**
 * The guard for the current profile page, or a no-op stand-in.
 *
 * A row rendered outside the provider (component tests, a future reuse) still
 * gets the old, safe behaviour: its own confirm, and no aggregate verdict.
 */
export function useKnowledgeDraftGuard(): KnowledgeDraftGuardApi {
	const guard = useContext(KnowledgeDraftGuardContext);
	const { t } = useTranslation();
	const fallback = useMemo<KnowledgeDraftGuardApi>(() => ({
		register: () => () => {},
		verdict: () => "ok",
		isDirty: () => false,
		isSaving: () => false,
		confirmLeave: () => typeof window === "undefined" || window.confirm(t("profile.knowledge.discardConfirm")),
	}), [t]);
	return guard ?? fallback;
}
