import { join } from "node:path";
import {
	appendJsonlDurable,
	listDirectory,
	parseJsonlStrict,
	readJsonStrict,
	readJsonlTailAsync,
	readTextStrict,
	renameFile,
	sha256Hex,
	statFile,
	writeFileDurable,
	writeJsonDurable,
} from "../../storage/file-store.js";
import { logger } from "../../logger.js";
import type { LearningEvent } from "./types.js";

/**
 * Append-only learner event ledger with explicit segmentation.
 *
 * Every record gets a monotonic `seq` assigned by the single writer. Archives
 * are listed in `events.manifest.json` instead of being discovered by filename,
 * so replay order never depends on timestamps or directory iteration.
 *
 * Integrity protocol for the active segment:
 *
 * - the manifest stores `{bytes, sha256}` of the **committed prefix**, not of
 *   the whole file;
 * - a write first proves that prefix still hashes to the recorded digest, then
 *   accepts a trailing region only if it parses as complete, contiguous
 *   appends (the "event fsynced, manifest update lost" crash window);
 * - a same-size byte change or any non-contiguous tail stops writes instead of
 *   appending to a ledger that can no longer be trusted.
 *
 * Sealed segments are immutable: their size and mtime are checked on every
 * write, and their sha256 is verified in full when history is read for a
 * rebuild or an explicit verification.
 */

export const EVENTS_FILE = "events.jsonl";
export const EVENTS_MANIFEST_FILE = "events.manifest.json";
export const EVENTS_SEGMENT_PATTERN = /^events\.(\d+)-(\d+)\.jsonl$/;
export const LEGACY_ARCHIVE_PATTERN = /^events\.jsonl\..+\.archive$/;
export const TORN_TAIL_PATTERN = /^events\.torn-\d+\.bin$/;

export const DEFAULT_EVENTS_MAX_BYTES = 10 * 1024 * 1024;

export type LearnerLogErrorCode =
	| "EVENT_LOG_CORRUPT"
	| "EVENT_LOG_MISSING_SEGMENT"
	| "EVENT_LOG_UNREADABLE";

export class LearnerLogError extends Error {
	readonly code: LearnerLogErrorCode;
	readonly detail?: string;

	constructor(code: LearnerLogErrorCode, message: string, detail?: string) {
		super(message);
		this.name = "LearnerLogError";
		this.code = code;
		this.detail = detail;
	}
}

export interface EventSegment {
	file: string;
	base_seq: number;
	seq_end: number;
	count: number;
	/** Byte size of the committed prefix. */
	bytes: number;
	/** sha256 of the committed prefix bytes. */
	sha256?: string;
	/** Last observed mtime (ms) for sealed segments; detects same-size rewrites. */
	mtime_ms?: number;
	sealed: boolean;
	sealed_at?: string;
}

export interface EventManifest {
	schema_version: 1;
	next_seq: number;
	segments: EventSegment[];
}

export interface StoredEvent extends LearningEvent {
	seq: number;
}

export interface EventLogState {
	manifest: EventManifest;
	repaired: boolean;
	/** Reconciled text of the active segment (strict mode only). */
	activeRaw?: string;
}

const SAFE_SEGMENT_FILE = /^[A-Za-z0-9._-]+$/;

function manifestPath(dir: string): string {
	return join(dir, EVENTS_MANIFEST_FILE);
}

function segmentPath(dir: string, segment: EventSegment): string {
	if (!SAFE_SEGMENT_FILE.test(segment.file) || segment.file.includes("..")) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段文件名不合法", segment.file);
	}
	return join(dir, segment.file);
}

function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Parse a segment, converting storage-level corruption into a log error. */
function parseSegment<T>(
	raw: string,
	file: string,
	options?: { allowTornTail?: boolean },
): { records: T[]; tornTail?: string } {
	try {
		return parseJsonlStrict<T>(raw, file, options);
	} catch {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件日志损坏，已停止写入", file);
	}
}

