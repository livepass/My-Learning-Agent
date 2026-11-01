import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
	FileStoreError,
	readJsonStrict,
	writeJsonDurable,
} from "../../storage/file-store.js";
import {
	acquireWriterLock,
	WriterLockError,
	type WriterLockHandle,
} from "../../storage/writer-lock.js";
import { logger } from "../../logger.js";
import { stableStringify } from "../../utils/stable-json.js";
import { CorrectionError, buildEffectiveEvidence, deterministicCorrectionId } from "./corrections.js";
import {
	appendEvent,
	ensureEventLog,
	LearnerLogError,
	readEvents,
	readEventsWithoutRepair,
	readRecentEvents,
	readRecentEventsWithoutRepair,
	type EventManifest,
	type StoredEvent,
} from "./event-log.js";
import {
	AttemptIdentityError,
	DedupeHistoryConflictError,
	assertConsistentAttemptIdentity,
	dedupeContentDigest,
	dedupeFingerprint,
	entryFromEvent,
	rebuildDedupeIndex,
	saveDedupeIndex,
	type DedupeIndex,
} from "./dedupe-index.js";
import {
	PROJECTION_RULE_VERSION,
	commitProjection,
	latestFactTime,
	projectionAsOf,
	type ProjectionCommitResult,
} from "./projection.js";
import {
	classifyStoreState,
	createStoreState,
	readStoreState,
	writeStoreState,
	type StoreClassification,
	type StoreStateFile,
} from "./store-state.js";
import {
	createDefaultProfile,
	type LearnerProfile,
	type LearningEvent,
	type ManualStamp,
} from "./types.js";

/**
 * Single owner of the L1 learner store.
 *
 * Responsibilities:
 * - one writer process per canonical data directory (writer lock);
 * - one in-process serialization point for every read-modify-write;
 * - durable append of the event ledger before any derived side effect;
 * - a projection cursor committed in the same atomic profile replace as the
 *   derived fields it summarises, so a crash between "event saved" and
 *   "profile saved" is always detectable and repairable;
 * - no silent rebuild over human-managed fields: a missing profile with
 *   history fails closed instead of being replaced by an empty one.
 *
 * Callers must not write `profile.json`, `events.jsonl`, the manifest, the
 * dedupe index or the store-state marker directly.
 */

const PROFILE_FILE = "profile.json";

export type LearnerStoreErrorCode =
	| "PROFILE_CORRUPT"
	| "PROFILE_UNAVAILABLE"
	| "PROFILE_MISSING"
	| "PROFILE_WRITE_FAILED"
	| "STORE_INCONSISTENT"
	| "STORE_STATE_CORRUPT"
	| "EVENT_LOG_CORRUPT"
	| "EVENT_LOG_MISSING_SEGMENT"
	| "STORE_WRITE_DISABLED"
	| "STORE_UNAVAILABLE"
	| "LEARNING_RECORD_CONFLICT"
	| "HISTORY_IDENTITY_CONFLICT"
	| "ATTEMPT_IDENTITY_MISMATCH"
	| "CORRECTION_CONFLICT"
	| "PROJECTION_CONFLICT";

/** Public store failure: `code` is safe to return to a client, `message` is not a path. */
export class LearnerStoreError extends Error {
	readonly code: LearnerStoreErrorCode;

	constructor(code: LearnerStoreErrorCode, message: string) {
		super(message);
		this.name = "LearnerStoreError";
		this.code = code;
	}
}

export type LearnerStoreMode = "owner" | "read_only" | "unavailable";

export interface LearnerStoreStatus {
	mode: LearnerStoreMode;
	lastSeq: number;
	appliedSeq?: number;
	code?: LearnerStoreErrorCode;
}

interface StoreState {
	dir: string;
	mode: "owner" | "read_only";
	lock?: WriterLockHandle;
	fatal?: LearnerStoreError;
	/** Serializes every read-modify-write inside this process. */
	mutex: Promise<void>;
	lastSeq: number;
	/** In-memory dedupe index, rebuilt on every ownership acquisition. */
	dedupe?: DedupeIndex;
}

