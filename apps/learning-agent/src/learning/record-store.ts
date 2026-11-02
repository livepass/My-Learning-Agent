import { join } from "node:path";
import { logger } from "../logger.js";
import { FileStoreError, readJsonStrict, removeFile, writeJsonDurable } from "../storage/file-store.js";
import { WriterLockError, acquireWriterLock, type WriterLockHandle } from "../storage/writer-lock.js";
import { SessionMetaStore, type SessionLearningProjection } from "../shared/session-meta-store.js";
import { publicQuestion, learningRecoveryAction, type LearningRecoveryAction } from "./contracts.js";
import type {
	LearningCheckpoint,
	LearningQuestion,
	LearningQuestionRef,
	LearningSessionRecord,
	PublicLearningQuestion,
} from "../memory/learner/types.js";

/**
 * Single owner of the authoritative learning-session record.
 *
 * One `LearningSessionRecord` per learning session, persisted at
 * `<dataDir>/learning/<sessionId>.json` by whole-file atomic replace. This is
 * the *authoritative* copy; the `learning` field inside `sessions/meta.json`
 * (owned by `SessionMetaStore`) is only a rebuildable projection of it, never a
 * second source of truth. The write order is always authority-first: the record
 * is fsync'd before the projection is refreshed, so a crash between the two is
 * repaired by re-projecting on the next access instead of being silently
 * skipped or double-applied.
 *
 * Concurrency:
 * - in-process read-modify-write is serialised per record file;
 * - cross-process exclusivity comes from the data-directory writer lock
 *   (`storage/writer-lock`), asserted before every write;
 * - optimistic concurrency is enforced on the checkpoint `revision`: an update
 *   carrying a stale `expectedRevision` fails with a conflict instead of
 *   overwriting a newer state.
 *
 * Recovery: the record is written atomically, so an interrupted write leaves
 * either the old or the new complete record, never a torn one. A record whose
 * in-flight work referenced a dead process run is classified by the existing
 * `learningRecoveryAction` state machine in `contracts.ts`, which this store
 * does not re-implement.
 */

export type LearningRecordErrorCode =
	| "RECORD_INVALID"
	| "RECORD_CORRUPT"
	| "RECORD_UNREADABLE"
	| "RECORD_IO"
	| "RECORD_CONFLICT"
	| "RECORD_WRITER_LOCK"
	| "RECORD_LOCK_LOST"
	| "RECORD_CLOSED"
	| "RECORD_NOT_FOUND";

export class LearningRecordError extends Error {
	readonly code: LearningRecordErrorCode;
	readonly sessionId?: string;
	readonly currentRevision?: number;

	constructor(code: LearningRecordErrorCode, message: string, options?: { sessionId?: string; currentRevision?: number }) {
		super(message);
		this.name = "LearningRecordError";
		this.code = code;
		this.sessionId = options?.sessionId;
		this.currentRevision = options?.currentRevision;
	}
}

/** Public view: private answer/rubric/hints and internal evaluation state are omitted. */
export interface PublicLearningSessionRecord {
	schema_version: 1;
	checkpoint: {
		revision: number;
		status: LearningCheckpoint["status"];
		step: LearningCheckpoint["step"];
		updated_at: string;
	};
	questions: PublicLearningQuestion[];
}

/**
 * Public learning state with the recovery action for an in-flight attempt.
 * `pending_action` is derived from the existing `learningRecoveryAction` state
 * machine and only names the next step — it never leaks the answer, rubric,
 * hints or any internal evaluation payload.
 */
export interface PublicLearningState {
	schema_version: 1;
	checkpoint: {
		revision: number;
		status: LearningCheckpoint["status"];
		step: LearningCheckpoint["step"];
		updated_at: string;
	};
	questions: PublicLearningQuestion[];
	pending_action?: LearningRecoveryAction;
}

