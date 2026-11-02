import { join } from "node:path";
import { logger } from "../logger.js";
import { FileStoreError, readJsonStrict, writeJsonDurable } from "../storage/file-store.js";
import { WriterLockError, acquireWriterLock, type WriterLockHandle } from "../storage/writer-lock.js";

/**
 * The one owner of `sessions/meta.json`.
 *
 * Before this module the file had two write paths in the server: session
 * create/auto-title wrote through `writeSessionTopic`, and `DELETE /api/sessions/:id`
 * read the whole map and wrote it back with `writeJson`. Both were synchronous
 * read-modify-write over the entire map, so a title update racing a delete (or
 * a future learning checkpoint update) could silently clobber the other side.
 * Server, sessions routes, auto-title, delete and later learning writes must
 * all go through this store; no other module may write the file.
 *
 * Concurrency contract:
 * - inside one process every read-modify-write of the file runs in a single
 *   queue keyed by the file path, so two callers cannot interleave;
 * - the queue is *not* a cross-process lock. Cross-process exclusivity comes
 *   from the writer lock on the data directory (`storage/writer-lock`): the
 *   store acquires it before the first write (or asserts an injected handle)
 *   and refuses to write after ownership is lost. Readers in another process
 *   stay allowed;
 * - merges are per field: a topic update keeps the `learning` projection and a
 *   learning update keeps the topic. Unknown fields written by older or newer
 *   versions survive because the previous entry object is spread forward.
 *
 * Data compatibility: `meta.json` remains the same topic map it always was
 * (`{ [sessionId]: { topic, updatedAt, generated?, upgraded? } }`). `rev` and
 * `learning` are optional additions; entries without them read as `rev: 0` and
 * are never migrated in bulk.
 */

export interface SessionTopicFields {
	topic: string;
	updatedAt: string;
	generated?: boolean;
	upgraded?: boolean;
}

/** Learning checkpoint projection belongs to the session metadata, but its
 *  internal shape is owned by the learning package. The store treats it as an
 *  opaque object so B1 does not freeze a schema before G4 is implemented. */
export type SessionLearningProjection = Record<string, unknown>;

export interface SessionMetaEntry extends SessionTopicFields {
	/** Monotonic per-session write counter; absent on pre-B1 entries. */
	rev?: number;
	/** Projection of the learning checkpoint (see S2-G4). Optional. */
	learning?: SessionLearningProjection;
}

export type SessionMetaMap = Record<string, SessionMetaEntry>;

export type SessionMetaErrorCode =
	| "META_INVALID"
	| "META_CORRUPT"
	| "META_UNREADABLE"
	| "META_IO"
	| "META_CONFLICT"
	| "META_WRITER_LOCK"
	| "META_LOCK_LOST"
	| "META_CLOSED";

export class SessionMetaError extends Error {
	readonly code: SessionMetaErrorCode;
	readonly sessionId?: string;
	/** Current revision, only set for META_CONFLICT. */
	readonly currentRev?: number;

	constructor(code: SessionMetaErrorCode, message: string, options?: { sessionId?: string; currentRev?: number }) {
		super(message);
		this.name = "SessionMetaError";
		this.code = code;
		this.sessionId = options?.sessionId;
		this.currentRev = options?.currentRev;
	}
}

export interface SessionMetaPatch {
	/** New topic. When present the entry is a title write. */
	topic?: string;
	/** Only meaningful together with `topic`; mirrors the old writeSessionTopic semantics. */
	generated?: boolean;
	/** Only meaningful together with `topic`. */
	upgraded?: boolean;
	/**
	 * Learning projection write contract (whole-replace):
	 * - a plain object replaces the existing projection entirely (fields the
	 *   caller omits are removed, never left over from an older checkpoint);
	 * - an explicit `null` deletes the whole projection;
	 * - `undefined` (or a property holding `undefined`) is skipped and can
	 *   never erase existing state.
	 */
	learning?: SessionLearningProjection | null;
	/**
	 * Monotonic guard for projection repairs: when true, a projection whose
	 * `revision` is lower than the stored one is dropped instead of written. This
	 * stops a slow reader holding an older checkpoint snapshot from rolling the
	 * projection back after a newer update landed.
	 */
	onlyIfNewerLearningRevision?: boolean;
	/** Optimistic concurrency: fail with META_CONFLICT when the on-disk rev differs. */
	expectedRev?: number;
}