const stores = new Map<string, StoreState>();
const pendingInits = new Map<string, Promise<StoreState>>();

function profilePath(dir: string): string {
	return join(dir, PROFILE_FILE);
}

function lastSeqOf(manifest: EventManifest): number {
	return manifest.segments[manifest.segments.length - 1].seq_end;
}

function toStoreError(err: unknown): LearnerStoreError {
	if (err instanceof LearnerStoreError) return err;
	if (err instanceof AttemptIdentityError) {
		return new LearnerStoreError("ATTEMPT_IDENTITY_MISMATCH", err.message);
	}
	if (err instanceof DedupeHistoryConflictError) {
		return new LearnerStoreError("HISTORY_IDENTITY_CONFLICT", err.message);
	}
	if (err instanceof CorrectionError) {
		return new LearnerStoreError("CORRECTION_CONFLICT", err.message);
	}
	if (err instanceof WriterLockError) {
		return new LearnerStoreError(
			err.code === "WRITER_LOCK_HELD" ? "STORE_WRITE_DISABLED" : "STORE_UNAVAILABLE",
			err.message,
		);
	}
	if (err instanceof LearnerLogError) {
		return new LearnerStoreError(
			err.code === "EVENT_LOG_MISSING_SEGMENT" ? "EVENT_LOG_MISSING_SEGMENT" : "EVENT_LOG_CORRUPT",
			err.message,
		);
	}
	if (err instanceof FileStoreError) {
		if (err.code === "FILE_CORRUPT") return new LearnerStoreError("PROFILE_CORRUPT", "学习者存储文件损坏，已停止写入");
		return new LearnerStoreError("STORE_UNAVAILABLE", "学习者存储暂时不可用");
	}
	const code = (err as { code?: string } | undefined)?.code;
	if (code === "STORE_STATE_CORRUPT") {
		return new LearnerStoreError("STORE_STATE_CORRUPT", "存储状态标记损坏，已停止写入");
	}
	return new LearnerStoreError("STORE_UNAVAILABLE", "学习者存储操作失败");
}

function withMutex<T>(state: StoreState, fn: () => Promise<T>): Promise<T> {
	// Every public operation funnels through here, so this is also the single
	// place where low-level file/log failures become public store errors.
	const guarded = async (): Promise<T> => {
		try {
			return await fn();
		} catch (err) {
			throw toStoreError(err);
		}
	};
	const run = state.mutex.then(guarded, guarded);
	state.mutex = run.then(() => undefined, () => undefined);
	return run;
}

function validateProfile(value: unknown): LearnerProfile {
	const profile = value as LearnerProfile;
	if (
		!profile
		|| typeof profile !== "object"
		|| !Array.isArray(profile.goals)
		|| !Array.isArray(profile.knowledge_states)
		|| !Array.isArray(profile.misconceptions)
		|| typeof profile.profile_summary !== "string"
		|| !profile.preferences
		|| typeof profile.preferences !== "object"
	) {
		throw new LearnerStoreError("PROFILE_CORRUPT", "学习者画像结构不受支持，已停止写入");
	}
	return profile;
}

async function readProfileFile(state: StoreState): Promise<LearnerProfile | undefined> {
	const read = await readJsonStrict<LearnerProfile>(profilePath(state.dir));
	if (!read.found) return undefined;
	return validateProfile(read.value);
}

async function saveProfileLocked(state: StoreState, profile: LearnerProfile): Promise<void> {
	// A profile without a cursor would be read as "never projected"; every
	// committed profile must state its projection boundary explicitly.
	if (!profile.projection) {
		profile.projection = { applied_seq: 0, rule_version: PROJECTION_RULE_VERSION };
	}
	profile.version = (profile.version ?? 0) + 1;
	profile.updated_at = new Date().toISOString();
	try {
		await writeJsonDurable(profilePath(state.dir), profile);
	} catch (err) {
		logger.error({ err }, "failed to persist learner profile");
		throw new LearnerStoreError("PROFILE_WRITE_FAILED", "学习者画像保存失败，本次写入未完成");
	}
}

