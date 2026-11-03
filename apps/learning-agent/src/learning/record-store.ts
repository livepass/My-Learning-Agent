import { join } from "node:path";
import { logger } from "../logger.js";
import { FileStoreError, readJsonStrict, removeFile, writeJsonDurable } from "../storage/file-store.js";
import { WriterLockError, acquireWriterLock, type WriterLockHandle } from "../storage/writer-lock.js";
import { SessionMetaStore, type SessionLearningProjection } from "../shared/session-meta-store.js";
import { advanceCheckpointForAttempt, assertSameAttempt, canCommitNextQuestion, LearningContractError, nextQuestionRejectionMessage, publicQuestion, learningRecoveryAction, type LearningRecoveryAction } from "./contracts.js";
import type {
	LearningAttempt,
	LearningAttemptProgress,
	LearningCheckpoint,
	LearningEvent,
	LearningQuestion,
	LearningQuestionRef,
	LearningSessionRecord,
	PublicLearningQuestion,
	ValidatedLearningAssessment,
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
	| "RECORD_STATE_INVALID"
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
	checkpoint: PublicCheckpoint;
	questions: PublicLearningQuestion[];
}

/**
 * Public checkpoint. `question` is the identity of the question currently being
 * answered (id + version only) so a client knows what to render; the answer,
 * rubric and hints stay server-side.
 */
export interface PublicCheckpoint {
	revision: number;
	status: LearningCheckpoint["status"];
	step: LearningCheckpoint["step"];
	updated_at: string;
	question?: LearningQuestionRef;
	/** A saved answer awaiting evaluation, if any. Identity only, never its text. */
	pending_attempt_id?: string;
	/** The last attempt successfully finalized into evidence. */
	last_completed_attempt_id?: string;
	/**
	 * How the current question was grounded. Type only: no page path, excerpt,
	 * answer or rubric. Absent for questions written before C1.
	 */
	knowledge?: { kind: "l2_document" | "model_knowledge" };
}

/**
 * Public learning state with the recovery action for an in-flight attempt.
 * `pending_action` is derived from the existing `learningRecoveryAction` state
 * machine and only names the next step — it never leaks the answer, rubric,
 * hints or any internal evaluation payload.
 */
export interface PublicLearningState {
	schema_version: 1;
	checkpoint: PublicCheckpoint;
	questions: PublicLearningQuestion[];
	pending_action?: LearningRecoveryAction;
	/** Minimal public view of the saved attempts (C2). */
	attempts?: PublicAttemptView[];
}

/**
 * Public view of one saved answer and its evaluation state.
 *
 * Exposes exactly what the learner needs to resume: their own answer, the
 * evaluation stage, the persisted assessment (or failure + retryability), and
 * `unknown_reason`. It never carries the reference answer, the private rubric
 * weights, the adopted knowledge excerpt, or the raw model reply.
 */
export interface PublicAttemptView {
	attempt_id: string;
	question_id: string;
	question_version: string;
	/** The learner's own answer, verbatim — resumable after a refresh/restart. */
	answer: string;
	accepted_at: string;
	/** Durable evaluation stage. */
	stage: LearningAttempt["progress"]["stage"];
	/** Present once evaluated; never the reference answer or rubric weights. */
	assessment?: {
		result: ValidatedLearningAssessment["result"];
		score?: number;
		feedback: string;
		unknown_reason?: string;
		criteria: { criterion_id: string; judgment: string; explanation: string }[];
	};
	/** Present when evaluation failed; `retryable` reflects the remaining budget. */
	failure?: { code: string; message: string };
	retryable: boolean;
	evaluation_attempts: number;
}

/**
 * Project one attempt to its public view. `retryable` is derived from the
 * remaining budget, not from the caller, so a tampered client cannot claim it
 * may retry a failed evaluation it has already exhausted.
 */