function validateManifest(manifest: EventManifest): void {
	if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.segments)) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件清单结构不受支持");
	}
	if (!isInt(manifest.next_seq) || manifest.next_seq < 1) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件清单序号不合法");
	}
	let expectedBase = 1;
	let unsealed = 0;
	for (const segment of manifest.segments) {
		if (!segment || typeof segment.file !== "string" || !isInt(segment.base_seq) || !isInt(segment.count)) {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段结构不合法");
		}
		if (segment.base_seq !== expectedBase) {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段序号不连续", `expected ${expectedBase}, got ${segment.base_seq}`);
		}
		if (segment.seq_end !== segment.base_seq + segment.count - 1) {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段范围与数量不一致", segment.file);
		}
		if (!isInt(segment.bytes)) {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段字节数不合法", segment.file);
		}
		if (segment.sha256 !== undefined && typeof segment.sha256 !== "string") {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段摘要不合法", segment.file);
		}
		if (!segment.sealed) unsealed += 1;
		expectedBase = segment.seq_end + 1;
	}
	if (manifest.segments.length === 0) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件清单没有活动段");
	}
	if (unsealed !== 1 || manifest.segments[manifest.segments.length - 1].sealed) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件清单必须且只能有一个末尾活动段");
	}
	if (manifest.next_seq !== expectedBase) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件清单下一个序号与段范围不一致");
	}
}

export async function readManifest(dir: string): Promise<EventManifest | undefined> {
	const read = await readJsonStrict<EventManifest>(manifestPath(dir));
	if (!read.found) return undefined;
	validateManifest(read.value);
	return read.value;
}

async function saveManifest(dir: string, manifest: EventManifest): Promise<void> {
	validateManifest(manifest);
	await writeJsonDurable(manifestPath(dir), manifest);
}

function segmentFromDisk(
	file: string,
	baseSeq: number,
	count: number,
	bytes: number,
	sealed: boolean,
): EventSegment {
	return {
		file,
		base_seq: baseSeq,
		seq_end: baseSeq + count - 1,
		count,
		bytes,
		sealed,
	};
}

async function writeTornTail(dir: string, torn: string): Promise<void> {
	if (!torn) return;
	const preserved = `events.torn-${Date.now()}.bin`;
	await writeFileDurable(join(dir, preserved), torn);
	logger.warn({ preserved, bytes: Buffer.byteLength(torn, "utf8") }, "preserved uncommitted event tail");
}

/**
 * Reconcile the active segment against the committed prefix recorded in the
 * manifest, adopting only provably committed appends.
 */
async function reconcileActive(
	dir: string,
	segment: EventSegment,
): Promise<{ segment: EventSegment; raw: string; changed: boolean }> {
	const filePath = segmentPath(dir, segment);
	const read = await readTextStrict(filePath);
	if (!read.found) {
		if (segment.count === 0) {
			return {
				segment: { ...segment, bytes: 0, sha256: undefined },
				raw: "",
				changed: segment.bytes !== 0 || !!segment.sha256,
			};
		}
		throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "事件活动段缺失但清单记录了记录数", segment.file);
	}

	let text = read.text;
	let changed = false;
	let size = Buffer.byteLength(text, "utf8");
	if (size < segment.bytes) {
		throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "事件活动段小于已提交长度", segment.file);
	}

	// A trailing region without a final newline can only be an append that never
	// completed; preserve its bytes verbatim before dropping them from the log.
	if (size > segment.bytes && !text.endsWith("\n")) {
		const lastNewline = text.lastIndexOf("\n");
		const torn = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
		const kept = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
		await writeTornTail(dir, torn);
		await writeFileDurable(filePath, kept);
		text = kept;
		size = Buffer.byteLength(text, "utf8");
		changed = true;
	}

	const bytes = Buffer.from(text, "utf8");
	const prefix = bytes.subarray(0, segment.bytes);
	if (segment.sha256 && sha256Hex(prefix) !== segment.sha256) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件活动段已提交前缀校验失败", segment.file);
	}
	if (!segment.sha256 && segment.bytes > 0) changed = true; // backfill the digest

	let count = segment.count;
	let seqEnd = segment.seq_end;
	if (size > segment.bytes) {
		const tail = bytes.subarray(segment.bytes).toString("utf8");
		const parsed = parseSegment<LearningEvent>(tail, segment.file);
		let expected = segment.base_seq + segment.count;
		for (const record of parsed.records) {
			if (record.seq !== expected) {
				throw new LearnerLogError("EVENT_LOG_CORRUPT", "活动段尾部不是连续追加", segment.file);
			}
			expected += 1;
		}
		count += parsed.records.length;
		seqEnd = expected - 1;
		changed = true;
	}

	const next: EventSegment = {
		...segment,
		count,
		seq_end: seqEnd,
		bytes: size,
		sha256: size > 0 ? sha256Hex(bytes) : undefined,
	};
	if (next.count !== segment.count || next.bytes !== segment.bytes || next.sha256 !== segment.sha256) {
		changed = true;
	}
	return { segment: next, raw: text, changed };
}