async function assertOwner(state: StoreState): Promise<void> {
	if (state.fatal) throw state.fatal;
	if (state.mode !== "owner" || !state.lock) {
		throw new LearnerStoreError("STORE_WRITE_DISABLED", "当前进程没有学习者数据目录的写入权");
	}
	try {
		await state.lock.assertOwned();
	} catch (err) {
		const converted = toStoreError(err);
		state.fatal = converted;
		throw converted;
	}
}

function stampFor(profile: LearnerProfile, atSeq: number): ManualStamp {
	const edit = (profile.manual_edit_seq ?? 0) + 1;
	profile.manual_edit_seq = edit;
	return { at_seq: atSeq, edit };
}

/**
 * One-time upgrade of data written before field ownership existed: freeze the
 * current user-visible values at the ledger watermark. Documented trade-off:
 * older events no longer change these fields, which is exactly what "preserve
 * the manual value" means for data that cannot prove where each value came from.
 */
function freezeLegacyManualBaseline(profile: LearnerProfile, lastSeq: number): void {
	for (const goal of profile.goals) {
		if (goal.manual) continue;
		goal.manual = {
			title: stampFor(profile, lastSeq),
			priority: stampFor(profile, lastSeq),
			status: stampFor(profile, lastSeq),
			success_criteria: stampFor(profile, lastSeq),
		};
	}
	const fields = ["explanation_style", "practice_style", "feedback_tone", "avoid"] as const;
	profile.preferences.manual = { ...(profile.preferences.manual ?? {}) };
	for (const field of fields) {
		if (!profile.preferences.manual[field]) {
			profile.preferences.manual[field] = stampFor(profile, lastSeq);
		}
	}
	for (const item of profile.misconceptions) {
		if (item.manual) continue;
		item.manual = {
			status: stampFor(profile, lastSeq),
			severity: stampFor(profile, lastSeq),
			repair_strategy: stampFor(profile, lastSeq),
		};
	}
}

async function markReady(state: StoreState, classified: StoreClassification): Promise<void> {
	const current = await readStoreState(state.dir).catch(() => ({ found: false as const }));
	const base: StoreStateFile = current.found
		? current.value
		: createStoreState();
	if (base.profile_state === "ready" && base.projection_rule_version === PROJECTION_RULE_VERSION) return;
	await writeStoreState(state.dir, {
		...base,
		profile_state: "ready",
		ready_at: base.ready_at ?? new Date().toISOString(),
		projection_rule_version: PROJECTION_RULE_VERSION,
	});
	void classified;
}

async function ensureDedupeIndex(state: StoreState): Promise<DedupeIndex> {
	if (!state.dedupe || state.dedupe.through_seq !== state.lastSeq) {
		state.dedupe = await rebuildDedupeIndex(state.dir);
	}
	return state.dedupe;
}

interface RecoveryResult {
	applied: number;
	appliedSeq: number;
}

async function fullRebuildLocked(state: StoreState, profile: LearnerProfile): Promise<RecoveryResult> {
	const { events } = await readEvents(state.dir, { verify: true });
	const result: ProjectionCommitResult = commitProjection(profile, events, {
		mode: "full",
		lastSeq: state.lastSeq,
		asOf: projectionAsOf(events),
	});
	await saveProfileLocked(state, profile);
	return { applied: result.applied, appliedSeq: result.lastSeq };
}

function latestAsOf(profile: LearnerProfile, events: StoredEvent[], fallback?: Date): Date {
	const stored = profile.projection?.as_of ? Date.parse(profile.projection.as_of) : undefined;
	const pending = latestFactTime(events);
	const times = [stored, pending?.getTime(), fallback?.getTime()].filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value),
	);
	return new Date(times.length > 0 ? Math.max(...times) : Date.now());
}

/**
 * Close the gap between the committed ledger and the profile cursor.
 * Runs on every business access, so a crash after the event append is repaired
 * without the user re-submitting anything.
 */
