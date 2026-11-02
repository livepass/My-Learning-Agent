import { EventEmitter } from "./event-emitter.js";
import {
	describeLearningError,
	getLearningState,
	initLearning,
	pauseLearning,
	resumeLearning,
	type LearningState,
} from "../api/learning.js";

interface LearningStoreEvents {
	change: void;
}

/**
 * UI state for the current session's learning checkpoint.
 *
 * Deliberately not a second persistence layer: the authoritative record lives
 * on the server (`learning/<sessionId>.json`) and meta.json only carries a
 * rebuildable projection. This store mirrors the last read so the page can
 * render status/step/revision and offer pause/resume.
 *
 * Async isolation: every operation takes a monotonic ticket and re-checks both
 * the ticket *and* the session it belongs to before writing any UI field. A
 * response that lands after the user switched sessions (or cleared the
 * selection) is dropped, so a slow read for A can never paint over B, and the
 * `finally` of a stale request never clears the live request's spinner.
 */
class LearningStoreImpl extends EventEmitter<LearningStoreEvents> {
	sessionId: string | null = null;
	state: LearningState | null = null;
	isLoading = false;
	isSaving = false;
	error: string | null = null;
	/** Monotonic operation ticket; a newer operation invalidates older ones. */
	private _ticket = 0;

	/** Claim the ticket for a new operation, invalidating every older one. */
	private begin(): number {
		this._ticket += 1;
		return this._ticket;
	}

	/** True when `ticket` is no longer the newest operation for `sessionId`. */
	private isStale(ticket: number, sessionId: string): boolean {
		return ticket !== this._ticket || this.sessionId !== sessionId;
	}

	private notify(): void {
		this.emit("change", undefined);
	}

	/** Read-only load. Never initialises a missing record. */
	async load(sessionId: string): Promise<void> {
		const ticket = this.begin();
		if (this.sessionId !== sessionId) {
			// A save belongs to the session that started it; switching away must
			// not leave the new session permanently marked as saving.
			this.state = null;
			this.error = null;
			this.isSaving = false;
		}
		this.sessionId = sessionId;
		this.isLoading = true;
		this.notify();
		try {
			const state = await getLearningState(sessionId);
			if (this.isStale(ticket, sessionId)) return;
			this.state = state;
			this.error = null;
		} catch (err) {
			if (this.isStale(ticket, sessionId)) return;
			this.state = null;
			this.error = describeLearningError(err);
		} finally {
			if (!this.isStale(ticket, sessionId)) {
				this.isLoading = false;
				this.notify();
			}
		}
	}

	clear(): void {
		// Invalidate in-flight requests first: their responses must not restore
		// the state the caller just cleared.
		this.begin();
		this.sessionId = null;
		this.state = null;
		this.error = null;
		this.isLoading = false;
		this.isSaving = false;
		this.notify();
	}

	/** Explicit user action: create the record for the current session. */
	async init(goalId?: string): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId) return;
		const ticket = this.begin();
		this.isSaving = true;
		this.notify();
		try {
			await initLearning(sessionId, goalId);
			const state = await getLearningState(sessionId);
			if (this.isStale(ticket, sessionId)) return;
			this.state = state;
			this.error = null;
		} catch (err) {
			if (this.isStale(ticket, sessionId)) return;
			this.error = describeLearningError(err);
		} finally {
			if (!this.isStale(ticket, sessionId)) {
				this.isSaving = false;
				this.notify();
			}
		}
	}

	async pause(): Promise<void> {
		await this.transition("pause");
	}

	async resume(): Promise<void> {
		await this.transition("resume");
	}

	private async transition(action: "pause" | "resume"): Promise<void> {
		const sessionId = this.sessionId;
		const revision = this.state?.checkpoint?.revision;
		if (!sessionId || revision === undefined) return;
		const ticket = this.begin();
		this.isSaving = true;
		this.notify();
		try {
			const checkpoint = action === "pause"
				? await pauseLearning(sessionId, revision)
				: await resumeLearning(sessionId, revision);
			// The server already applied this to session A; only the UI write is
			// conditional, so switching to B never shows A's checkpoint.
			if (this.isStale(ticket, sessionId)) return;
			this.state = { ...(this.state ?? { exists: true }), exists: true, checkpoint };
			this.error = null;
		} catch (err) {
			if (this.isStale(ticket, sessionId)) return;
			const message = describeLearningError(err);
			// A conflict means someone else advanced the checkpoint: refresh so the
			// UI shows the current revision instead of retrying blindly. The refresh
			// keeps this ticket, so it can only ever update this same session and
			// the error stays visible afterwards.
			await this.refreshQuietly(sessionId, ticket);
			if (this.isStale(ticket, sessionId)) return;
			this.error = message;
		} finally {
			if (!this.isStale(ticket, sessionId)) {
				this.isSaving = false;
				this.notify();
			}
		}
	}

	/**
	 * Re-read a session's state without claiming a new ticket.
	 *
	 * Used by the conflict path: claiming a ticket would invalidate the caller's
	 * own `finally`, and would let this read repaint a session the user has since
	 * switched away from.
	 */
	private async refreshQuietly(sessionId: string, ticket: number): Promise<void> {
		try {
			const state = await getLearningState(sessionId);
			if (this.isStale(ticket, sessionId)) return;
			this.state = state;
		} catch {
			// Keep the previous state; the caller surfaces the transition error.
		}
	}
}

export const learningStore = new LearningStoreImpl();
