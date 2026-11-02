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
 */
class LearningStoreImpl extends EventEmitter<LearningStoreEvents> {
	sessionId: string | null = null;
	state: LearningState | null = null;
	isLoading = false;
	isSaving = false;
	error: string | null = null;

	/** Read-only load. Never initialises a missing record. */
	async load(sessionId: string): Promise<void> {
		if (this.sessionId !== sessionId) {
			this.state = null;
			this.error = null;
		}
		this.sessionId = sessionId;
		this.isLoading = true;
		this.emit("change", undefined);
		try {
			this.state = await getLearningState(sessionId);
			this.error = null;
		} catch (err) {
			this.state = null;
			this.error = describeLearningError(err);
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	clear(): void {
		this.sessionId = null;
		this.state = null;
		this.error = null;
		this.emit("change", undefined);
	}

	/** Explicit user action: create the record for the current session. */
	async init(goalId?: string): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId) return;
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			await initLearning(sessionId, goalId);
			this.state = await getLearningState(sessionId);
			this.error = null;
		} catch (err) {
			this.error = describeLearningError(err);
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
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
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			const checkpoint = action === "pause"
				? await pauseLearning(sessionId, revision)
				: await resumeLearning(sessionId, revision);
			this.state = { ...(this.state ?? { exists: true }), exists: true, checkpoint };
			this.error = null;
		} catch (err) {
			const message = describeLearningError(err);
			// A conflict means someone else advanced the checkpoint: refresh so the
			// UI shows the current revision instead of retrying blindly. The refresh
			// clears the error, so restore the message afterwards to keep it visible.
			await this.load(sessionId).catch(() => undefined);
			this.error = message;
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}
}

export const learningStore = new LearningStoreImpl();