async function recoverLocked(
	state: StoreState,
	profile: LearnerProfile,
	options?: { persist?: boolean },
): Promise<RecoveryResult> {
	const persist = options?.persist ?? true;
	const projection = profile.projection ?? { applied_seq: 0, rule_version: PROJECTION_RULE_VERSION };
	if (projection.applied_seq > state.lastSeq) {
		throw new LearnerStoreError("PROJECTION_CONFLICT", "画像投影超前于事件日志，已停止写入");
	}
	if (projection.rule_version !== PROJECTION_RULE_VERSION) {
		return fullRebuildLocked(state, profile);
	}
	if (projection.applied_seq >= state.lastSeq) {
		return { applied: 0, appliedSeq: projection.applied_seq };
	}

	const { events: pending } = await readEvents(state.dir, { fromSeq: projection.applied_seq + 1 });
	if (pending.length === 0) {
		return { applied: 0, appliedSeq: projection.applied_seq };
	}
	// Corrections change the effective evidence view; they cannot be folded in
	// as an extra delta, so the derived projection is recomputed.
	if (pending.some((event) => event.correction)) {
		return fullRebuildLocked(state, profile);
	}

	const result = commitProjection(profile, pending, {
		mode: "incremental",
		lastSeq: state.lastSeq,
		asOf: latestAsOf(profile, pending),
	});
	if (persist) await saveProfileLocked(state, profile);
	return { applied: pending.length, appliedSeq: result.lastSeq };
}

async function projectAfterAppend(state: StoreState, profile: LearnerProfile, event: StoredEvent): Promise<RecoveryResult> {
	const cursor = profile.projection?.applied_seq ?? 0;
	if (event.correction) return fullRebuildLocked(state, profile);
	if (cursor + 1 === event.seq) {
		const result = commitProjection(profile, [event], {
			mode: "incremental",
			lastSeq: event.seq,
			asOf: latestAsOf(profile, [event], new Date(event.timestamp)),
		});
		await saveProfileLocked(state, profile);
		return { applied: 1, appliedSeq: result.lastSeq };
	}
	// A previous projection failed or lagged: replay the actual gap instead of
	// assuming order.
	return recoverLocked(state, profile);
}

async function findEventBySeq(state: StoreState, seq: number): Promise<StoredEvent | undefined> {
	const { events } = await readEvents(state.dir, { fromSeq: seq });
	return events.find((event) => event.seq === seq);
}

/**
 * Load the store, classify the directory and bring the profile to a committed
 * projection. Runs on every ownership acquisition (initial start, promotion
 * from read-only, and takeover after another writer exits).
 */
async function bootstrap(state: StoreState): Promise<void> {
	const classified = await classifyStoreState(state.dir);

	if (classified.kind === "inconsistent") {
		throw new LearnerStoreError("STORE_INCONSISTENT", "目录存在学习历史但缺少画像与状态标记，已停止自动覆盖");
	}
	if (classified.kind === "profile_missing") {
		throw new LearnerStoreError("PROFILE_MISSING", "学习者画像缺失但历史仍存在，需要显式恢复");
	}
	if (classified.kind === "new_directory" || classified.kind === "legacy_upgrade") {
		await writeStoreState(state.dir, {
			...createStoreState(),
			projection_rule_version: PROJECTION_RULE_VERSION,
		});
	}

	const { manifest } = await ensureEventLog(state.dir, "strict");
	state.lastSeq = lastSeqOf(manifest);

	let profile = await readProfileFile(state);
	if (!profile) {
		profile = createDefaultProfile();
		if (state.lastSeq > 0) {
			const { events } = await readEvents(state.dir, { verify: true });
			commitProjection(profile, events, {
				mode: "full",
				lastSeq: state.lastSeq,
				asOf: projectionAsOf(events),
			});
		} else {
			profile.projection = { applied_seq: 0, rule_version: PROJECTION_RULE_VERSION };
		}
		await saveProfileLocked(state, profile);
	} else {
		const projection = profile.projection;
		const needsFull = classified.kind === "legacy_upgrade"
			|| !projection
			|| projection.rule_version !== PROJECTION_RULE_VERSION;
		if (needsFull) {
			// Freeze the current user-visible values before the first rebuild of
			// data that predates field ownership. Idempotent: existing stamps stay.
			freezeLegacyManualBaseline(profile, state.lastSeq);
			const { events } = await readEvents(state.dir, { verify: true });
			commitProjection(profile, events, {
				mode: "full",
				lastSeq: state.lastSeq,
				asOf: projectionAsOf(events),
			});
			await saveProfileLocked(state, profile);
		} else {
			await recoverLocked(state, profile);
		}
	}

	// Ownership acquisition is exactly where the index must be re-derived from
	// the ledger: a previous process may have appended and died before writing
	// its cache, and the cache is never authoritative.
	state.dedupe = undefined;
	await ensureDedupeIndex(state);
	await markReady(state, classified);
}