export interface LearningRecordStoreOptions {
	/** Parent data directory (the same one SessionMetaStore keys on). */
	dataDir: string;
	/** Projection sink: the authoritative record is written first, then this. */
	metaStore: SessionMetaStore;
	/** Optional lock handle from a process that already owns the writer lock. */
	lock?: WriterLockHandle;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSessionId(sessionId: string): void {
	if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || RESERVED_KEYS.has(sessionId)) {
		throw new LearningRecordError("RECORD_INVALID", "学习会话 ID 不合法");
	}
}

function mapFileStoreError(err: unknown): LearningRecordError {
	if (err instanceof FileStoreError) {
		if (err.code === "FILE_CORRUPT") return new LearningRecordError("RECORD_CORRUPT", "学习记录不是合法 JSON，已停止写入");
		if (err.code === "FILE_UNREADABLE") return new LearningRecordError("RECORD_UNREADABLE", "学习记录读取失败");
		return new LearningRecordError("RECORD_IO", "学习记录写入失败");
	}
	if (err instanceof LearningRecordError) return err;
	logger.warn({ err }, "unexpected learning record store failure");
	return new LearningRecordError("RECORD_IO", "学习记录操作失败");
}

function mapLockError(err: unknown): LearningRecordError {
	if (err instanceof WriterLockError) {
		if (err.code === "WRITER_LOCK_HELD") return new LearningRecordError("RECORD_WRITER_LOCK", "数据目录已被另一个进程写入");
		if (err.code === "WRITER_LOCK_LOST") return new LearningRecordError("RECORD_LOCK_LOST", "写入权已丢失，已停止写入");
		return new LearningRecordError("RECORD_WRITER_LOCK", "写入锁不可用，已停止写入");
	}
	logger.warn({ err }, "failed to acquire learning record writer lock");
	return new LearningRecordError("RECORD_WRITER_LOCK", "无法取得写入权");
}

/** A projection is a small, stable summary of the checkpoint. */
function projectionOf(record: LearningSessionRecord): SessionLearningProjection {
	return {
		schema_version: record.schema_version,
		session_id: record.checkpoint.session_id,
		revision: record.checkpoint.revision,
		status: record.checkpoint.status,
		step: record.checkpoint.step,
		pending_attempt_id: record.checkpoint.pending_attempt_id ?? null,
		last_completed_attempt_id: record.checkpoint.last_completed_attempt_id ?? null,
		updated_at: record.checkpoint.updated_at,
	};
}