async function verifySealedSegment(dir: string, segment: EventSegment): Promise<void> {
	const info = await statFile(segmentPath(dir, segment));
	if (!info) {
		throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "事件段文件缺失", segment.file);
	}
	if (info.size !== segment.bytes) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段大小与清单不一致", segment.file);
	}
	if (segment.mtime_ms !== undefined && Math.abs(info.mtimeMs - segment.mtime_ms) > 1) {
		throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段在封装后被修改", segment.file);
	}
}

/** Build the manifest for a directory that predates segmentation. */
async function migrateLegacyLog(dir: string, files: string[]): Promise<EventManifest> {
	const legacyArchives = files
		.filter((name) => LEGACY_ARCHIVE_PATTERN.test(name))
		// ISO timestamps in the historical archive name sort chronologically.
		.sort();
	const segments: EventSegment[] = [];
	let nextSeq = 1;

	for (const name of legacyArchives) {
		const filePath = join(dir, name);
		const read = await readTextStrict(filePath);
		if (!read.found) continue;
		const parsed = parseSegment<LearningEvent>(read.text, filePath);
		const bytes = Buffer.byteLength(read.text, "utf8");
		const info = await statFile(filePath);
		const segment = segmentFromDisk(name, nextSeq, parsed.records.length, bytes, true);
		segment.sha256 = sha256Hex(read.text);
		segment.mtime_ms = info?.mtimeMs;
		segment.sealed_at = new Date().toISOString();
		segments.push(segment);
		nextSeq = segment.seq_end + 1;
	}

	const active = segmentFromDisk(EVENTS_FILE, nextSeq, 0, 0, false);
	const reconciled = await reconcileActive(dir, active);
	segments.push(reconciled.segment);
	nextSeq = reconciled.segment.seq_end + 1;

	const manifest: EventManifest = { schema_version: 1, next_seq: nextSeq, segments };
	await saveManifest(dir, manifest);
	logger.info({ segments: segments.length, nextSeq }, "migrated learner event log to segmented manifest");
	return manifest;
}

export type EnsureMode = "light" | "strict";

/**
 * Ensure the ledger is present, migrated and internally consistent.
 * Must only be called while holding the writer lock.
 *
 * - `light`: existence and size only (per-turn prompt reads).
 * - `strict`: verifies the active prefix digest, adopts legal tails and checks
 *   sealed size/mtime (writes and rebuilds).
 */