function publicAttemptView(attempt: LearningAttempt, maxEvaluationAttempts: number): PublicAttemptView {
	const base: PublicAttemptView = {
		attempt_id: attempt.attempt_id,
		question_id: attempt.question_id,
		question_version: attempt.question_version,
		answer: attempt.answer,
		accepted_at: attempt.accepted_at,
		stage: attempt.progress.stage,
		retryable: attempt.progress.stage === "evaluation_failed" && attempt.evaluation_attempts < maxEvaluationAttempts,
		evaluation_attempts: attempt.evaluation_attempts,
	};
	if (
		attempt.progress.stage === "evaluated" ||
		attempt.progress.stage === "evidence_recorded" ||
		attempt.progress.stage === "profile_projected" ||
		attempt.progress.stage === "completed"
	) {
		const assessment = attempt.progress.assessment;
		base.assessment = {
			result: assessment.result,
			score: assessment.score,
			feedback: assessment.feedback,
			...(assessment.unknown_reason ? { unknown_reason: assessment.unknown_reason } : {}),
			criteria: assessment.criteria.map((item) => ({
				criterion_id: item.criterion_id,
				judgment: item.judgment,
				explanation: item.explanation,
			})),
		};
	} else if (attempt.progress.stage === "evaluation_failed") {
		base.failure = { code: attempt.progress.failure.code, message: attempt.progress.failure.message };
	}
	return base;
}

