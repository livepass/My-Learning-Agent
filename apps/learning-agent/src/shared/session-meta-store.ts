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
	/** Shallow-merged into the existing projection; `null` removes it. */
	learning?: SessionLearningProjection | null;
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
		options?: { expectedRev?: number },
	): Promise<SessionMetaEntry> {
		return this.update(sessionId, { learning: projection, expectedRev: options?.expectedRev });
	}

	/**
	 * Field-level merge. Only the fields present in the patch change; everything
	 * else (topic, learning, legacy keys) is carried over from the current entry.
	 */
	async update(sessionId: string, patch: SessionMetaPatch): Promise<SessionMetaEntry> {
		assertSessionId(sessionId);
		const normalized = this.normalizePatch(patch);
		return runExclusive(this.filePath, async () => {
			await this.ensureWriteLock();
			const map = await this.readAll();
			const previous = Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : undefined;
			const currentRev = previous?.rev ?? 0;
			if (normalized.expectedRev !== undefined && normalized.expectedRev !== currentRev) {
				throw new SessionMetaError("META_CONFLICT", "会话元数据已被其他写入更新", { sessionId, currentRev });
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
			if (normalized.hasLearning) {
				if (normalized.learning === null) {
					delete next.learning;
				} else {
					next.learning = { ...(previous?.learning ?? {}), ...normalized.learning };
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

	/** Release the store-owned writer lock (no-op when a handle was injected). */
	async close(): Promise<void> {
		this.closed = true;
		const lock = this.ownLock;
		this.ownLock = undefined;
		await lock?.release();
	}

	private normalizePatch(patch: SessionMetaPatch): {
		topic?: string;
		generated?: boolean;
		upgraded?: boolean;
		learning: SessionLearningProjection | null;
		hasLearning: boolean;
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
		if (hasLearning && patch.learning !== null && patch.learning !== undefined) {
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
			expectedRev: patch.expectedRev,
		};
	}

	/**
	 * Prove cross-process ownership before every write. The in-process queue
	 * alone would only order this process's callers; the lock is what stops a
	 * second process from forking the file.
	 */
	private async ensureWriteLock(): Promise<void> {
		if (this.closed) throw new SessionMetaError("META_CLOSED", "会话元数据存储已关闭");
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