export async function ensureEventLog(
	dir: string,
	mode: EnsureMode = "strict",
): Promise<EventLogState> {
	const files = await listDirectory(dir);
	const existing = await readManifest(dir);
	const manifest = existing ?? await migrateLegacyLog(dir, files);
	if (!existing) {
		return { manifest, repaired: true, activeRaw: "" };
	}

	if (mode === "light") {
		for (const segment of manifest.segments) {
			const info = await statFile(segmentPath(dir, segment));
			if (!info) {
				if (segment.count === 0) continue;
				throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "事件段文件缺失", segment.file);
			}
			if (segment.sealed && info.size !== segment.bytes) {
				throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段大小与清单不一致", segment.file);
			}
		}
		return { manifest, repaired: false };
	}

	let repaired = false;
	const segments = [...manifest.segments];

	for (let i = 0; i < segments.length - 1; i++) {
		await verifySealedSegment(dir, segments[i]);
	}

	const activeIndex = segments.length - 1;
	let active = segments[activeIndex];

	// A rotation that renamed the file but did not reach the manifest leaves
	// the active file missing and an unlisted archive behind.
	if (!(await statFile(segmentPath(dir, active)))) {
		if (active.count > 0) {
			const candidateName = `events.${active.base_seq}-${active.seq_end}.jsonl`;
			if (!files.includes(candidateName)) {
				throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "事件活动段缺失但清单记录了记录数", active.file);
			}
			const read = await readTextStrict(join(dir, candidateName));
			if (!read.found) {
				throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "轮转归档文件缺失", candidateName);
			}
			const parsed = parseSegment<LearningEvent>(read.text, candidateName);
			if (parsed.records.length !== active.count) {
				throw new LearnerLogError("EVENT_LOG_CORRUPT", "轮转归档的记录数与清单不一致", candidateName);
			}
			const info = await statFile(join(dir, candidateName));
			segments[activeIndex] = {
				...active,
				file: candidateName,
				sealed: true,
				bytes: Buffer.byteLength(read.text, "utf8"),
				sha256: sha256Hex(read.text),
				mtime_ms: info?.mtimeMs,
				sealed_at: new Date().toISOString(),
			};
			active = segmentFromDisk(EVENTS_FILE, active.seq_end + 1, 0, 0, false);
			segments.push(active);
			repaired = true;
		}
	}

	const reconciled = await reconcileActive(dir, active);
	if (reconciled.changed) {
		repaired = true;
		segments[activeIndex] = reconciled.segment;
	}

	// Adopt archives created by a rotation that crashed before the manifest
	// write, in sequence order. Anything that does not continue the ledger is a
	// missing or duplicated segment, which must stop writes rather than guess.
	const listed = new Set(segments.map((segment) => segment.file));
	const unlisted = files
		.filter((name) => EVENTS_SEGMENT_PATTERN.test(name) && !listed.has(name))
		.sort((a, b) => {
			const left = Number(EVENTS_SEGMENT_PATTERN.exec(a)?.[1] ?? 0);
			const right = Number(EVENTS_SEGMENT_PATTERN.exec(b)?.[1] ?? 0);
			return left - right;
		});
	for (const name of unlisted) {
		const match = EVENTS_SEGMENT_PATTERN.exec(name);
		if (!match) continue;
		const base = Number(match[1]);
		const end = Number(match[2]);
		const tail = segments[segments.length - 1];
		if (base !== tail.base_seq || tail.count !== 0) {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "存在无法归属的历史事件段", name);
		}
		const read = await readTextStrict(join(dir, name));
		if (!read.found) {
			throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "历史事件段文件缺失", name);
		}
		const parsed = parseSegment<LearningEvent>(read.text, name);
		if (parsed.records.length === 0 || end !== base + parsed.records.length - 1) {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "历史事件段范围与内容不一致", name);
		}
		const info = await statFile(join(dir, name));
		segments[segments.length - 1] = {
			...tail,
			file: name,
			count: parsed.records.length,
			seq_end: end,
			bytes: Buffer.byteLength(read.text, "utf8"),
			sealed: true,
			sha256: sha256Hex(read.text),
			mtime_ms: info?.mtimeMs,
			sealed_at: new Date().toISOString(),
		};
		segments.push(segmentFromDisk(EVENTS_FILE, end + 1, 0, 0, false));
		repaired = true;
	}

	const next: EventManifest = {
		schema_version: 1,
		next_seq: segments[segments.length - 1].seq_end + 1,
		segments,
	};
	validateManifest(next);
	if (repaired || JSON.stringify(next) !== JSON.stringify(manifest)) {
		await saveManifest(dir, next);
	}
	return { manifest: next, repaired, activeRaw: reconciled.raw };
}