export interface SessionMetaStoreOptions {
	dataDir: string;
	/**
	 * Handle from a process that already owns the writer lock for `dataDir`.
	 * When omitted the store acquires (and keeps) its own lock on first write.
	 */
	lock?: WriterLockHandle;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

const MAX_TOPIC_LENGTH = 200;

/** One queue per file path, shared by every store instance in this process. */
const fileQueues = new Map<string, Promise<unknown>>();

function runExclusive<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const previous = fileQueues.get(filePath) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const tail = run.then(() => undefined, () => undefined);
	fileQueues.set(filePath, tail);
	void tail.finally(() => {
		if (fileQueues.get(filePath) === tail) fileQueues.delete(filePath);
	});
	return run;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Session ids are session file names; anything containing a separator or a
 *  prototype key would escape the map or pollute the object. */
function assertSessionId(sessionId: string): void {
	if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || RESERVED_KEYS.has(sessionId)) {
		throw new SessionMetaError("META_INVALID", "会话 ID 不合法");
	}
}

function mapFileStoreError(err: unknown): SessionMetaError {
	if (err instanceof FileStoreError) {
		if (err.code === "FILE_CORRUPT") return new SessionMetaError("META_CORRUPT", "会话元数据不是合法 JSON，已停止写入");
		if (err.code === "FILE_UNREADABLE") return new SessionMetaError("META_UNREADABLE", "会话元数据读取失败");
		return new SessionMetaError("META_IO", "会话元数据写入失败");
	}
	if (err instanceof SessionMetaError) return err;
	logger.warn({ err }, "unexpected session metadata store failure");
	return new SessionMetaError("META_IO", "会话元数据操作失败");
}

function mapLockError(err: unknown): SessionMetaError {
	if (err instanceof WriterLockError) {
		if (err.code === "WRITER_LOCK_HELD") return new SessionMetaError("META_WRITER_LOCK", "数据目录已被另一个进程写入");
		if (err.code === "WRITER_LOCK_LOST") return new SessionMetaError("META_LOCK_LOST", "写入权已丢失，已停止写入");
		return new SessionMetaError("META_WRITER_LOCK", "写入锁不可用，已停止写入");
	}
	logger.warn({ err }, "failed to acquire session metadata writer lock");
	return new SessionMetaError("META_WRITER_LOCK", "无法取得写入权");
}

export class SessionMetaStore {
	readonly dataDir: string;
	readonly filePath: string;

	private readonly injectedLock?: WriterLockHandle;
	private ownLock?: WriterLockHandle;
	private readonly now: () => Date;
	private closed = false;

	constructor(options: SessionMetaStoreOptions) {
		this.dataDir = options.dataDir;
		this.filePath = join(options.dataDir, "sessions", "meta.json");
		this.injectedLock = options.lock;
		this.now = options.now ?? (() => new Date());
	}

	/** Strict read: a corrupt file raises META_CORRUPT instead of becoming `{}`. */
	async readAll(): Promise<SessionMetaMap> {
		const read = await readJsonStrict<unknown>(this.filePath).catch((err: unknown) => {
			throw mapFileStoreError(err);
		});
		if (!read.found) return {};
		if (!isPlainObject(read.value)) {
			throw new SessionMetaError("META_CORRUPT", "会话元数据结构不受支持，已停止写入");
		}
		return read.value as SessionMetaMap;
	}

	async get(sessionId: string): Promise<SessionMetaEntry | undefined> {
		const map = await this.readAll();
		return map[sessionId];
	}

	async setTopic(
		sessionId: string,
		topic: string,
		options?: { generated?: boolean; upgraded?: boolean; expectedRev?: number },
	): Promise<SessionMetaEntry> {
		return this.update(sessionId, {
			topic,
			generated: options?.generated,
			upgraded: options?.upgraded,
			expectedRev: options?.expectedRev,
		});
	}

	async setLearningProjection(
		sessionId: string,
		projection: SessionLearningProjection | null,
		options?: { expectedRev?: number; onlyIfNewerLearningRevision?: boolean },
	): Promise<SessionMetaEntry> {
		return this.update(sessionId, {
			learning: projection,
			expectedRev: options?.expectedRev,
			onlyIfNewerLearningRevision: options?.onlyIfNewerLearningRevision,
		});
	}