const CHECKPOINT_STATUSES = new Set(["active", "paused", "completed"]);
const CHECKPOINT_STEPS = new Set(["conversation", "awaiting_answer", "feedback"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateQuestionRef(ref: unknown, context: string): void {
	if (!isPlainObject(ref) || typeof ref.question_id !== "string" || !ref.question_id
		|| typeof ref.question_version !== "string" || !ref.question_version) {
		throw new LearningRecordError("RECORD_CORRUPT", `学习记录${context}中的题目引用不合法`);
	}
}

/**
 * Structural validation of the authoritative record. A corrupt record must
 * surface a clear error and must never be silently replaced with an empty one
 * or overwritten (callers throw before any write path is reached).
 */
function validateRecord(value: unknown): LearningSessionRecord {
	if (!isPlainObject(value)) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习记录不是对象");
	}
	const record = value as unknown as LearningSessionRecord;
	if (record.schema_version !== 1) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习记录 schema_version 不受支持");
	}
	const cp = record.checkpoint;
	if (!isPlainObject(cp) || cp.schema_version !== 1) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习检查点结构不受支持");
	}
	// session_id must match the file's session; the store asserts it on read.
	if (typeof cp.session_id !== "string" || !cp.session_id) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习检查点缺少 session_id");
	}
	if (!Number.isSafeInteger(cp.revision) || cp.revision < 0) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习检查点 revision 不是非负安全整数");
	}
	if (!CHECKPOINT_STATUSES.has(cp.status)) {
		throw new LearningRecordError("RECORD_CORRUPT", `学习检查点 status 非法: ${String(cp.status)}`);
	}
	if (!CHECKPOINT_STEPS.has(cp.step)) {
		throw new LearningRecordError("RECORD_CORRUPT", `学习检查点 step 非法: ${String(cp.step)}`);
	}
	if (!Number.isSafeInteger(cp.exposure_sequence) || cp.exposure_sequence < 0) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习检查点 exposure_sequence 非法");
	}
	if (typeof cp.updated_at !== "string" || !cp.updated_at) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习检查点缺少 updated_at");
	}
	// Optional question ref must be internally consistent when present.
	if (cp.question !== undefined && cp.question !== null) {
		validateQuestionRef(cp.question, "检查点");
	}
	if (!Array.isArray(record.questions) || !Array.isArray(record.exposures) || !Array.isArray(record.attempts)) {
		throw new LearningRecordError("RECORD_CORRUPT", "学习记录的 questions/exposures/attempts 必须是数组");
	}
	// Every saved question must carry the required public + private fields.
	const questionIds = new Set<string>();
	for (const question of record.questions) {
		if (!isPlainObject(question) || typeof question.question_id !== "string" || !question.question_id
			|| typeof question.question_version !== "string" || !question.question_version
			|| typeof question.prompt !== "string" || !Array.isArray(question.rubric)
			|| !Array.isArray(question.hints) || typeof question.reference_answer !== "string") {
			throw new LearningRecordError("RECORD_CORRUPT", "学习记录中存在结构非法的题目");
		}
		const key = `${question.question_id}@${question.question_version}`;
		if (questionIds.has(key)) {
			throw new LearningRecordError("RECORD_CORRUPT", "学习记录中存在重复的题目版本");
		}
		questionIds.add(key);
	}
	// The checkpoint's question ref, when present, must resolve to a saved question.
	if (cp.question) {
		const ref = cp.question as LearningQuestionRef;
		if (!questionIds.has(`${ref.question_id}@${ref.question_version}`)) {
			throw new LearningRecordError("RECORD_CORRUPT", "检查点引用的题目未在记录中保存");
		}
	}
	// pending_attempt_id, when present, must reference a saved attempt.
	if (cp.pending_attempt_id) {
		if (!record.attempts.some((attempt) => attempt.attempt_id === cp.pending_attempt_id)) {
			throw new LearningRecordError("RECORD_CORRUPT", "检查点引用的待处理作答不存在");
		}
	}
	return record;
}

// One serialization queue per record file, shared by every instance in-process.
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

export class LearningRecordStore {
	readonly dataDir: string;
	readonly dir: string;

	private readonly metaStore: SessionMetaStore;
	private readonly injectedLock?: WriterLockHandle;
	private ownLock?: WriterLockHandle;
	private readonly now: () => Date;
	private closed = false;

	constructor(options: LearningRecordStoreOptions) {
		this.dataDir = options.dataDir;
		this.dir = join(options.dataDir, "learning");
		this.metaStore = options.metaStore;
		this.injectedLock = options.lock;
		this.now = options.now ?? (() => new Date());
	}

	private filePath(sessionId: string): string {
		return join(this.dir, `${sessionId}.json`);
	}

	/** Read the authoritative record. Missing → undefined; corrupt → throws. */
	async get(sessionId: string): Promise<LearningSessionRecord | undefined> {
		assertSessionId(sessionId);
		const read = await readJsonStrict<LearningSessionRecord>(this.filePath(sessionId)).catch((err: unknown) => {
			throw mapFileStoreError(err);
		});
		if (!read.found) return undefined;
		const record = validateRecord(read.value);
		// The record must belong to the session it is filed under; a mismatch is
		// corruption, not a benign "wrong file".
		if (record.checkpoint.session_id !== sessionId) {
			throw new LearningRecordError("RECORD_CORRUPT", "学习记录 session_id 与文件所属会话不一致", { sessionId });
		}
		return record;
	}

	/**
	 * Read the public view: private answer/rubric/hints and internal evaluation
	 * are omitted. Unlike `recoverState`, this does not derive a recovery action
	 * and does not touch the projection.
	 */
	async publicView(sessionId: string): Promise<PublicLearningSessionRecord | undefined> {
		const record = await this.get(sessionId);
		if (!record) return undefined;
		return {
			schema_version: 1,
			checkpoint: {
				revision: record.checkpoint.revision,
				status: record.checkpoint.status,
				step: record.checkpoint.step,
				updated_at: record.checkpoint.updated_at,
			},
			questions: record.questions.map(publicQuestion),
		};
	}

