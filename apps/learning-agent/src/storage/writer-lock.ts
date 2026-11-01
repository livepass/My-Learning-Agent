import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createFileExclusive, readJsonStrict, removeFile, renameFile } from "./file-store.js";
import { logger } from "../logger.js";

/**
 * Single-writer ownership for one persistent data directory.
 *
 * The learner store must never be written by two live processes: event
 * sequence assignment, the dedupe index and the profile projection cursor are
 * all read-modify-write state. A second process may still read, but any write
 * attempt fails with WRITER_LOCK_HELD instead of silently forking the ledger.
 *
 * Concurrency rules:
 * - acquire, release and stale reclaim all run inside one per-path critical
 *   section in this process, so two concurrent calls can never both "create"
 *   the lock or steal each other's in-flight handle;
 * - stale reclaim across processes is guarded by an exclusively created claim
 *   file, and the lock token is re-read after the rename to prove a live lock
 *   was not moved;
 * - a handle's release is idempotent and only the last release removes the
 *   file, after re-checking the token.
 */

export const WRITER_LOCK_FILE = ".writer.lock";
export const WRITER_LOCK_CLAIM_FILE = ".writer.lock.claim";

export type WriterLockErrorCode =
	| "WRITER_LOCK_HELD"
	| "WRITER_LOCK_LOST"
	| "WRITER_LOCK_UNREADABLE";

export class WriterLockError extends Error {
	readonly code: WriterLockErrorCode;

	constructor(code: WriterLockErrorCode, message: string) {
		super(message);
		this.name = "WriterLockError";
		this.code = code;
	}
}

interface WriterLockRecord {
	schema_version: 1;
	token: string;
	pid: number;
	host: string;
	created_at: string;
	process_started_at: string;
	data_dir: string;
}

interface ClaimRecord {
	schema_version: 1;
	token: string;
	pid: number;
	host: string;
	created_at: string;
}

interface WriterLockEntry {
	dataDir: string;
	lockPath: string;
	claimPath: string;
	token: string;
	refCount: number;
	released: boolean;
}

export interface WriterLockHandle {
	readonly dataDir: string;
	readonly token: string;
	/** Throws WRITER_LOCK_LOST when the on-disk lock is no longer ours. */
	assertOwned(): Promise<void>;
	release(): Promise<void>;
}

const registry = new Map<string, WriterLockEntry>();
/** One serialization queue per canonical data directory. */
const queues = new Map<string, Promise<void>>();
let exitHookInstalled = false;

function withPathLock<T>(canonical: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(canonical) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const tail = run.then(() => undefined, () => undefined);
	queues.set(canonical, tail);
	void tail.finally(() => {
		if (queues.get(canonical) === tail) queues.delete(canonical);
	});
	return run;
}

function processStartedAtIso(): string {
	// Approximate wall-clock start of this process. Used for diagnostics and to
	// recognise a stale lock left by a *previous* process that happened to get
	// the same PID; it is never used as proof that another process is dead.
	return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		// Best effort only: a crash or SIGKILL never reaches this hook, which is
		// why stale locks are reclaimed on the next acquire instead.
		for (const entry of registry.values()) {
			try {
				const raw = readFileSync(entry.lockPath, "utf-8");
				const record = JSON.parse(raw) as WriterLockRecord;
				if (record.token === entry.token) unlinkSync(entry.lockPath);
			} catch {
				// Already gone, already replaced, or unreadable: leave it alone.
			}
		}
	});
}

async function resolveDataDir(dataDir: string): Promise<string> {
	await mkdir(dataDir, { recursive: true });
	return realpath(dataDir);
}