	/**
	 * Atomically set an auto-generated title, creating the entry when the session
	 * has none yet.
	 *
	 * Unlike `setTopic` with `expectedRev`, this does not key on the whole-entry
	 * `rev` (which a concurrent learning-projection write also bumps): it re-checks
	 * the title state inside the same write boundary, so an unrelated projection
	 * update can never block a legitimate auto-title.
	 *
	 * `sessionExists` is evaluated *inside* the write boundary: a session deleted
	 * while the model was generating the title must not be resurrected by the late
	 * auto-title write. A first auto-title (no entry yet) is created only when the
	 * session file still exists at commit time.
	 */
	async setAutoTopic(
		sessionId: string,
		topic: string,
		options: { upgraded?: boolean; sessionExists: () => boolean },
	): Promise<{ applied: boolean; entry?: SessionMetaEntry }> {
		assertSessionId(sessionId);
		this.assertOpen();
		// Validate the topic up front so a bad title fails before enqueuing.
		if (typeof topic !== "string" || !topic.trim()) {
			throw new SessionMetaError("META_INVALID", "标题不能为空");
		}
		const trimmed = topic.trim().slice(0, MAX_TOPIC_LENGTH);
		return runExclusive(this.filePath, async () => {
			await this.ensureWriteLock();
			const map = await this.readAll();
			const previous = Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : undefined;
			if (!previous) {
				// No entry yet: this is the session's first auto title. Create it only
				// if the session still exists; otherwise the session is being deleted.
				if (!options.sessionExists()) return { applied: false };
				const created = {
					topic: trimmed,
					updatedAt: this.now().toISOString(),
					generated: true,
					rev: 1,
					...(options.upgraded === true ? { upgraded: true } : {}),
				} as SessionMetaEntry;
				map[sessionId] = created;
				await writeJsonDurable(this.filePath, map).catch((err: unknown) => {
					throw mapFileStoreError(err);
				});
				return { applied: true, entry: created };
			}
			// A manual rename (generated !== true) or an already-upgraded topic is
			// no longer eligible for auto-update.
			if (previous.generated !== true || previous.upgraded === true) return { applied: false, entry: previous };
			const next = { ...previous, topic: trimmed, generated: true } as SessionMetaEntry;
			if (options.upgraded === true) next.upgraded = true;
			else delete next.upgraded;
			next.rev = (previous.rev ?? 0) + 1;
			next.updatedAt = this.now().toISOString();
			map[sessionId] = next;
			await writeJsonDurable(this.filePath, map).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			return { applied: true, entry: next };
		});
	}

	/**
	 * Field-level merge. Only the fields present in the patch change; everything
	 * else (topic, learning, legacy keys) is carried over from the current entry.
	 */
	async update(sessionId: string, patch: SessionMetaPatch): Promise<SessionMetaEntry> {
		assertSessionId(sessionId);
		const normalized = this.normalizePatch(patch);
		this.assertOpen();
		return runExclusive(this.filePath, async () => {
			await this.ensureWriteLock();
			const map = await this.readAll();
			const previous = Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : undefined;
			const currentRev = previous?.rev ?? 0;
			if (normalized.expectedRev !== undefined && normalized.expectedRev !== currentRev) {
				throw new SessionMetaError("META_CONFLICT", "会话元数据已被其他写入更新", { sessionId, currentRev });
			}
			// A pure projection deletion against a missing entry is a no-op, not a
			// creation: it must not resurrect a deleted session with an empty entry.
			if (previous === undefined && normalized.topic === undefined
				&& normalized.hasLearning && normalized.learning === null) {
				return {} as SessionMetaEntry;
			}
			// Monotonic projection guard: never let an older checkpoint snapshot
			// roll the stored projection back after a newer update landed.
			if (normalized.onlyIfNewerLearningRevision && normalized.learning && previous?.learning) {
				const incoming = (normalized.learning as { revision?: unknown }).revision;
				const stored = (previous.learning as { revision?: unknown }).revision;
				if (typeof incoming === "number" && typeof stored === "number" && incoming <= stored) {
					return previous;
				}
			}
			const next = { ...(previous ?? {}) } as SessionMetaEntry;
			if (normalized.topic !== undefined) {
				next.topic = normalized.topic;
				next.generated = normalized.generated;
				// A manual rename drops the upgrade marker; the old writer did the
				// same by simply not writing the field.
				if (normalized.upgraded === true) next.upgraded = true;
				else delete next.upgraded;
			}
			if (normalized.hasLearning && !normalized.learningUndefined) {
				if (normalized.learning === null) {
					delete next.learning;
				} else {
					// Whole-replace contract: a learning checkpoint is an atomic
					// state, not a patch. Replacing the projection with the caller's
					// object means a field the caller omitted is removed, never left
					// over from an older checkpoint. Only an explicit `null` deletes
					// the whole projection; `undefined` (learningUndefined) skips the
					// field entirely and can never erase existing state.
					next.learning = normalized.learning;
				}
			}
			next.rev = currentRev + 1;
			next.updatedAt = this.now().toISOString();
			map[sessionId] = next;
			await writeJsonDurable(this.filePath, map).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			return next;
		});
	}