async function initializeState(canonical: string): Promise<StoreState> {
	const state: StoreState = {
		dir: canonical,
		mode: "read_only",
		mutex: Promise.resolve(),
		lastSeq: 0,
	};
	try {
		state.lock = await acquireWriterLock(canonical);
		state.mode = "owner";
		await withMutex(state, () => bootstrap(state));
	} catch (err) {
		const converted = toStoreError(err);
		if (err instanceof WriterLockError && err.code === "WRITER_LOCK_HELD") {
			// Reads stay available; every write is refused with a public code.
			state.mode = "read_only";
			state.lock = undefined;
			logger.warn("learner store opened read-only: another process owns the writer lock");
			return state;
		}
		state.fatal = converted;
		state.mode = "read_only";
		state.lock = undefined;
		logger.error({ code: converted.code }, "learner store unavailable");
	}
	return state;
}

/**
 * Promote a read-only process to writer when the previous owner is gone.
 * Re-runs the full bootstrap so the index and projection reflect any writes
 * that happened while we were not the owner.
 */
async function ensureOwnership(state: StoreState): Promise<void> {
	if (state.fatal) throw state.fatal;
	if (state.mode === "owner" && state.lock) return;
	await withMutex(state, async () => {
		if (state.mode === "owner" && state.lock) return;
		try {
			state.lock = await acquireWriterLock(state.dir);
			state.mode = "owner";
		} catch (err) {
			if (err instanceof WriterLockError && err.code === "WRITER_LOCK_HELD") {
				throw toStoreError(err);
			}
			const converted = toStoreError(err);
			state.fatal = converted;
			throw converted;
		}
		logger.info("learner store promoted to single writer");
		try {
			await bootstrap(state);
		} catch (err) {
			const converted = toStoreError(err);
			state.fatal = converted;
			throw converted;
		}
	});
}

async function getState(dir: string): Promise<StoreState> {
	await mkdir(dir, { recursive: true });
	const canonical = await realpath(dir);
	const existing = stores.get(canonical);
	if (existing) return existing;

	let pending = pendingInits.get(canonical);
	if (!pending) {
		pending = initializeState(canonical);
		pendingInits.set(canonical, pending);
	}
	const state = await pending;
	stores.set(canonical, state);
	pendingInits.delete(canonical);
	return state;
}

function assertHealthy(state: StoreState): void {
	if (state.fatal) throw state.fatal;
}

/**
 * Boot-time initialisation. Never throws: a second process or a damaged store
 * must not prevent the app from starting, but it must also never pretend that
 * writes are possible.
 */
export async function initializeLearnerStore(dir: string): Promise<LearnerStoreStatus> {
	try {
		const state = await getState(dir);
		if (state.fatal) {
			return { mode: "unavailable", lastSeq: state.lastSeq, code: state.fatal.code };
		}
		if (state.mode === "read_only") {
			return { mode: "read_only", lastSeq: state.lastSeq };
		}
		const profile = await loadProfile(dir);
		return {
			mode: state.mode,
			lastSeq: state.lastSeq,
			appliedSeq: profile.projection?.applied_seq,
		};
	} catch (err) {
		const converted = toStoreError(err);
		logger.error({ code: converted.code }, "learner store initialisation failed");
		return { mode: "unavailable", lastSeq: 0, code: converted.code };
	}
}

