import { join } from "node:path";
import { readJson } from "../storage/file-store.js";

/**
 * Owner of `sessions/archives.json` — the session's **own** archive flag.
 *
 * E4.7-R1c keeps this flag independent from the parent course status: archiving
 * a course never rewrites its children, and restoring a course never clears a
 * manual archive. Both the sessions route (list/archive/restore) and the chat /
 * learning write guards read the same file through this module, so a session
 * cannot be "archived for the list" but writable for the API.
 */

export type SessionArchiveFlags = Record<string, boolean>;

export function sessionArchiveMetadataPath(dataDir: string): string {
	return join(dataDir, "sessions", "archives.json");
}

export function readSessionArchiveFlags(dataDir: string): SessionArchiveFlags {
	return readJson<SessionArchiveFlags>(sessionArchiveMetadataPath(dataDir), {});
}

/** True only for an explicit `true`; a restored session keeps `false`. */
export function isSessionManuallyArchived(dataDir: string, sessionId: string): boolean {
	return readSessionArchiveFlags(dataDir)[sessionId] === true;
}

/**
 * Serialize mutations of `archives.json`.
 *
 * Archive, unarchive and the delete cleanup all rewrite the same small map.
 * Without a queue an archive that started just before a delete can finish after
 * the cleanup and leave a ghost entry for a session whose file is already gone.
 * The same queue also prevents one archive write from dropping another one.
 */
let archiveMetadataQueue: Promise<unknown> = Promise.resolve();

export function withArchiveMetadataLock<T>(fn: () => T | Promise<T>): Promise<T> {
	const run = archiveMetadataQueue.then(fn, fn);
	archiveMetadataQueue = run.then(() => undefined, () => undefined);
	return run;
}
