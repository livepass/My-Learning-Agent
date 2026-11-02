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
 * Async isolation — reads and writes have *separate* lifetimes:
 *
 *   reads   `load()`; the newest read owns `isLoading`
 *   writes  `init()` / `pause()` / `resume()`; the newest write owns `isSaving`
 *
 * A read therefore never invalidates a write, and a write never invalidates
 * another write's bookkeeping. Both kinds still check the session before
 * painting, so a response for a conversation the user has left is dropped.
 * `clear()` invalidates both.
 *
 * A completed write outranks any read that was issued before it committed:
 * otherwise a slow reload could repaint the pre-write revision over the
 * server's freshly applied checkpoint.
 */
class LearningStoreImpl extends EventEmitter<LearningStoreEvents> {
	sessionId: string | null = null;
	state: LearningState | null = null;
	isLoading = false;
	isSaving = false;
	error: string | null = null;

	/** Newest read ticket; a newer read invalidates older reads only. */
	private _readTicket = 0;
	/** Newest write ticket; a newer write invalidates older writes only. */
	private _writeTicket = 0;
	/** Session whose newest read is still in flight. */
	private _readingSession: string | null = null;
	/** Session whose newest write is still in flight. */
	private _savingSession: string | null = null;

	/**
	 * Flags are derived, never assigned ad hoc: a flag is on only while the
	 * newest operation of its kind belongs to the session currently on screen.
	 * That is what keeps a save on A from disabling controls on B, and what
	 * keeps a pending save visible when a reload for A starts.
	 */
	private syncFlags(): void {
		this.isLoading = this._readingSession !== null && this._readingSession === this.sessionId;
		this.isSaving = this._savingSession !== null && this._savingSession === this.sessionId;
	}

	private notify(): void {
		this.emit("change", undefined);
	}

	private beginRead(sessionId: string): number {
		this._readingSession = sessionId;
		const ticket = ++this._readTicket;
		this.syncFlags();
		return ticket;
	}

	/** Only the newest read may clear the loading flag. */
	private endRead(ticket: number): void {
		if (ticket !== this._readTicket) return;
		this._readingSession = null;
		this.syncFlags();
	}

	private beginWrite(sessionId: string): number {
		this._savingSession = sessionId;
		const ticket = ++this._writeTicket;
		this.syncFlags();
		return ticket;
	}

	/** Only the newest write may clear the saving flag. */
	private endWrite(ticket: number): void {
		if (ticket !== this._writeTicket) return;
		this._savingSession = null;
		this.syncFlags();
	}

	/** True when a newer write has taken over from `ticket`. */
	private writeWasSuperseded(ticket: number): boolean {
		return ticket !== this._writeTicket;
	}

	/**
	 * Settle a successful write.
	 *
	 * Returns true when the caller should paint the result. Clears the saving
	 * flag for the winning write, and drops any read that was issued earlier for
	 * the same session because the write is now the freshest known state.
	 */
	private commitWrite(ticket: number, sessionId: string): boolean {
		if (this.writeWasSuperseded(ticket)) return false;
		this._savingSession = null;
		if (this.sessionId !== sessionId) {
			this.syncFlags();
			return false;
		}
		if (this._readingSession === sessionId) {
			// That read was issued before this write committed; its payload is older.
			this._readTicket += 1;
			this._readingSession = null;
		}
		return true;
	}

	/** Read-only load. Never initialises a missing record. */
	async load(sessionId: string): Promise<void> {
		if (this.sessionId !== sessionId) {
			this.sessionId = sessionId;
			this.state = null;
			this.error = null;
		}
		const ticket = this.beginRead(sessionId);
		this.notify();
		try {
			const state = await getLearningState(sessionId);
			if (ticket !== this._readTicket || this.sessionId !== sessionId) return;
			this.state = state;
			this.error = null;
		} catch (err) {
			if (ticket !== this._readTicket || this.sessionId !== sessionId) return;
			this.state = null;
			this.error = describeLearningError(err);
		} finally {
			this.endRead(ticket);
			this.notify();
		}
	}

	clear(): void {
		// Invalidate in-flight reads and writes: neither may restore the state
		// the caller just cleared, and neither may re-arm a flag we reset here.
		this._readTicket += 1;
		this._writeTicket += 1;
		this._readingSession = null;
		this._savingSession = null;
		this.sessionId = null;
		this.state = null;
		this.error = null;
		this.syncFlags();
		this.notify();
	}

	/** Explicit user action: create the record for the current session. */
	async init(goalId?: string): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId) return;
		const ticket = this.beginWrite(sessionId);
		this.notify();
		try {
			await initLearning(sessionId, goalId);
			const state = await getLearningState(sessionId);
			if (this.commitWrite(ticket, sessionId)) {
				this.state = state;
				this.error = null;
			}
		} catch (err) {
			if (this.writeWasSuperseded(ticket)) return;
			this._savingSession = null;
			if (this.sessionId === sessionId) this.error = describeLearningError(err);
		} finally {
			this.endWrite(ticket);
			this.notify();
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
		const ticket = this.beginWrite(sessionId);
		// Snapshot so a conflict refresh cannot clobber a read that started later.
		const readTicketAtStart = this._readTicket;
		this.notify();
		try {
			const checkpoint = action === "pause"
				? await pauseLearning(sessionId, revision)
				: await resumeLearning(sessionId, revision);
			// The server already applied this to session A; only the UI write is
			// conditional, so switching to B never shows A's checkpoint.
			if (this.commitWrite(ticket, sessionId)) {
				this.state = { ...(this.state ?? { exists: true }), exists: true, checkpoint };
				this.error = null;
			}
		} catch (err) {
			if (this.writeWasSuperseded(ticket)) return;
			this._savingSession = null;
			if (this.sessionId !== sessionId) {
				this.syncFlags();
				return;
			}
			const message = describeLearningError(err);
			// A conflict means someone else advanced the checkpoint: refresh so the
			// UI shows the current revision instead of retrying blindly. The refresh
			// keeps this write's ticket, so it can only ever update this session and
			// the error stays visible afterwards.
			await this.refreshQuietly(sessionId, ticket, readTicketAtStart);
			if (this.writeWasSuperseded(ticket)) return;
			if (this.sessionId !== sessionId) return;
			this.error = message;
		} finally {
			this.endWrite(ticket);
			this.notify();
		}
	}

	/**
	 * Re-read a session's state after a failed write.
	 *
	 * Never claims a ticket: the caller's `finally` still owns the saving flag.
	 * Applies only when the session is still current, this write is still the
	 * newest, and no read has been issued since the write started — anything
	 * newer already carries at least as fresh a payload.
	 */
	private async refreshQuietly(sessionId: string, ticket: number, readTicketAtStart: number): Promise<void> {
		try {
			const state = await getLearningState(sessionId);
			if (this.writeWasSuperseded(ticket)) return;
			if (this._readTicket !== readTicketAtStart) return;
			if (this.sessionId !== sessionId) return;
			this.state = state;
		} catch {
			// Keep the previous state; the caller surfaces the transition error.
		}
	}
}

export const learningStore = new LearningStoreImpl();
