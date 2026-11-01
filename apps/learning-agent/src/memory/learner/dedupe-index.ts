import { join } from "node:path";
import { readJsonStrict, sha256Hex, writeJsonDurable } from "../../storage/file-store.js";
import { stableStringify } from "../../utils/stable-json.js";
import { logger } from "../../logger.js";
import { readEvents, type StoredEvent } from "./event-log.js";
import type { LearningEvent } from "./types.js";

/**
 * Persistent dedupe index.
 *
 * This is *derived* data: every entry can be recomputed from the event ledger,
 * and the owner rebuilds it whenever it (re)acquires write ownership. It is
 * never the source of truth for "was this answer already recorded", so losing,
 * truncating or editing the file cannot make a committed key reusable.
 */

export const DEDUPE_INDEX_FILE = "dedupe-index.json";
export const DEDUPE_INDEX_SCHEMA_VERSION = 1;

export interface DedupeEntry {
	event_id: string;
	evidence_id?: string;
	seq: number;
	digest: string;
	event_type: string;
	recorded_at: string;
}

export interface DedupeIndex {
	schema_version: 1;
	through_seq: number;
	entries: Record<string, DedupeEntry>;
	/** Diagnostics only: number of entries, not used to decide correctness. */
	entry_count?: number;
}

export class AttemptIdentityError extends Error {
	readonly code = "ATTEMPT_IDENTITY_MISMATCH" as const;

	constructor(message: string) {
		super(message);
		this.name = "AttemptIdentityError";
	}
}

export class DedupeHistoryConflictError extends Error {
	readonly code = "HISTORY_IDENTITY_CONFLICT" as const;
	readonly conflicts: { key: string; seqs: number[] }[];

	constructor(conflicts: { key: string; seqs: number[] }[]) {
		super("历史日志中同一身份出现了不同内容");
		this.name = "DedupeHistoryConflictError";
		this.conflicts = conflicts;
	}
}

export function emptyDedupeIndex(): DedupeIndex {
	return { schema_version: DEDUPE_INDEX_SCHEMA_VERSION, through_seq: 0, entries: {}, entry_count: 0 };
}

/**
 * The identity of one formal attempt is fixed by the owner from the approved
 * tuple. A caller-supplied `dedupe_key` cannot rename the same attempt, and
 * contradictions between learner/session fields are rejected instead of being
 * silently resolved in favour of one of them.
 */
export function assertConsistentAttemptIdentity(event: LearningEvent): void {
	const attempt = event.evidence?.learning_attempt;
	if (!attempt) return;
	if (!attempt.session_id || !attempt.attempt_id) {
		throw new AttemptIdentityError("正式证据缺少 attempt/session 身份");
	}
	if (event.evidence && event.evidence.learner_id !== event.learner_id) {
		throw new AttemptIdentityError("证据学习者与事件学习者不一致");
	}
	if (event.context.session_id && event.context.session_id !== attempt.session_id) {
		throw new AttemptIdentityError("事件会话与尝试会话不一致");
	}
	if (event.evidence?.session_id && event.evidence.session_id !== attempt.session_id) {
		throw new AttemptIdentityError("证据会话与尝试会话不一致");
	}
}

/**
 * Stable idempotency identity.
 *
 * Formal evidence: the owner-controlled attempt tuple, never the caller key.
 * Other events: the explicit key, scoped by learner and session so two learners
 * or two sessions may legitimately reuse one attempt id.
 */
export function dedupeFingerprint(event: LearningEvent): string | undefined {
	const attempt = event.evidence?.learning_attempt;
	if (attempt) {
		return `formal\u0000${event.learner_id}\u0000${attempt.session_id}\u0000${attempt.attempt_id}`;
	}
	if (event.correction) {
		return `correction\u0000${event.learner_id}\u0000${event.correction.evidence_id}\u0000${event.correction.correction_id}`;
	}
	const key = event.dedupe_key?.trim();
	if (!key) return undefined;
	return `event\u0000${event.learner_id}\u0000${event.context?.session_id ?? ""}\u0000${key}`;
}

/**
 * Content digest used to distinguish "same write retried" from "same key with a
 * different answer". Server-assigned and volatile fields are excluded so a
 * retry that regenerates ids/timestamps still matches; the idempotency key and
 * correction id are aliases, not content, and are therefore excluded too.
 */
export function dedupeContentDigest(event: LearningEvent): string {
	// Round-trip first so a freshly built event (keys present with `undefined`)
	// and the stored record (those keys omitted by JSON) hash identically.
	const clone = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
	delete clone.seq;
	delete clone.event_id;
	delete clone.timestamp;
	delete clone.schema_version;
	delete clone.dedupe_key;
	if (clone.evidence && typeof clone.evidence === "object") {
		const evidence = { ...(clone.evidence as Record<string, unknown>) };
		delete evidence.evidence_id;
		delete evidence.event_id;
		delete evidence.occurred_at;
		clone.evidence = evidence;
	}
	if (clone.correction && typeof clone.correction === "object") {
		const correction = { ...(clone.correction as Record<string, unknown>) };
		delete correction.correction_id;
		delete correction.event_id;
		delete correction.occurred_at;
		clone.correction = correction;
	}
	return sha256Hex(stableStringify(clone));
}

export function entryFromEvent(event: StoredEvent): { key: string; entry: DedupeEntry } | undefined {
	const key = dedupeFingerprint(event);
	if (!key) return undefined;
	return {
		key,
		entry: {
			event_id: event.event_id,
			evidence_id: event.evidence?.evidence_id,
			seq: event.seq,
			digest: dedupeContentDigest(event),
			event_type: event.event_type,
			recorded_at: event.timestamp,
		},
	};
}

/**
 * Rebuild the index from every segment in the ledger.
 *
 * A repeated identity with a different digest is a history conflict, not a
 * "first one wins" case: the effective record is ambiguous and no further write
 * can be accepted until it is reconciled.
 */
export async function rebuildDedupeIndex(dir: string): Promise<DedupeIndex> {
	const { events, manifest } = await readEvents(dir, { verify: true });
	const index = emptyDedupeIndex();
	const conflicts = new Map<string, number[]>();

	for (const event of events) {
		const item = entryFromEvent(event);
		if (!item) continue;
		const existing = index.entries[item.key];
		if (!existing) {
			index.entries[item.key] = item.entry;
			continue;
		}
		if (existing.digest !== item.entry.digest) {
			const seqs = conflicts.get(item.key) ?? [existing.seq];
			seqs.push(item.entry.seq);
			conflicts.set(item.key, seqs);
		}
	}

	if (conflicts.size > 0) {
		throw new DedupeHistoryConflictError(
			[...conflicts.entries()].map(([key, seqs]) => ({ key, seqs })),
		);
	}

	index.through_seq = manifest.segments[manifest.segments.length - 1].seq_end;
	index.entry_count = Object.keys(index.entries).length;
	await writeJsonDurable(join(dir, DEDUPE_INDEX_FILE), index);
	logger.info({ entries: index.entry_count, through: index.through_seq }, "rebuilt learner dedupe index");
	return index;
}

export async function readDedupeIndexFile(dir: string): Promise<DedupeIndex | undefined> {
	try {
		const read = await readJsonStrict<DedupeIndex>(join(dir, DEDUPE_INDEX_FILE));
		return read.found ? read.value : undefined;
	} catch {
		return undefined;
	}
}

export async function saveDedupeIndex(dir: string, index: DedupeIndex): Promise<void> {
	await writeJsonDurable(join(dir, DEDUPE_INDEX_FILE), index);
}