/** Load the profile, repairing any pending projection first. */
export async function loadProfile(dir: string): Promise<LearnerProfile> {
	const state = await getState(dir);
	assertHealthy(state);

	if (state.mode === "read_only") {
		try {
			const profile = await readProfileFile(state);
			if (!profile) {
				throw new LearnerStoreError("PROFILE_UNAVAILABLE", "学习者画像暂不可用，请在主进程完成恢复后重试");
			}
			return profile;
		} catch (err) {
			throw toStoreError(err);
		}
	}

	return withMutex(state, async () => {
		await assertOwner(state);
		const profile = await readProfileFile(state);
		if (!profile) {
			throw new LearnerStoreError("PROFILE_MISSING", "学习者画像缺失但历史仍存在，需要显式恢复");
		}
		await recoverLocked(state, profile);
		return profile;
	});
}

/** Explicit full-profile save. Prefer `mutateProfile` for read-modify-write. */
export async function saveProfile(dir: string, profile: LearnerProfile): Promise<LearnerProfile> {
	const state = await getState(dir);
	await ensureOwnership(state);
	return withMutex(state, async () => {
		await assertOwner(state);
		// Never replace a file we could not parse with a caller-provided object:
		// that would destroy the only copy of the damaged data.
		await readProfileFile(state);
		await saveProfileLocked(state, profile);
		return profile;
	});
}

/**
 * Serialized read-modify-write of the profile. The mutator returns `false` to
 * skip the write; any other return value is persisted.
 */
export async function mutateProfile(
	dir: string,
	mutator: (profile: LearnerProfile) => boolean | void,
): Promise<LearnerProfile> {
	const state = await getState(dir);
	await ensureOwnership(state);
	return withMutex(state, async () => {
		await assertOwner(state);
		const profile = await readProfileFile(state);
		if (!profile) {
			throw new LearnerStoreError("PROFILE_MISSING", "学习者画像缺失但历史仍存在，需要显式恢复");
		}
		await recoverLocked(state, profile, { persist: false });
		const changed = mutator(profile);
		if (changed !== false) await saveProfileLocked(state, profile);
		return profile;
	});
}

export interface RecordEventOptions {
	/** Rotate the active segment once it reached this size (bytes). */
	maxBytes?: number;
}

export interface RecordEventResult {
	status: "recorded" | "duplicate";
	event: StoredEvent;
	profile: LearnerProfile;
	applied: number;
}

/**
 * Record one learning event and fold it into the profile.
 *
 * The ledger append is durable before any derived effect; the projection then
 * runs inside the same critical section so a committed event is never left
 * without its derived state when the call returns.
 */