	/**
	 * Read the authoritative record, rebuild a stale projection, and derive the
	 * public learning state plus the recovery action for any in-flight attempt.
	 *
	 * - The projection is refreshed only when the meta projection's revision lags
	 *   the authoritative checkpoint (no pointless write when they already agree).
	 * - The recovery action reuses `learningRecoveryAction` unchanged; this method
	 *   only names the next step and performs no scoring/evidence work (that is a
	 *   later package).
	 * - When this process does not hold the writer lock, reading still works and
	 *   the projection repair is skipped rather than forcing a takeover.
	 */
	async recoverState(
		sessionId: string,
		options: { processRunId: string; maxEvaluationAttempts: number },
	): Promise<PublicLearningState | undefined> {
		const record = await this.get(sessionId);
		if (!record) return undefined;

		// Repair a lagging projection when we can become (or already are) the
		// writer. A read-only process that cannot acquire the lock degrades to a
		// plain read instead of fighting the owner.
		await this.tryRepairProjection(sessionId, record);

		const pendingAttemptId = record.checkpoint.pending_attempt_id;
		const pending = pendingAttemptId
			? record.attempts.find((attempt) => attempt.attempt_id === pendingAttemptId)
			: undefined;

		const state: PublicLearningState = {
			schema_version: 1,
			checkpoint: {
				revision: record.checkpoint.revision,
				status: record.checkpoint.status,
				step: record.checkpoint.step,
				updated_at: record.checkpoint.updated_at,
			},
			questions: record.questions.map(publicQuestion),
		};
		if (pending) {
			state.pending_action = learningRecoveryAction(pending, options.processRunId, options.maxEvaluationAttempts);
		}
		return state;
	}

	/**
	 * Repair the projection when it lags the authoritative record. Only attempts
	 * a write when this store can hold the writer lock; otherwise it degrades to
	 * a read (never pre-empting another process's writer).
	 */
	private async tryRepairProjection(sessionId: string, record: LearningSessionRecord): Promise<void> {
		if (this.closed) return;
		// Already a writer, or can become one without a write actually pending.
		const canRepair = this.injectedLock !== undefined || this.ownLock !== undefined || await this.canAcquireForRepair();
		if (!canRepair) return;
		const metaEntry = await this.metaStore.get(sessionId);
		const projectedRevision = (metaEntry?.learning as { revision?: number } | undefined)?.revision;
		if (projectedRevision === record.checkpoint.revision) return;
		await this.metaStore.setLearningProjection(sessionId, projectionOf(record)).catch((err: unknown) => {
			logger.warn({ err, sessionId }, "learning projection repair failed (recoverable)");
		});
	}

