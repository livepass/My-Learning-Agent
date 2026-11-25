import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useSyncExternalStore,
	type ReactNode,
} from "react";
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
	 *
	 * `message` lets one caller say what *its* exit hides (E4.9i-P2-4-R1: a
	 * filter switch may hide editors). Omitting it keeps the original copy, so
	 * collapse and course-switch prompts are unchanged.
	 */
	confirmLeave: (message?: string) => boolean;
	/**
	 * Subscribe to changes in the set of open editors (E4.9i-P2-4-R1).
	 *
	 * `verdict()` is read inside event handlers, where a ref is enough. A
	 * *render* that must keep an editor mounted cannot read a ref — it needs to
	 * re-render when an editor opens or closes. This is the same registration
	 * data exposed through `useSyncExternalStore`, so there is still one map and
	 * one writer.
	 */
	subscribe: (listener: () => void) => () => void;
	/** Stable string of open editor ids; changes only when the set changes. */
	getSnapshot: () => string;
}

const KnowledgeDraftGuardContext = createContext<KnowledgeDraftGuardApi | null>(null);

export function KnowledgeDraftGuardProvider({ children }: { children: ReactNode }) {
	const { t } = useTranslation();
	// A ref, not state: registration must not re-render every row, and the
	// verdict is only read inside event handlers.
	const editors = useRef(new Map<string, KnowledgeEditingStatus>());
	// Subscribers are told only when the *set* of open editors changes, not on
	// every dirty/saving flip: a render that keeps a row mounted only cares
	// about whether an editor exists at all.
	const listeners = useRef(new Set<() => void>());
	const openIds = useRef("");

	const emit = useCallback(() => {
		for (const listener of listeners.current) listener();
	}, []);

	const recomputeOpenIds = useCallback(() => {
		const next = [...editors.current.keys()].sort().join("\u0000");
		if (next === openIds.current) return false;
		openIds.current = next;
		return true;
	}, []);

	const register = useCallback((status: KnowledgeEditingStatus) => {
		editors.current.set(status.conceptId, status);
		if (recomputeOpenIds()) emit();
		return () => {
			// Only the entry this registration created may be removed. If the same
			// concept re-registered (a new editor mounted before the old effect's
			// cleanup ran), the cleanup must not delete the live record.
			if (editors.current.get(status.conceptId) !== status) return;
			editors.current.delete(status.conceptId);
			if (recomputeOpenIds()) emit();
		};
	}, [emit, recomputeOpenIds]);

	const subscribe = useCallback((listener: () => void) => {
		listeners.current.add(listener);
		return () => {
			listeners.current.delete(listener);
		};
	}, []);

	const getSnapshot = useCallback(() => openIds.current, []);

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
		confirmLeave: (message?: string) => {
			const next = verdict();
			if (next === "saving") return false;
			if (next === "ok") return true;
			return typeof window === "undefined"
				|| window.confirm(message ?? t("profile.knowledge.discardConfirm"));
		},
		subscribe,
		getSnapshot,
	}), [register, verdict, t, subscribe, getSnapshot]);

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
		confirmLeave: (message?: string) => typeof window === "undefined"
			|| window.confirm(message ?? t("profile.knowledge.discardConfirm")),
		subscribe: () => () => {},
		getSnapshot: () => "",
	}), [t]);
	return guard ?? fallback;
}

/**
 * The concept ids with an editor currently open (E4.9i-P2-4-R1).
 *
 * A *render-time* view of the guard's registrations, for a container that must
 * keep a row mounted even after the server moved it out of the current filter.
 * `useKnowledgeDraftGuard().verdict()` stays the event-time API; this hook is
 * only for deciding what to render.
 *
 * The snapshot is a joined string, so `useSyncExternalStore` sees a primitive
 * and does not re-render on every registration object.
 */
export function useOpenKnowledgeEditors(): Set<string> {
	const guard = useKnowledgeDraftGuard();
	const snapshot = useSyncExternalStore(guard.subscribe, guard.getSnapshot, guard.getSnapshot);
	return useMemo(
		() => new Set(snapshot ? snapshot.split("\u0000") : []),
		[snapshot],
	);
}