export async function recordEventAndUpdateProfile(
	dir: string,
	event: LearningEvent,
	options: RecordEventOptions = {},
): Promise<RecordEventResult> {
	const state = await getState(dir);
	await ensureOwnership(state);
	return withMutex(state, async () => {
		await assertOwner(state);
		const { manifest } = await ensureEventLog(state.dir, "strict");
		state.lastSeq = lastSeqOf(manifest);
		// Validate the profile *before* committing an event: a damaged profile
		// must stop the write instead of leaving a fact that can never be
		// projected into it.
		const profile = await readProfileFile(state);
		if (!profile) {
			throw new LearnerStoreError("PROFILE_MISSING", "学习者画像缺失但历史仍存在，需要显式恢复");
		}

		if (event.correction) {
			const { correction_id: _ignored, ...rest } = event.correction;
			event.correction.correction_id = deterministicCorrectionId(rest);
		}
		assertConsistentAttemptIdentity(event);

		const index = await ensureDedupeIndex(state);

		const fingerprint = dedupeFingerprint(event);
		const digest = dedupeContentDigest(event);
		if (fingerprint) {
			const existing = index.entries[fingerprint];
			if (existing) {
				if (existing.digest !== digest) {
					throw new LearnerStoreError("LEARNING_RECORD_CONFLICT", "同一去重键提交了不同内容，已拒绝覆盖原记录");
				}
				// A retried write returns the original record before any chain
				// validation: the chain would otherwise reject a legal retry.
				const recovery = await recoverLocked(state, profile);
				const stored = await findEventBySeq(state, existing.seq);
				return {
					status: "duplicate",
					event: stored ?? { ...event, seq: existing.seq, event_id: existing.event_id },
					profile,
					applied: recovery.applied,
				};
			}
		}

		// A correction changes the meaning of earlier evidence, so an invalid or
		// ambiguous chain must be rejected *before* it is committed.
		if (event.correction) {
			const { events } = await readEvents(state.dir, { verify: true });
			buildEffectiveEvidence([...events, { ...event, seq: state.lastSeq + 1 }]);
		}

		const appended = await appendEvent(state.dir, event, { maxBytes: options.maxBytes });
		state.lastSeq = lastSeqOf(appended.manifest);

		const entry = entryFromEvent(appended.event);
		if (entry) {
			index.entries[entry.key] = entry.entry;
			index.through_seq = appended.event.seq;
			index.entry_count = Object.keys(index.entries).length;
			state.dedupe = index;
			try {
				await saveDedupeIndex(state.dir, index);
			} catch (err) {
				// Derived data: the ledger is committed, the index will be rebuilt.
				logger.warn({ err }, "failed to persist learner dedupe index");
			}
		}

		const recovery = await projectAfterAppend(state, profile, appended.event);
		return { status: "recorded", event: appended.event, profile, applied: recovery.applied };
	});
}

/** Record an event without returning the profile. */
export async function recordEvent(
	dir: string,
	event: LearningEvent,
	options: RecordEventOptions = {},
): Promise<{ status: "recorded" | "duplicate"; event: StoredEvent }> {
	const result = await recordEventAndUpdateProfile(dir, event, options);
	return { status: result.status, event: result.event };
}

/** Full replay of the ledger, ordered by stable sequence across segments. */
export async function loadEvents(dir: string): Promise<LearningEvent[]> {
	const state = await getState(dir);
	assertHealthy(state);
	if (state.mode === "read_only") {
		const { events } = await readEventsWithoutRepair(state.dir);
		return events;
	}
	return withMutex(state, async () => {
		await assertOwner(state);
		const { events, manifest } = await readEvents(state.dir);
		state.lastSeq = lastSeqOf(manifest);
		return events;
	});
}

/** Recent events for prompt context; reads only the tail window. */
export async function loadRecentEvents(
	dir: string,
	count: number,
	tailBytes?: number,
): Promise<LearningEvent[]> {
	const state = await getState(dir);
	assertHealthy(state);
	if (state.mode === "read_only") {
		return readRecentEventsWithoutRepair(state.dir, count, tailBytes);
	}
	return withMutex(state, async () => {
		await assertOwner(state);
		return readRecentEvents(state.dir, count, tailBytes);
	});
}

export function isProfileEmpty(profile: LearnerProfile): boolean {
	return profile.goals.length === 0
		&& profile.knowledge_states.length === 0
		&& profile.profile_summary === ""
		&& profile.preferences.explanation_style.length === 0
		&& profile.preferences.practice_style.length === 0;
}

export interface RebuildReport {
	changed: boolean;
	applied: number;
	events: number;
	corrections: number;
	lastSeq: number;
	asOf: string;
	preservedManualStates: number;
	preservedLegacyStates: number;
	resetDerivedStates: number;
	issues: string[];
}

/**
 * Recompute the derived projection from the whole ledger.
 *
 * Manual fields (goals, preferences, `profile_summary`, human misconception
 * status) are preserved; only fields whose source is the ledger are reset and
 * replayed. A missing segment, an invalid correction chain or a damaged profile
 * aborts before anything is written.
 */