	/** Best-effort: acquire the writer lock only if it is currently free. */
	private async canAcquireForRepair(): Promise<boolean> {
		try {
			this.ownLock = await acquireWriterLock(this.dataDir);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Idempotently create the initial record for a session.
	 *
	 * When a record already exists it is returned unchanged: no revision bump, no
	 * checkpoint mutation, no `updated_at` rewrite. `goalId` is only applied to a
	 * record created here, never to an existing one (the goal is a creation-time
	 * hint, not an update). Concurrent creators serialize on the per-file queue,
	 * so exactly one of them wins and the others observe the winner's record.
	 */
	async create(sessionId: string, options?: { goalId?: string }): Promise<LearningSessionRecord> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (existing) return existing;
			const record: LearningSessionRecord = {
				schema_version: 1,
				checkpoint: {
					schema_version: 1,
					session_id: sessionId,
					revision: 1,
					status: "active",
					step: "conversation",
					...(options?.goalId ? { goal_id: options.goalId } : {}),
					exposure_sequence: 0,
					updated_at: this.now().toISOString(),
				},
				questions: [],
				exposures: [],
				attempts: [],
			};
			await writeJsonDurable(filePath, record).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			await this.refreshProjection(sessionId, record).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection refresh failed (recoverable)");
			});
			return record;
		});
	}

	/**
	 * Serialized read-modify-write of the authoritative record, then a projection
	 * refresh. `expectedRevision` is the checkpoint revision the caller last saw;
	 * when the on-disk record disagrees the update aborts with RECORD_CONFLICT and
	 * nothing is written (stale requests never overwrite newer state).
	 *
	 * The mutator receives the record and returns `false` to skip persistence
	 * (still validates the revision). On success the record is fsync'd, its
	 * checkpoint revision is bumped, and the meta projection is refreshed.
	 */
	async update(
		sessionId: string,
		expectedRevision: number | undefined,
		mutate: (record: LearningSessionRecord) => boolean | void,
	): Promise<LearningSessionRecord> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			const currentRevision = existing?.checkpoint.revision ?? 0;
			if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
				throw new LearningRecordError("RECORD_CONFLICT", "学习检查点已被更新，请重新加载", { sessionId, currentRevision });
			}
			const record: LearningSessionRecord = existing ?? {
				schema_version: 1,
				checkpoint: {
					schema_version: 1,
					session_id: sessionId,
					revision: 0,
					status: "active",
					step: "conversation",
					exposure_sequence: 0,
					updated_at: this.now().toISOString(),
				},
				questions: [],
				exposures: [],
				attempts: [],
			};
			const changed = mutate(record);
			if (changed === false) return record;

			record.checkpoint.revision += 1;
			record.checkpoint.updated_at = this.now().toISOString();
			await writeJsonDurable(filePath, record).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			// Authority first, projection second. A crash here leaves a newer
			// authoritative record with a stale projection; the next access
			// re-projects and converges.
			await this.refreshProjection(sessionId, record).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection refresh failed (recoverable)");
			});
			return record;
		});
	}

	async pause(sessionId: string, expectedRevision: number): Promise<LearningSessionRecord> {
		return this.update(sessionId, expectedRevision, (record) => {
			if (record.checkpoint.status === "completed") return false;
			record.checkpoint.status = "paused";
		});
	}

	async resume(sessionId: string, expectedRevision: number): Promise<LearningSessionRecord> {
		return this.update(sessionId, expectedRevision, (record) => {
			if (record.checkpoint.status !== "paused") return false;
			record.checkpoint.status = "active";
		});
	}

	/** Rebuild the meta projection from the authoritative record (idempotent). */
	async refreshProjection(sessionId: string, record?: LearningSessionRecord): Promise<void> {
		const authoritative = record ?? (await this.get(sessionId));
		if (!authoritative) {
			await this.metaStore.setLearningProjection(sessionId, null);
			return;
		}
		await this.metaStore.setLearningProjection(sessionId, projectionOf(authoritative));
	}

	/** Remove the authoritative record and its projection (session deletion). */
	async remove(sessionId: string): Promise<boolean> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (!existing) return false;
			await removeFile(filePath).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			await this.metaStore.setLearningProjection(sessionId, null).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection removal failed (recoverable)");
			});
			return true;
		});
	}

	/**
	 * Stop accepting new writes, drain the already-accepted queues, then release
	 * the store-owned writer lock. `closed` flips first so any write starting
	 * after this line is rejected by `assertOpen` before it can enqueue; writes
	 * accepted before the flip finish before the lock is released.
	 */
	async close(): Promise<void> {
		this.closed = true;
		const tails = [...fileQueues.entries()].filter(([path]) => path.startsWith(this.dir));
		await Promise.all(tails.map(([, tail]) => tail));
		const lock = this.ownLock;
		this.ownLock = undefined;
		await lock?.release();
	}

	private assertOpen(): void {
		if (this.closed) throw new LearningRecordError("RECORD_CLOSED", "学习记录存储已关闭");
	}

	private async ensureWriteLock(): Promise<void> {
		// `closed` is checked by assertOpen() before a write enqueues.
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

/** Re-exported question ref helper for callers that only need identity. */
export type { LearningQuestionRef, LearningCheckpoint, LearningQuestion };