/** Project the authoritative checkpoint down to its public shape. */
export function publicCheckpoint(record: LearningSessionRecord): PublicCheckpoint {
	const checkpoint = record.checkpoint;
	// Identity only: a ref carries no prompt, rubric, hints or answer.
	const ref = checkpoint.question;
	const current = ref
		? record.questions.find((question) => question.question_id === ref.question_id
			&& question.question_version === ref.question_version)
		: undefined;
	return {
		revision: checkpoint.revision,
		status: checkpoint.status,
		step: checkpoint.step,
		updated_at: checkpoint.updated_at,
		...(ref ? { question: { question_id: ref.question_id, question_version: ref.question_version } } : {}),
		// A pending attempt id lets the client offer "score now"; its answer text,
		// rubric and internal evaluation state stay server-side.
		...(checkpoint.pending_attempt_id ? { pending_attempt_id: checkpoint.pending_attempt_id } : {}),
		...(checkpoint.last_completed_attempt_id ? { last_completed_attempt_id: checkpoint.last_completed_attempt_id } : {}),
		// Source type only, and only when the question recorded one.
		...(current?.knowledge ? { knowledge: { kind: current.knowledge.kind } } : {}),
	};
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
			checkpoint: publicCheckpoint(record),
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
		// Read + repair under the same per-record queue every writer uses, so the
		// snapshot we project is always the newest committed record. A stale
		// snapshot can therefore never be written back over a newer checkpoint.
		const record = await this.repairAndRead(sessionId);
		if (!record) return undefined;

		const pendingAttemptId = record.checkpoint.pending_attempt_id;
		const pending = pendingAttemptId
			? record.attempts.find((attempt) => attempt.attempt_id === pendingAttemptId)
			: undefined;

		const state: PublicLearningState = {
			schema_version: 1,
			checkpoint: publicCheckpoint(record),
			questions: record.questions.map(publicQuestion),
			// Minimal public attempt views so the learner can resume their own
			// answer and its evaluation state across refresh/restart.
			...(record.attempts.length > 0 ? {
				attempts: record.attempts.map((attempt) => publicAttemptView(attempt, options.maxEvaluationAttempts)),
			} : {}),
		};
		if (pending) {
			state.pending_action = learningRecoveryAction(pending, options.processRunId, options.maxEvaluationAttempts);
		}
		return state;
	}

	/**
	 * Serialize the read-and-repair with every writer on this record, then project
	 * only if the meta projection is stale. Returns the fresh authoritative record
	 * so the caller's public state matches what was projected.
	 */
	private async repairAndRead(sessionId: string): Promise<LearningSessionRecord | undefined> {
		if (this.closed) return this.get(sessionId);
		return runExclusive(this.filePath(sessionId), async () => {
			// A read-only process that cannot take the lock still returns the
			// newest record; it just does not repair the projection.
			const canRepair = this.injectedLock !== undefined || this.ownLock !== undefined || await this.canAcquireForRepair();
			const fresh = await this.get(sessionId);
			if (!fresh || !canRepair) return fresh;
			const metaEntry = await this.metaStore.get(sessionId);
			const projectedRevision = (metaEntry?.learning as { revision?: number } | undefined)?.revision;
			// Already consistent: no write, no revision churn.
			if (projectedRevision === fresh.checkpoint.revision) return fresh;
			// Monotonic guard inside the meta write boundary: even a racing older
			// projection can never lower the stored revision.
			await this.metaStore.setLearningProjection(sessionId, projectionOf(fresh), {
				onlyIfNewerLearningRevision: true,
			}).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection repair failed (recoverable)");
			});
			return fresh;
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
	async create(sessionId: string, options?: { goalId?: string; sessionExists?: () => boolean }): Promise<LearningSessionRecord> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (existing) return existing;
			// Evaluated inside the write boundary: initialising a record for a
			// session deleted concurrently must fail instead of resurrecting it.
			if (options?.sessionExists && !options.sessionExists()) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "会话不存在，无法创建学习记录", { sessionId });
			}
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

	/**
	 * Commit a generated question and advance the checkpoint — one atomic write.
	 *
	 * Ordering matters and is enforced here, inside the same per-record queue and
	 * writer lock every other write uses:
	 *
	 * 1. the record must exist (a deleted session is never recreated);
	 * 2. an already-committed `requestId` short-circuits *before* the revision
	 *    check, so a legitimate retry with a stale `expectedRevision` still gets
	 *    its own question back instead of a spurious conflict;
	 * 3. the same `requestId` with a different fingerprint is a conflict — the
	 *    old question is never silently reused for a different request;
	 * 4. otherwise `expectedRevision` must match and the checkpoint must still
	 *    allow a new question (`active` + `conversation` + nothing pending).
	 *
	 * On success exactly one question is appended and the revision advances by
	 * one. `exposures`/`attempts` are untouched: C1 generates questions, it does
	 * not record answers or evidence.
	 */
	async commitQuestion(
		sessionId: string,
		input: {
			requestId: string;
			fingerprint: string;
			expectedRevision: number;
			question: LearningQuestion;
			/**
			 * C4: the completed attempt this question continues from. Optional for
			 * the first question of a session; mandatory once the checkpoint is at
			 * `feedback`.
			 */
			afterAttemptId?: string;
			/** Evaluated inside the write boundary so a concurrent delete wins. */
			sessionExists: () => boolean;
		},
	): Promise<{ record: LearningSessionRecord; question: LearningQuestion; created: boolean }> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (!existing) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "学习记录不存在，请先初始化", { sessionId });
			}
			if (!input.sessionExists()) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "会话不存在，无法保存题目", { sessionId });
			}

			// Idempotency first: a retry must not be judged by its now-stale revision.
			const committed = existing.questions.find(
				(question) => question.generation?.request_id === input.requestId,
			);
			if (committed) {
				if (committed.generation?.fingerprint !== input.fingerprint) {
					throw new LearningRecordError("RECORD_CONFLICT", "该请求 ID 已用于不同的出题请求", {
						sessionId, currentRevision: existing.checkpoint.revision,
					});
				}
				return { record: existing, question: committed, created: false };
			}

			if (existing.checkpoint.revision !== input.expectedRevision) {
				throw new LearningRecordError("RECORD_CONFLICT", "学习检查点已被更新，请重新加载", {
					sessionId, currentRevision: existing.checkpoint.revision,
				});
			}

			// The state machine is shared with the service so both refuse the same
			// shapes: only a fresh `conversation` or a fully completed `feedback`
			// may produce a question. Everything else (paused, completed, mid-answer,
			// mid-evaluation, unrecorded evidence) is refused here, inside the lock,
			// where the final authoritative state is known.
			const decision = canCommitNextQuestion(existing, {
				...(input.afterAttemptId ? { afterAttemptId: input.afterAttemptId } : {}),
			});
			if (!decision.ok) {
				throw new LearningRecordError("RECORD_STATE_INVALID", nextQuestionRejectionMessage(decision.reason), { sessionId });
			}

			// Question identity is immutable history: a new question may never reuse
			// an id already published in this session, not even under a new version.
			if (existing.questions.some((question) => question.question_id === input.question.question_id)) {
				throw new LearningRecordError("RECORD_CONFLICT", "新题目的身份与历史题目冲突", {
					sessionId, currentRevision: existing.checkpoint.revision,
				});
			}

			existing.questions.push(input.question);
			existing.checkpoint.question = {
				question_id: input.question.question_id,
				question_version: input.question.question_version,
			};
			existing.checkpoint.step = "awaiting_answer";
			// `last_completed_attempt_id` deliberately survives: it still points at
			// the attempt that closed the previous question, which is history, not
			// the answer to the new one.
			existing.checkpoint.revision += 1;
			existing.checkpoint.updated_at = this.now().toISOString();

			await writeJsonDurable(filePath, existing).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			// Authority first, projection second (same contract as `update`).
			await this.refreshProjection(sessionId, existing).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection refresh failed (recoverable)");
			});
			return { record: existing, question: input.question, created: true };
		});
	}

	/**
	 * Save a learner's answer for the current question.
	 *
	 * The attempt is prepared and validated by the caller (via `prepareLearningAttempt`),
	 * but the store re-validates inside the write boundary because the checkpoint
	 * may have moved between validation and commit. Ordering mirrors `commitQuestion`:
	 *
	 * 1. idempotency first — an attempt with the same id short-circuits before the
	 *    revision check, so a retried submit returns its own attempt instead of a
	 *    spurious conflict;
	 * 2. the checkpoint must still be `active` + `awaiting_answer`, its question must
	 *    match, and no other attempt may be pending;
	 * 3. exactly one attempt is appended and `pending_attempt_id` is set, then the
	 *    revision advances once.
	 *
	 * On a replayed id with the same content the existing attempt is returned
	 * unchanged; a different content under the same id throws RECORD_CONFLICT.
	 */
	async commitAttempt(
		sessionId: string,
		input: {
			attempt: LearningAttempt;
			expectedRevision: number;
			/** Evaluated inside the write boundary so a concurrent delete wins. */
			sessionExists: () => boolean;
		},
	): Promise<{ record: LearningSessionRecord; attempt: LearningAttempt; created: boolean }> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (!existing) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "学习记录不存在，请先初始化", { sessionId });
			}
			if (!input.sessionExists()) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "会话不存在，无法保存作答", { sessionId });
			}

			// Idempotency first: a retried submit must not be judged by its stale revision.
			const committed = existing.attempts.find(
				(attempt) => attempt.attempt_id === input.attempt.attempt_id,
			);
			if (committed) {
				// Reuse the contract's idempotency check (session + question + answer):
				// a different submission under the same id is a conflict, never a
				// silent reuse. Its `attempt_conflict` maps to RECORD_CONFLICT here.
				try {
					assertSameAttempt(committed, sessionId, {
						attempt_id: input.attempt.attempt_id,
						question_id: input.attempt.question_id,
						question_version: input.attempt.question_version,
						expected_revision: input.expectedRevision,
						answer: input.attempt.answer,
					});
				} catch (err) {
					if (err instanceof LearningContractError) {
						throw new LearningRecordError("RECORD_CONFLICT", "该作答 ID 已用于不同的提交", {
							sessionId, currentRevision: existing.checkpoint.revision,
						});
					}
					throw err;
				}
				return { record: existing, attempt: committed, created: false };
			}

			if (existing.checkpoint.revision !== input.expectedRevision) {
				throw new LearningRecordError("RECORD_CONFLICT", "学习检查点已被更新，请重新加载", {
					sessionId, currentRevision: existing.checkpoint.revision,
				});
			}
			if (existing.checkpoint.status !== "active") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "学习检查点不是进行中状态，不能提交作答", { sessionId });
			}
			if (existing.checkpoint.step !== "awaiting_answer" || !existing.checkpoint.question) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "当前没有待作答的题目", { sessionId });
			}
			if (existing.checkpoint.pending_attempt_id) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "当前已有待处理的作答", { sessionId });
			}
			const questionRef = existing.checkpoint.question as LearningQuestionRef;
			if (questionRef.question_id !== input.attempt.question_id
				|| questionRef.question_version !== input.attempt.question_version) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "作答对应的题目与当前检查点不一致", { sessionId });
			}

			existing.attempts.push(input.attempt);
			existing.checkpoint.pending_attempt_id = input.attempt.attempt_id;
			existing.checkpoint.revision += 1;
			existing.checkpoint.updated_at = this.now().toISOString();

			await writeJsonDurable(filePath, existing).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			await this.refreshProjection(sessionId, existing).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection refresh failed (recoverable)");
			});
			return { record: existing, attempt: input.attempt, created: true };
		});
	}

	/**
	 * Mark an answer-saved (or failed) attempt as "evaluating" before the model
	 * call runs. This is the durable "I have started this evaluation" marker that
	 * lets `learningRecoveryAction` tell a dead-process evaluation from a live one.
	 *
	 * Increments `evaluation_attempts` so the retry budget survives a restart.
	 * The caller then calls the model outside the lock and finishes with
	 * `completeEvaluation` / `failEvaluation`.
	 *
	 * This transition is **strict**: it requires an exact `expectedRevision`, so
	 * two concurrent retries serialize and only one can start (the loser sees a
	 * moved revision or an already-`evaluating` stage and gives up).
	 */
	async beginEvaluation(
		sessionId: string,
		attemptId: string,
		input: {
			expectedRevision: number;
			progress: Extract<LearningAttemptProgress, { stage: "evaluating" }>;
		},
	): Promise<LearningSessionRecord> {
		return this.mutateAttempt(sessionId, attemptId, { expectedRevision: input.expectedRevision, strict: true }, (record, attempt) => {
			// `answer_saved` (first attempt), `evaluation_failed` (manual retry), or
			// `evaluating` (taking over a dead process's in-flight evaluation). The
			// caller decides via `learningRecoveryAction` that a new evaluation is due,
			// so a live same-process evaluation never reaches here.
			if (attempt.progress.stage !== "answer_saved"
				&& attempt.progress.stage !== "evaluation_failed"
				&& attempt.progress.stage !== "evaluating") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答当前不能开始评估", { sessionId });
			}
			attempt.evaluation_attempts += 1;
			attempt.progress = input.progress;
			return true;
		});
	}

	/**
	 * Persist a validated assessment (evaluating → evaluated).
	 *
	 * This transition is **lenient about the revision** (a pause during the model
	 * call bumps the checkpoint without invalidating the score), but it still
	 * checks the evaluation identity: the `evaluation_run_id` must match the one
	 * that began the run, so a late/stale completion can never overwrite a newer
	 * result. It never touches the checkpoint `status`, so a paused checkpoint
	 * stays paused.
	 */
	async completeEvaluation(
		sessionId: string,
		attemptId: string,
		input: {
			expectedRevision: number;
			evaluationRunId: string;
			progress: Extract<LearningAttemptProgress, { stage: "evaluated" }>;
		},
	): Promise<LearningSessionRecord> {
		return this.mutateAttempt(sessionId, attemptId, { expectedRevision: input.expectedRevision, strict: false }, (record, attempt) => {
			if (attempt.progress.stage !== "evaluating") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答没有正在进行的评估", { sessionId });
			}
			if (attempt.progress.evaluation_run_id !== input.evaluationRunId) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "评分运行已被更新，本次结果已过期", { sessionId });
			}
			attempt.progress = input.progress;
			return true;
		});
	}

	/** Persist an evaluation failure (evaluating → evaluation_failed). */
	async failEvaluation(
		sessionId: string,
		attemptId: string,
		input: {
			expectedRevision: number;
			evaluationRunId: string;
			progress: Extract<LearningAttemptProgress, { stage: "evaluation_failed" }>;
		},
	): Promise<LearningSessionRecord> {
		return this.mutateAttempt(sessionId, attemptId, { expectedRevision: input.expectedRevision, strict: false }, (record, attempt) => {
			if (attempt.progress.stage !== "evaluating") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答没有正在进行的评估", { sessionId });
			}
			if (attempt.progress.evaluation_run_id !== input.evaluationRunId) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "评分运行已被更新，本次结果已过期", { sessionId });
			}
			attempt.progress = input.progress;
			return true;
		});
	}

	/**
	 * Compensating write: roll back an evaluation that could not start a valid
	 * model request (e.g. model returned not_ready between pre-check and call).
	 *
	 * Reasons and guarantees:
	 * 1. Validates that the attempt is currently in `evaluating` and matches `evaluationRunId`,
	 *    ensuring late/stale rollbacks never overwrite newer evaluations.
	 * 2. Decrements `evaluation_attempts` (if > 0) so the uninitiated call does not
	 *    consume the learner's retry budget.
	 * 3. Restores progress to `answer_saved` or the caller's previous progress so the
	 *    attempt is not permanently stuck in `evaluating`.
	 * 4. Tolerates revision drift (strict: false) because non-conflicting checkpoint
	 *    updates (such as pausing) during the call must not block compensation.
	 */
	async rollbackEvaluation(
		sessionId: string,
		attemptId: string,
		input: {
			expectedRevision: number;
			evaluationRunId: string;
			progress?: LearningAttemptProgress;
		},
	): Promise<LearningSessionRecord> {
		return this.mutateAttempt(sessionId, attemptId, { expectedRevision: input.expectedRevision, strict: false }, (record, attempt) => {
			if (attempt.progress.stage !== "evaluating") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答没有正在进行的评估", { sessionId });
			}
			if (attempt.progress.evaluation_run_id !== input.evaluationRunId) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "评分运行已被更新，本次结果已过期", { sessionId });
			}
			if (attempt.evaluation_attempts > 0) {
				attempt.evaluation_attempts -= 1;
			}
			attempt.progress = input.progress ?? { stage: "answer_saved" };
			return true;
		});
	}

	/**
	 * Persist the recorded L1 learning evidence event (evaluated → evidence_recorded).
	 */
	async recordEvidence(
		sessionId: string,
		attemptId: string,
		input: {
			expectedRevision: number;
			event: LearningEvent;
			strict?: boolean;
		},
	): Promise<LearningSessionRecord> {
		return this.mutateAttempt(sessionId, attemptId, { expectedRevision: input.expectedRevision, strict: input.strict ?? true }, (record, attempt) => {
			if (attempt.progress.stage === "evidence_recorded") {
				return false;
			}
			if (attempt.progress.stage !== "evaluated") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答尚未评分，不能记录学习证据", { sessionId });
			}
			attempt.progress = {
				stage: "evidence_recorded",
				assessment: attempt.progress.assessment,
				event: input.event,
			};
			return true;
		});
	}

	/**
	 * Persist the confirmed profile projection (evidence_recorded → profile_projected).
	 */
	async recordProfileProjected(
		sessionId: string,
		attemptId: string,
		input: {
			expectedRevision: number;
			profileVersion: number;
			strict?: boolean;
		},
	): Promise<LearningSessionRecord> {
		return this.mutateAttempt(sessionId, attemptId, { expectedRevision: input.expectedRevision, strict: input.strict ?? true }, (record, attempt) => {
			if (attempt.progress.stage === "profile_projected") {
				return false;
			}
			if (attempt.progress.stage !== "evidence_recorded") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答尚未记录证据，不能标记画像投影", { sessionId });
			}
			attempt.progress = {
				stage: "profile_projected",
				assessment: attempt.progress.assessment,
				event: attempt.progress.event,
				profile_version: input.profileVersion,
			};
			return true;
		});
	}

	/**
	 * Complete an attempt and advance the checkpoint (profile_projected → completed).
	 *
	 * Uses `advanceCheckpointForAttempt` to advance the checkpoint step to "feedback"
	 * and clear pending_attempt_id.
	 */
	async completeAttempt(
		sessionId: string,
		attemptId: string,
		input: {
			expectedRevision: number;
			strict?: boolean;
		},
	): Promise<LearningSessionRecord> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (!existing) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "学习记录不存在", { sessionId });
			}
			if ((input.strict ?? true) && existing.checkpoint.revision !== input.expectedRevision) {
				throw new LearningRecordError("RECORD_CONFLICT", "学习检查点已被更新，请重新加载", {
					sessionId, currentRevision: existing.checkpoint.revision,
				});
			}
			const attempt = existing.attempts.find((candidate) => candidate.attempt_id === attemptId);
			if (!attempt) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "作答不存在", { sessionId });
			}
			if (attempt.progress.stage === "completed") {
				return existing;
			}
			if (attempt.progress.stage !== "profile_projected") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答尚未完成画像投影，不能完成", { sessionId });
			}
			if (existing.checkpoint.pending_attempt_id !== attemptId) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答不是当前待处理的作答", { sessionId });
			}

			const advanced = advanceCheckpointForAttempt(existing.checkpoint, attempt, this.now());
			// The attempt may only be marked `completed` when the checkpoint really
			// advanced. A refusal means the checkpoint is not in the state this
			// completion assumes (already completed, not awaiting an answer, or a
			// different question) — reporting success there would claim progress the
			// learner never made. An idempotent replay is handled above (an attempt
			// already at `completed` returns early), so reaching here with
			// `advanced === false` is always an inconsistent state.
			if (!advanced.advanced) {
				throw new LearningRecordError(
					"RECORD_STATE_INVALID",
					"学习检查点未推进（状态或题目不匹配），不能标记作答完成",
					{ sessionId, currentRevision: existing.checkpoint.revision },
				);
			}
			existing.checkpoint = advanced.checkpoint;
			attempt.progress = {
				stage: "completed",
				assessment: attempt.progress.assessment,
				event: attempt.progress.event,
				profile_version: attempt.progress.profile_version,
				checkpoint_advanced: true,
			};

			await writeJsonDurable(filePath, existing).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			await this.refreshProjection(sessionId, existing).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection refresh failed (recoverable)");
			});
			return existing;
		});
	}

	/**
	 * Serialized read-modify-write of one attempt's progress. Shared by the
	 * begin/complete/fail evaluation transitions so they all enforce the same
	 * existence + state discipline.
	 *
	 * `strict` controls the revision check: the "begin" transition must match the
	 * caller's revision exactly (so concurrent retries cannot both start), while
	 * the "complete"/"fail" transitions tolerate a moved revision because a pause
	 * during the model call must not strand the attempt in `evaluating`.
	 */
	private async mutateAttempt(
		sessionId: string,
		attemptId: string,
		options: { expectedRevision: number; strict: boolean },
		mutate: (record: LearningSessionRecord, attempt: LearningAttempt) => boolean | void,
	): Promise<LearningSessionRecord> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (!existing) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "学习记录不存在", { sessionId });
			}
			if (options.strict && existing.checkpoint.revision !== options.expectedRevision) {
				throw new LearningRecordError("RECORD_CONFLICT", "学习检查点已被更新，请重新加载", {
					sessionId, currentRevision: existing.checkpoint.revision,
				});
			}
			const attempt = existing.attempts.find((candidate) => candidate.attempt_id === attemptId);
			if (!attempt) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "作答不存在", { sessionId });
			}
			if (existing.checkpoint.pending_attempt_id !== attemptId) {
				throw new LearningRecordError("RECORD_STATE_INVALID", "该作答不是当前待处理的作答", { sessionId });
			}
			const changed = mutate(existing, attempt);
			if (changed === false) return existing;

			existing.checkpoint.revision += 1;
			existing.checkpoint.updated_at = this.now().toISOString();
			await writeJsonDurable(filePath, existing).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			await this.refreshProjection(sessionId, existing).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection refresh failed (recoverable)");
			});
			return existing;
		});
	}

	/**
	 * Pause the checkpoint.
	 *
	 * - A missing record is a 404-class error, never an implicit create.
	 * - Pausing an already-paused record is idempotent: no revision bump, no write.
	 * - A completed checkpoint cannot be paused.
	 * - A stale `expectedRevision` still fails with RECORD_CONFLICT.
	 */
	async pause(sessionId: string, expectedRevision: number): Promise<LearningSessionRecord> {
		return this.transition(sessionId, expectedRevision, "paused");
	}

	/**
	 * Resume a paused checkpoint. Same contract as `pause`: missing → not found,
	 * idempotent when already active, and a completed checkpoint can never be
	 * resumed.
	 */
	async resume(sessionId: string, expectedRevision: number): Promise<LearningSessionRecord> {
		return this.transition(sessionId, expectedRevision, "active");
	}

	/** Shared pause/resume transition with an explicit state machine. */
	private async transition(
		sessionId: string,
		expectedRevision: number,
		target: "paused" | "active",
	): Promise<LearningSessionRecord> {
		assertSessionId(sessionId);
		this.assertOpen();
		const filePath = this.filePath(sessionId);
		return runExclusive(filePath, async () => {
			await this.ensureWriteLock();
			const existing = await this.get(sessionId);
			if (!existing) {
				throw new LearningRecordError("RECORD_NOT_FOUND", "学习记录不存在", { sessionId });
			}
			if (existing.checkpoint.revision !== expectedRevision) {
				throw new LearningRecordError("RECORD_CONFLICT", "学习检查点已被更新，请重新加载", {
					sessionId, currentRevision: existing.checkpoint.revision,
				});
			}
			// A completed checkpoint is terminal: neither pause nor resume applies.
			if (existing.checkpoint.status === "completed") {
				throw new LearningRecordError("RECORD_STATE_INVALID", "学习检查点已完成，不能变更状态", { sessionId });
			}
			// Idempotent: already in the target state → return without bumping.
			if (existing.checkpoint.status === target) return existing;
			existing.checkpoint.status = target;
			existing.checkpoint.revision += 1;
			existing.checkpoint.updated_at = this.now().toISOString();
			await writeJsonDurable(filePath, existing).catch((err: unknown) => {
				throw mapFileStoreError(err);
			});
			await this.refreshProjection(sessionId, existing).catch((err: unknown) => {
				logger.warn({ err, sessionId }, "learning projection refresh failed (recoverable)");
			});
			return existing;
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