/** Read events in ledger order, optionally only from `fromSeq` onwards. */
export async function readEvents(
	dir: string,
	options?: { fromSeq?: number; verify?: boolean },
): Promise<{ events: StoredEvent[]; manifest: EventManifest }> {
	const ensured = await ensureEventLog(dir, "strict");
	const { manifest } = ensured;
	const fromSeq = options?.fromSeq ?? 1;
	const events: StoredEvent[] = [];

	for (const segment of manifest.segments) {
		if (segment.count === 0 || segment.seq_end < fromSeq) continue;
		const isActive = segment === manifest.segments[manifest.segments.length - 1];
		let raw: string | undefined;
		if (isActive && ensured.activeRaw !== undefined) {
			raw = ensured.activeRaw;
		} else {
			const read = await readTextStrict(segmentPath(dir, segment));
			raw = read.found ? read.text : undefined;
		}
		if (raw === undefined) {
			throw new LearnerLogError("EVENT_LOG_MISSING_SEGMENT", "事件段文件缺失", segment.file);
		}
		if (options?.verify && segment.sealed && segment.sha256) {
			const actual = sha256Hex(raw);
			if (actual !== segment.sha256) {
				throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段内容与封装摘要不一致", segment.file);
			}
		}
		const parsed = parseSegment<LearningEvent>(raw, segment.file);
		if (parsed.records.length !== segment.count) {
			throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件段记录数与清单不一致", segment.file);
		}
		for (let i = 0; i < parsed.records.length; i++) {
			const expected = segment.base_seq + i;
			const record = parsed.records[i];
			if (record.seq !== undefined && record.seq !== expected) {
				throw new LearnerLogError("EVENT_LOG_CORRUPT", "事件序号与位置不一致", `${segment.file}#${i + 1}`);
			}
			if (expected >= fromSeq) events.push({ ...record, seq: expected });
		}
	}

	return { events, manifest };
}

async function rotate(
	dir: string,
	manifest: EventManifest,
	activeRaw: string,
	maxBytes: number,
): Promise<EventManifest> {
	const active = manifest.segments[manifest.segments.length - 1];
	if (active.count === 0) return manifest;
	const size = Buffer.byteLength(activeRaw, "utf8");
	if (size < maxBytes) return manifest;

	const sealedName = `events.${active.base_seq}-${active.seq_end}.jsonl`;
	await renameFile(segmentPath(dir, active), join(dir, sealedName));
	const info = await statFile(join(dir, sealedName));
	const sealed: EventSegment = {
		...active,
		file: sealedName,
		bytes: size,
		sha256: sha256Hex(activeRaw),
		mtime_ms: info?.mtimeMs,
		sealed: true,
		sealed_at: new Date().toISOString(),
	};
	const fresh = segmentFromDisk(EVENTS_FILE, active.seq_end + 1, 0, 0, false);
	const next: EventManifest = {
		schema_version: 1,
		next_seq: active.seq_end + 1,
		segments: [...manifest.segments.slice(0, -1), sealed, fresh],
	};
	await saveManifest(dir, next);
	logger.info({ sealed: sealedName, bytes: size }, "rotated learner event log");
	return next;
}

export interface AppendEventResult {
	event: StoredEvent;
	manifest: EventManifest;
	rotated: boolean;
}

/**
 * Append one event with the next sequence number, rotating first when the
 * active segment reached `maxBytes`.
 */