	/** Idempotent: an unknown session is not an error and the file is not rewritten. */
	async remove(sessionId: string): Promise<boolean> {
		assertSessionId(sessionId);
		this.assertOpen();
		return runExclusive(this.filePath, async () => {
			await this.ensureWriteLock();
			const map = await this.readAll();
			if (!Object.prototype.hasOwnProperty.call(map, sessionId)) return false;
			delete map[sessionId];
			await writeJsonDurable(this.filePath, map).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			return true;
		});
	}

	/**
	 * Stop accepting new writes, let the already-accepted queue drain, then
	 * release the store-owned writer lock.
	 *
	 * `closed` flips first (synchronously), so any write that starts after this
	 * line is rejected by `assertOpen` before it can enqueue. Writes that passed
	 * `assertOpen` before the flip are already on the per-file queue and finish
	 * before we release the lock — they are never aborted by the close itself.
	 * The lock is released only after the queue drains, so a second process
	 * cannot take over while this store still has in-flight writes.
	 */
	async close(): Promise<void> {
		this.closed = true;
		const tail = fileQueues.get(this.filePath);
		if (tail) await tail;
		const lock = this.ownLock;
		this.ownLock = undefined;
		await lock?.release();
	}

	/** Reject any write attempted after the store has started closing. */
	private assertOpen(): void {
		if (this.closed) throw new SessionMetaError("META_CLOSED", "会话元数据存储已关闭");
	}

	private normalizePatch(patch: SessionMetaPatch): {
		topic?: string;
		generated?: boolean;
		upgraded?: boolean;
		learning: SessionLearningProjection | null;
		hasLearning: boolean;
		/** True when the caller supplied `learning: undefined`: skip, never delete. */
		learningUndefined: boolean;
		onlyIfNewerLearningRevision?: boolean;
		expectedRev?: number;
	} {
		const hasLearning = Object.prototype.hasOwnProperty.call(patch, "learning");
		let topic: string | undefined;
		if (patch.topic !== undefined) {
			if (typeof patch.topic !== "string") throw new SessionMetaError("META_INVALID", "标题必须是字符串");
			topic = patch.topic.trim();
			if (!topic) throw new SessionMetaError("META_INVALID", "标题不能为空");
			if (topic.length > MAX_TOPIC_LENGTH) throw new SessionMetaError("META_INVALID", "标题过长");
		}
		let learning: SessionLearningProjection | null = null;
		const learningUndefined = hasLearning && patch.learning === undefined;
		if (hasLearning && !learningUndefined && patch.learning !== null) {
			if (!isPlainObject(patch.learning)) throw new SessionMetaError("META_INVALID", "学习投影必须是对象");
			learning = {};
			for (const [key, value] of Object.entries(patch.learning)) {
				if (value !== undefined) learning[key] = value;
			}
		}
		if (topic === undefined && !hasLearning) {
			throw new SessionMetaError("META_INVALID", "没有需要更新的字段");
		}
		return {
			topic,
			generated: topic === undefined ? undefined : patch.generated === true,
			upgraded: topic === undefined ? undefined : patch.upgraded === true,
			learning,
			hasLearning,
			learningUndefined,
			onlyIfNewerLearningRevision: patch.onlyIfNewerLearningRevision === true,
			expectedRev: patch.expectedRev,
		};
	}

	/**
	 * Prove cross-process ownership before every write. The in-process queue
	 * alone would only order this process's callers; the lock is what stops a
	 * second process from forking the file.
	 */
	private async ensureWriteLock(): Promise<void> {
		// Note: `closed` is checked by assertOpen() before a write enqueues, so an
		// operation already inside the queue was accepted before close() began and
		// must be allowed to finish. No closed check here.
		if (this.injectedLock) {
			await this.injectedLock.assertOwned().catch((err: unknown) => {
				throw mapLockError(err);
			});
			return;
		}
		if (!this.ownLock) {
			this.ownLock = await acquireWriterLock(this.dataDir).catch((err: unknown) => {
				throw mapLockError(err);
			});
		}
		await this.ownLock.assertOwned().catch((err: unknown) => {
			throw mapLockError(err);
		});
	}
}