function readLockRecord(raw: string): WriterLockRecord {
	let parsed: WriterLockRecord;
	try {
		parsed = JSON.parse(raw) as WriterLockRecord;
	} catch {
		throw new WriterLockError("WRITER_LOCK_UNREADABLE", "写入锁文件无法解析，需人工确认后才能继续写入");
	}
	if (
		!parsed
		|| parsed.schema_version !== 1
		|| typeof parsed.token !== "string"
		|| typeof parsed.pid !== "number"
		|| typeof parsed.host !== "string"
	) {
		throw new WriterLockError("WRITER_LOCK_UNREADABLE", "写入锁文件结构不受支持，需人工确认后才能继续写入");
	}
	return parsed;
}

function makeHandle(entry: WriterLockEntry): WriterLockHandle {
	let released = false;
	return {
		get dataDir() {
			return entry.dataDir;
		},
		get token() {
			return entry.token;
		},
		async assertOwned() {
			if (released || entry.released) {
				throw new WriterLockError("WRITER_LOCK_LOST", "写入锁已释放，当前进程不再拥有写入权");
			}
			let read: Awaited<ReturnType<typeof readJsonStrict<WriterLockRecord>>>;
			try {
				read = await readJsonStrict<WriterLockRecord>(entry.lockPath);
			} catch {
				throw new WriterLockError("WRITER_LOCK_LOST", "写入锁无法读取，已停止写入");
			}
			if (!read.found) {
				throw new WriterLockError("WRITER_LOCK_LOST", "写入锁已被移除，已停止写入");
			}
			if (read.value.token !== entry.token) {
				throw new WriterLockError("WRITER_LOCK_LOST", "写入锁已被其他进程接管，已停止写入");
			}
		},
		async release() {
			// Per-handle idempotency: a second release must not decrement another
			// handle's reference or remove a lock someone else now needs.
			if (released) return;
			released = true;
			await withPathLock(entry.dataDir, async () => {
				entry.refCount -= 1;
				if (entry.refCount > 0 || entry.released) return;
				entry.released = true;
				registry.delete(entry.dataDir);
				try {
					const read = await readJsonStrict<WriterLockRecord>(entry.lockPath);
					if (read.found && read.value.token === entry.token) {
						await removeFile(entry.lockPath);
					}
				} catch (err) {
					logger.warn({ err }, "failed to release writer lock");
				}
			});
		},
	};
}

async function readOptionalLock(lockPath: string): Promise<WriterLockRecord | undefined> {
	const read = await readJsonStrict<WriterLockRecord>(lockPath).catch(() => {
		throw new WriterLockError("WRITER_LOCK_UNREADABLE", "写入锁文件无法读取，需人工确认后才能继续写入");
	});
	if (!read.found) return undefined;
	return readLockRecord(JSON.stringify(read.value));
}

/** Remove a claim left by a process that no longer exists. */
async function clearStaleClaim(claimPath: string): Promise<boolean> {
	const read = await readJsonStrict<ClaimRecord>(claimPath).catch(() => ({ found: false as const }));
	if (!read.found) return true;
	const claim = read.value;
	if (claim && typeof claim.pid === "number" && isProcessAlive(claim.pid)) return false;
	await removeFile(claimPath).catch(() => undefined);
	return true;
}

async function acquireClaim(claimPath: string): Promise<ClaimRecord> {
	const claim: ClaimRecord = {
		schema_version: 1,
		token: randomUUID(),
		pid: process.pid,
		host: hostname(),
		created_at: new Date().toISOString(),
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await createFileExclusive(claimPath, JSON.stringify(claim, null, 2) + "\n")) return claim;
		if (await clearStaleClaim(claimPath)) continue;
		throw new WriterLockError("WRITER_LOCK_HELD", "另一个进程正在回收失效写入锁");
	}
	throw new WriterLockError("WRITER_LOCK_HELD", "无法取得写入锁回收权");
}