export async function rebuildLearnerProjection(
	dir: string,
	options?: { asOf?: Date },
): Promise<RebuildReport> {
	const state = await getState(dir);
	await ensureOwnership(state);
	return withMutex(state, async () => {
		await assertOwner(state);
		const profile = await readProfileFile(state);
		if (!profile) {
			throw new LearnerStoreError("PROFILE_MISSING", "学习者画像缺失但历史仍存在，需要显式恢复");
		}
		const { events, manifest } = await readEvents(state.dir, { verify: true });
		state.lastSeq = lastSeqOf(manifest);
		const asOf = options?.asOf ?? projectionAsOf(events);
		// Order-insensitive comparison: a rebuild that only reorders keys must not
		// bump the version or rewrite the file.
		const before = stableStringify({ ...profile, version: 0, updated_at: "" });
		const result = commitProjection(profile, events, {
			mode: "full",
			lastSeq: state.lastSeq,
			asOf,
		});
		const after = stableStringify({ ...profile, version: 0, updated_at: "" });
		const changed = before !== after;
		if (changed) await saveProfileLocked(state, profile);
		return {
			changed,
			applied: result.applied,
			events: events.length,
			corrections: events.filter((event) => !!event.correction).length,
			lastSeq: result.lastSeq,
			asOf: result.asOf,
			preservedManualStates: result.preservedManualStates,
			preservedLegacyStates: result.preservedLegacyStates,
			resetDerivedStates: result.resetDerivedStates,
			issues: result.issues,
		};
	});
}

export interface RecoverProfileOptions {
	/** Must be explicitly true; silent recovery is not allowed. */
	acceptManualLoss: boolean;
	reason: string;
}

/**
 * Explicit recovery for a store whose profile was lost.
 *
 * Requires write ownership, quarantines whatever remains, rebuilds from the
 * ledger and records an audit entry with the lost field categories.
 */
export async function recoverMissingProfile(
	dir: string,
	options: RecoverProfileOptions,
): Promise<LearnerProfile> {
	if (!options.acceptManualLoss) {
		throw new LearnerStoreError("PROFILE_MISSING", "恢复会丢失人工字段，必须显式确认");
	}
	const state = await getState(dir);
	// A process that booted against the damaged store is marked fatal; an
	// explicit recovery is the one operation allowed to clear that state.
	if (state.fatal && state.fatal.code !== "PROFILE_MISSING") throw state.fatal;
	state.fatal = undefined;
	if (!state.lock) {
		try {
			state.lock = await acquireWriterLock(state.dir);
			state.mode = "owner";
		} catch (err) {
			throw toStoreError(err);
		}
	}
	await ensureOwnership(state);
	return withMutex(state, async () => {
		await assertOwner(state);
		const existing = await readProfileFile(state);
		if (existing) {
			throw new LearnerStoreError("PROFILE_MISSING", "画像仍然存在，请使用重建而不是丢失恢复");
		}
		const { manifest } = await ensureEventLog(state.dir, "strict");
		state.lastSeq = lastSeqOf(manifest);
		const profile = createDefaultProfile();
		if (state.lastSeq > 0) {
			const { events } = await readEvents(state.dir, { verify: true });
			commitProjection(profile, events, {
				mode: "full",
				lastSeq: state.lastSeq,
				asOf: projectionAsOf(events),
			});
		}
		profile.manual_fields_lost = true;
		await saveProfileLocked(state, profile);

		const current = await readStoreState(state.dir).catch(() => ({ found: false as const }));
		const base = current.found ? current.value : createStoreState();
		await writeStoreState(state.dir, {
			...base,
			profile_state: "ready",
			ready_at: new Date().toISOString(),
			projection_rule_version: PROJECTION_RULE_VERSION,
			recovery: {
				at: new Date().toISOString(),
				accepted_manual_loss: true,
				lost_fields: ["goals", "preferences", "profile_summary", "misconceptions"],
				reason: options.reason,
			},
		});
		state.dedupe = undefined;
		await ensureDedupeIndex(state);
		return profile;
	});
}
