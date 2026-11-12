import { existsSync } from "node:fs";
import { basename } from "node:path";

/**
 * Server-owned truth for "this session is going away".
 *
 * Two distinct states matter and they are deliberately not the same set:
 *
 * - `deleting` is a lease: requests that arrive while a delete is in flight
 *   must be refused (409), and queued work must not start against the target.
 * - `deleted` is a tombstone: it survives the lease. A request that passed its
 *   cheap existence check before the delete finished is re-validated inside the
 *   shared Agent queue; without the tombstone it would reopen the old path and
 *   let the SDK recreate `A.jsonl`.
 *
 * The registry is process-local on purpose. It is not a second database and
 * not a lock: it only records deletion intent. The authoritative check for
 * "does this file still exist" remains the file system, re-read at the point
 * where the runtime would bind to it.
 */
export type SessionUnavailableReason = "missing" | "deleting" | "deleted" | "ineligible";

export class SessionUnavailableError extends Error {
	constructor(
		public readonly sessionId: string,
		public readonly reason: SessionUnavailableReason,
		message?: string,
	) {
		super(message ?? `Session ${sessionId} is unavailable (${reason})`);
		this.name = "SessionUnavailableError";
	}
}

/**
 * The runtime is bound to the session being deleted, but no eligible existing
 * conversation can take over. D4: refuse the delete instead of creating a
 * hidden successor.
 */
export class NoReplacementSessionError extends Error {
	constructor(public readonly sessionId: string, message = "No replacement session is available") {
		super(message);
		this.name = "NoReplacementSessionError";
	}
}

/**
 * E4.7-R2: the learner explicitly confirmed "delete the last conversation and
 * start a blank one", but creating that blank session failed. The original
 * session is untouched; the route reports a retryable failure instead.
 */
export class ReplacementCreationError extends Error {
	constructor(
		public readonly sessionId: string,
		public readonly reason?: unknown,
		message = "Failed to create a blank replacement session",
	) {
		super(message);
		this.name = "ReplacementCreationError";
	}
}

export interface SessionDeletionLease {
	readonly sessionId: string;
	readonly token: number;
	released: boolean;
}

class SessionLifecycle {
	private readonly deleting = new Map<string, number>();
	private readonly deleted = new Set<string>();
	private sequence = 0;

	/**
	 * Claim exclusive ownership of a deletion. A second DELETE for the same
	 * session is a conflict, not an idempotent replay: the first one may still
	 * be switching the runtime, and running both would double-delete or bind
	 * the runtime to a replacement selected by the other request.
	 */
	beginDeletion(sessionId: string): SessionDeletionLease {
		if (this.deleted.has(sessionId)) {
			throw new SessionUnavailableError(sessionId, "deleted");
		}
		if (this.deleting.has(sessionId)) {
			throw new SessionUnavailableError(sessionId, "deleting");
		}
		const token = ++this.sequence;
		this.deleting.set(sessionId, token);
		return { sessionId, token, released: false };
	}

	/** Mark the files gone and keep the id unusable for the rest of the process. */
	completeDeletion(lease: SessionDeletionLease): void {
		if (lease.released) return;
		// A newer lease cannot exist: beginDeletion refuses while one is active.
		if (this.deleting.get(lease.sessionId) === lease.token) {
			this.deleting.delete(lease.sessionId);
			this.deleted.add(lease.sessionId);
		}
		lease.released = true;
	}

	/** Nothing was removed: allow the id to be used again. */
	abortDeletion(lease: SessionDeletionLease): void {
		if (lease.released) return;
		if (this.deleting.get(lease.sessionId) === lease.token) {
			this.deleting.delete(lease.sessionId);
		}
		lease.released = true;
	}

	status(sessionId: string): SessionUnavailableReason | null {
		if (this.deleting.has(sessionId)) return "deleting";
		if (this.deleted.has(sessionId)) return "deleted";
		return null;
	}

	isDeleting(sessionId: string): boolean {
		return this.deleting.has(sessionId);
	}

	isDeleted(sessionId: string): boolean {
		return this.deleted.has(sessionId);
	}

	isBlocked(sessionId: string): boolean {
		return this.deleting.has(sessionId) || this.deleted.has(sessionId);
	}

	assertAvailable(sessionId: string): void {
		const state = this.status(sessionId);
		if (state) throw new SessionUnavailableError(sessionId, state);
	}

	/**
	 * Queue-entry validation for every path that can rebind the singleton
	 * runtime. The existence check must happen here, not only in the HTTP
	 * handler: waiting for a slot can outlive the file, and `SessionManager.open`
	 * happily accepts a missing path (recreating it on the next write).
	 */
	assertFileUsable(sessionPath: string): void {
		const sessionId = basename(sessionPath);
		this.assertAvailable(sessionId);
		if (!existsSync(sessionPath)) {
			throw new SessionUnavailableError(sessionId, "missing");
		}
	}
}

export const sessionLifecycle = new SessionLifecycle();
export type { SessionLifecycle };
