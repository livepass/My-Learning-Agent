import { join } from "node:path";
import { readJson, writeJson } from "../storage/file-store.js";

/**
 * E4.7-R2a — the minimal durable record of an incomplete session delete.
 *
 * The chat file, B2 record and title are authoritative: once they are gone the
 * conversation no longer exists. Sidecars (attachments, traces, archive flag,
 * command log, workspace activity, course binding) can still fail independently;
 * without a marker a later DELETE would return 404 and the leftovers could
 * never be cleaned.
 *
 * One entry per session id, written only when something is still pending. It is
 * removed as soon as every step succeeds, so a normal delete leaves no trace.
 * Deliberately not a background job system: the only actor is the DELETE retry.
 */
export interface PendingSessionCleanup {
	/** Step names that failed, e.g. `channel_metadata`, `replacement_init`. */
	failures: string[];
	/** Blank successor created by the delete, kept so a retry can finish its init. */
	new_active_id?: string;
	updated_at: string;
}

export type PendingSessionCleanupFile = Record<string, PendingSessionCleanup>;

export function sessionCleanupPath(dataDir: string): string {
	return join(dataDir, "sessions", "pending-cleanup.json");
}

export function readSessionCleanupFile(dataDir: string): PendingSessionCleanupFile {
	return readJson<PendingSessionCleanupFile>(sessionCleanupPath(dataDir), {});
}

export function readSessionCleanup(
	dataDir: string,
	sessionId: string,
): PendingSessionCleanup | undefined {
	return readSessionCleanupFile(dataDir)[sessionId];
}

/**
 * Serialize read-modify-write of the marker file. Two concurrent deletes would
 * otherwise overwrite each other's entries and lose a pending cleanup.
 */
let cleanupQueue: Promise<unknown> = Promise.resolve();

function withCleanupLock<T>(fn: () => T | Promise<T>): Promise<T> {
	const run = cleanupQueue.then(fn, fn);
	cleanupQueue = run.then(() => undefined, () => undefined);
	return run;
}

export function writeSessionCleanup(
	dataDir: string,
	sessionId: string,
	failures: readonly string[],
	newActiveId?: string | null,
): Promise<void> {
	return withCleanupLock(() => {
		const file = readSessionCleanupFile(dataDir);
		file[sessionId] = {
			failures: [...failures],
			...(newActiveId ? { new_active_id: newActiveId } : {}),
			updated_at: new Date().toISOString(),
		};
		writeJson(sessionCleanupPath(dataDir), file);
	});
}

export function clearSessionCleanup(dataDir: string, sessionId: string): Promise<void> {
	return withCleanupLock(() => {
		const file = readSessionCleanupFile(dataDir);
		if (!Object.prototype.hasOwnProperty.call(file, sessionId)) return;
		delete file[sessionId];
		writeJson(sessionCleanupPath(dataDir), file);
	});
}