export async function appendEvent(
	dir: string,
	event: LearningEvent,
	options?: { maxBytes?: number },
): Promise<AppendEventResult> {
	const maxBytes = options?.maxBytes ?? DEFAULT_EVENTS_MAX_BYTES;
	const ensured = await ensureEventLog(dir, "strict");
	let manifest = ensured.manifest;
	let activeRaw = ensured.activeRaw ?? "";
	let rotated = false;

	const active = manifest.segments[manifest.segments.length - 1];
	if (active.count > 0 && Buffer.byteLength(activeRaw, "utf8") >= maxBytes) {
		manifest = await rotate(dir, manifest, activeRaw, maxBytes);
		activeRaw = "";
		rotated = true;
	}

	const seq = manifest.next_seq;
	const stored: StoredEvent = { ...event, seq, schema_version: event.schema_version ?? 3 };
	const current = manifest.segments[manifest.segments.length - 1];
	try {
		await appendJsonlDurable(segmentPath(dir, current), stored);
	} catch (err) {
		throw new LearnerLogError("EVENT_LOG_UNREADABLE", "学习事件保存失败", (err as Error).message);
	}

	const line = JSON.stringify(stored) + "\n";
	const nextRaw = activeRaw + line;
	const updatedActive: EventSegment = {
		...current,
		count: current.count + 1,
		seq_end: seq,
		bytes: Buffer.byteLength(nextRaw, "utf8"),
		sha256: sha256Hex(nextRaw),
	};
	const next: EventManifest = {
		schema_version: 1,
		next_seq: seq + 1,
		segments: [...manifest.segments.slice(0, -1), updatedActive],
	};
	await saveManifest(dir, next);
	return { event: stored, manifest: next, rotated };
}

/** Recent events for prompt context; reads only the tail, never scores. */
export async function readRecentEvents(
	dir: string,
	count: number,
	tailBytes: number = 256 * 1024,
): Promise<LearningEvent[]> {
	const { manifest } = await ensureEventLog(dir, "light");
	const collected: LearningEvent[] = [];
	for (let i = manifest.segments.length - 1; i >= 0 && collected.length < count; i--) {
		const segment = manifest.segments[i];
		if (segment.count === 0) continue;
		const path = segmentPath(dir, segment);
		const events = await readJsonlTailAsync<LearningEvent>(path, tailBytes);
		collected.unshift(...events);
	}
	return collected.slice(-count);
}

/**
 * Read the ledger without repairing or writing anything.
 *
 * Used by a process that does not own the writer lock: it must still be able to
 * serve reads, but it must not migrate, rotate or touch the manifest.
 */
export async function readEventsWithoutRepair(
	dir: string,
	options?: { fromSeq?: number },
): Promise<{ events: StoredEvent[]; complete: boolean }> {
	const fromSeq = options?.fromSeq ?? 1;
	let manifest: EventManifest | undefined;
	try {
		manifest = await readManifest(dir);
	} catch {
		manifest = undefined;
	}

	const events: StoredEvent[] = [];
	if (manifest) {
		for (const segment of manifest.segments) {
			if (segment.count === 0 || segment.seq_end < fromSeq) continue;
			const read = await readTextStrict(segmentPath(dir, segment));
			if (!read.found) return { events, complete: false };
			let parsed: { records: LearningEvent[] };
			try {
				parsed = parseSegment<LearningEvent>(read.text, segment.file);
			} catch {
				return { events, complete: false };
			}
			for (let i = 0; i < parsed.records.length; i++) {
				const seq = segment.base_seq + i;
				if (seq >= fromSeq) events.push({ ...parsed.records[i], seq });
			}
		}
		return { events, complete: true };
	}

	// No manifest yet: read the pre-segmentation layout in chronological order.
	const files = await listDirectory(dir);
	const legacy = files.filter((name) => LEGACY_ARCHIVE_PATTERN.test(name)).sort();
	const ordered = [...legacy, ...(files.includes(EVENTS_FILE) ? [EVENTS_FILE] : [])];
	let seq = 0;
	for (const name of ordered) {
		const read = await readTextStrict(join(dir, name));
		if (!read.found) continue;
		let parsed: { records: LearningEvent[] };
		try {
			parsed = parseSegment<LearningEvent>(read.text, name, { allowTornTail: name === EVENTS_FILE });
		} catch {
			return { events, complete: false };
		}
		for (const record of parsed.records) {
			seq += 1;
			if (seq >= fromSeq) events.push({ ...record, seq });
		}
	}
	return { events, complete: true };
}

/** Slice of the active segment for per-turn prompt context, read-only. */
export async function readRecentEventsWithoutRepair(
	dir: string,
	count: number,
	tailBytes: number = 256 * 1024,
): Promise<LearningEvent[]> {
	return (await readJsonlTailAsync<LearningEvent>(join(dir, EVENTS_FILE), tailBytes)).slice(-count);
}