async function acquireLocked(canonical: string): Promise<WriterLockHandle> {
	const existing = registry.get(canonical);
	if (existing && !existing.released) {
		existing.refCount += 1;
		return makeHandle(existing);
	}

	const lockPath = join(canonical, WRITER_LOCK_FILE);
	const claimPath = join(canonical, WRITER_LOCK_CLAIM_FILE);
	const host = hostname();

	for (let attempt = 0; attempt < 5; attempt++) {
		const record: WriterLockRecord = {
			schema_version: 1,
			token: randomUUID(),
			pid: process.pid,
			host,
			created_at: new Date().toISOString(),
			process_started_at: processStartedAtIso(),
			data_dir: canonical,
		};
		if (await createFileExclusive(lockPath, JSON.stringify(record, null, 2) + "\n")) {
			const entry: WriterLockEntry = {
				dataDir: canonical,
				lockPath,
				claimPath,
				token: record.token,
				refCount: 1,
				released: false,
			};
			registry.set(canonical, entry);
			installExitHook();
			return makeHandle(entry);
		}

		const holder = await readOptionalLock(lockPath);
		if (!holder) continue; // released between create and read

		if (holder.host !== host) {
			throw new WriterLockError("WRITER_LOCK_HELD", "数据目录已被其他主机上的进程持有写入权");
		}
		const samePid = holder.pid === process.pid;
		if (!samePid && isProcessAlive(holder.pid)) {
			throw new WriterLockError("WRITER_LOCK_HELD", "数据目录已被另一个活动进程持有写入权");
		}

		// Reclaim under an exclusive claim: only one process may evaluate and
		// move the stale lock at a time.
		await acquireClaim(claimPath);
		try {
			const confirmed = await readOptionalLock(lockPath);
			if (!confirmed || confirmed.token !== holder.token) continue; // changed under us

			const stalePath = `${lockPath}.stale-${holder.token}`;
			try {
				await renameFile(lockPath, stalePath);
			} catch {
				continue;
			}
			const moved = await readOptionalLock(stalePath).catch(() => undefined);
			if (!moved || moved.token !== holder.token) {
				// We moved a lock that had just been recreated by a live owner:
				// put it back and refuse instead of hijacking a live writer.
				await renameFile(stalePath, lockPath).catch(() => undefined);
				throw new WriterLockError("WRITER_LOCK_HELD", "失效锁回收时发现活动写入者，已放弃接管");
			}
			await removeFile(stalePath).catch(() => undefined);
			logger.warn({ pid: holder.pid, samePid }, "reclaimed stale writer lock");
		} finally {
			await removeFile(claimPath).catch(() => undefined);
		}
		// Loop: the next round creates the lock exclusively.
	}

	throw new WriterLockError("WRITER_LOCK_HELD", "无法取得数据目录写入权");
}

/**
 * Acquire (or reuse) the exclusive writer for `dataDir`.
 *
 * - `dataDir` is canonicalised with realpath first, so `dir`, `dir/sub/..`
 *   and a symlink to `dir` all contend on the same lock file;
 * - same process, same canonical directory: the existing handle is returned
 *   with an incremented refcount (serialized, so concurrent calls cannot both
 *   create a token);
 * - a live PID is never pre-empted, no matter how old the file looks.
 */
export async function acquireWriterLock(dataDir: string): Promise<WriterLockHandle> {
	const canonical = await resolveDataDir(dataDir);
	return withPathLock(canonical, () => acquireLocked(canonical));
}

/** Non-mutating diagnostic used by tests and startup logging. */
export async function inspectWriterLock(dataDir: string): Promise<
	| { state: "absent" }
	| { state: "owned_by_this_process" }
	| { state: "held_by_other"; pid: number; host: string }
	| { state: "unreadable" }
> {
	const canonical = await resolveDataDir(dataDir);
	const entry = registry.get(canonical);
	if (entry && !entry.released) return { state: "owned_by_this_process" };
	const read = await readJsonStrict<WriterLockRecord>(join(canonical, WRITER_LOCK_FILE));
	if (!read.found) return { state: "absent" };
	try {
		const record = readLockRecord(JSON.stringify(read.value));
		return { state: "held_by_other", pid: record.pid, host: record.host };
	} catch {
		return { state: "unreadable" };
	}
}
