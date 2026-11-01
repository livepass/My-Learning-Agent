import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, appendFileSync, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { logger } from "../logger.js";

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
	mkdirSync(dirPath, { recursive: true });
}

/**
 * Read and parse a JSON file. Returns defaultValue if file does not exist.
 */
export function readJson<T>(filePath: string, defaultValue: T): T {
	if (!existsSync(filePath)) {
		return defaultValue;
	}
	const raw = readFileSync(filePath, "utf-8");
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		logger.warn({ err }, `failed to parse JSON ${filePath}`);
		return defaultValue;
	}
}

/**
 * Write a JSON file atomically (write to .tmp then rename).
 *
 * `options.mode` (e.g. 0o600 for files containing secrets) is applied to the
 * final file — including pre-existing files left over from before the option
 * was introduced, whose permissions are corrected in place.
 */
export function writeJson<T>(filePath: string, data: T, options?: { mode?: number }): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", ...(options?.mode !== undefined ? { mode: options.mode } : {}) });
	renameSync(tmp, filePath);
	if (options?.mode !== undefined) {
		// rename only helps if the tmp file got the right mode at creation;
		// chmod unconditionally so old 0644 files are fixed on next write too.
		try {
			chmodSync(filePath, options.mode);
		} catch (err) {
			logger.warn({ err, filePath }, "failed to chmod file");
		}
	}
}

/**
 * Write records as a JSONL file (one JSON line each), atomically
 * (tmp + rename). Used to compact live-state logs such as dedupe.jsonl,
 * where rotation is unsafe (it would drop still-live entries).
 */
export function writeJsonl<T>(filePath: string, records: T[]): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""), "utf-8");
	renameSync(tmp, filePath);
}

/**
 * Append a single JSON record as a line to a JSONL file.
 *
 * When `options.maxBytes` is set and the file already exceeds that size, the
 * current file is first rolled to a `<path>.<timestamp>.archive` sibling and a
 * fresh file is started. Append-only logs (runs, events, channel run-log) use
 * this to bound unbounded growth; live-state logs (e.g. dedupe) must NOT, since
 * rotation silently drops entries that are still meaningful.
 */
export function appendJsonl<T>(filePath: string, record: T, options?: { maxBytes?: number }): void {
	ensureDir(dirname(filePath));
	if (options?.maxBytes && existsSync(filePath)) {
		try {
			if (statSync(filePath).size >= options.maxBytes) {
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				renameSync(filePath, `${filePath}.${stamp}.archive`);
			}
		} catch (err) {
			// Rotation is best-effort: failing to archive must never drop the record.
			logger.warn({ err }, `failed to rotate JSONL ${filePath}`);
		}
	}
	appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

function parseJsonlLines<T>(raw: string): T[] {
	const records: T[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as T);
		} catch (err) {
			logger.warn("skipping malformed JSONL line");
		}
	}
	return records;
}

/**
 * Read all records from a JSONL file. Returns empty array if file does not exist.
 */
export function readJsonl<T>(filePath: string): T[] {
	if (!existsSync(filePath)) {
		return [];
	}
	return parseJsonlLines(readFileSync(filePath, "utf-8"));
}

/**
 * Read only the last `maxBytes` of a JSONL file. The first line of the window
 * may be truncated mid-record and is dropped. Use for append-only logs whose
 * consumers only need recent history.
 */
export function readJsonlTail<T>(filePath: string, maxBytes: number): T[] {
	if (!existsSync(filePath)) {
		return [];
	}
	const size = statSync(filePath).size;
	if (size <= maxBytes) {
		return parseJsonlLines(readFileSync(filePath, "utf-8"));
	}
	const start = size - maxBytes;
	const fd = openSync(filePath, "r");
	let raw: string;
	try {
		const buf = Buffer.alloc(maxBytes);
		readSync(fd, buf, 0, maxBytes, start);
		raw = buf.toString("utf-8");
	} finally {
		closeSync(fd);
	}
	const lines = raw.split("\n");
	lines.shift(); // drop the possibly-partial first line of the window
	return parseJsonlLines(lines.join("\n"));
}

/** Async variant of `readJsonlTail` for request paths. */
export async function readJsonlTailAsync<T>(filePath: string, maxBytes: number): Promise<T[]> {
	let info: Stats | undefined;
	try {
		info = await stat(filePath);
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return [];
		throw new FileStoreError("FILE_UNREADABLE", filePath, "存储文件读取失败", errnoCode(err));
	}
	if (info.size <= maxBytes) {
		return parseJsonlLines(await readFile(filePath, "utf-8"));
	}
	const handle = await open(filePath, "r");
	try {
		const start = info.size - maxBytes;
		const buffer = Buffer.alloc(maxBytes);
		await handle.read(buffer, 0, maxBytes, start);
		const lines = buffer.toString("utf-8").split("\n");
		lines.shift(); // drop the possibly-partial first line of the window
		return parseJsonlLines(lines.join("\n"));
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Write a text file atomically (write to .tmp then rename).
 */
export function writeText(filePath: string, content: string): void {
	ensureDir(dirname(filePath));
	const tmp = filePath + ".tmp";
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, filePath);
}

/**
 * Read a text file. Returns defaultValue if file does not exist.
 */
export function readText(filePath: string, defaultValue: string = ""): string {
	if (!existsSync(filePath)) return defaultValue;
	return readFileSync(filePath, "utf-8");
}

/** Request paths must not block the event loop while reading persisted data. */
export async function readTextAsync(filePath: string, defaultValue = ""): Promise<string> {
	try {
		return await readFile(filePath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultValue;
		throw err;
	}
}

export async function readJsonAsync<T>(filePath: string, defaultValue: T): Promise<T> {
	const raw = await readTextAsync(filePath);
	if (!raw) return defaultValue;
	try {
		return JSON.parse(raw) as T;
	} catch {
		logger.warn("failed to parse JSON file");
		return defaultValue;
	}
}

export async function readJsonlAsync<T>(filePath: string): Promise<T[]> {
	return parseJsonlLines(await readTextAsync(filePath));
}

/**
 * Append text to a file.
 */
export function appendText(filePath: string, content: string): void {
	ensureDir(dirname(filePath));
	appendFileSync(filePath, content, "utf-8");
}

/**
 * Check if a file exists.
 */
export function fileExists(filePath: string): boolean {
	return existsSync(filePath);
}

// ============================================================================
// Strict + durable async primitives
//
// The functions above keep the historical "best effort" contract: a missing or
// unreadable file silently falls back to a default value. That contract is
// unsafe for state that cannot be regenerated (learner profile, event ledger),
// because the caller cannot tell "no data yet" from "data was lost" and would
// happily overwrite the survivor with an empty object.
//
// The helpers below never guess: they distinguish missing / corrupt / IO error,
// and they fsync both the file and its directory so an acknowledged write
// survives process exit and host power loss.
// ============================================================================

export type FileStoreErrorCode = "FILE_CORRUPT" | "FILE_UNREADABLE" | "FILE_IO";

/**
 * Storage failure that callers may surface as a public error code.
 * `filePath` is for the log only; `message` never contains user content.
 */
export class FileStoreError extends Error {
	readonly code: FileStoreErrorCode;
	readonly filePath: string;
	readonly detail?: string;

	constructor(code: FileStoreErrorCode, filePath: string, message: string, detail?: string) {
		super(message);
		this.name = "FileStoreError";
		this.code = code;
		this.filePath = filePath;
		this.detail = detail;
	}
}

function errnoCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | undefined)?.code;
}

export type JsonStrictRead<T> = { found: false } | { found: true; value: T };

/** Read + parse JSON without substituting a default on corruption. */
export async function readJsonStrict<T>(filePath: string): Promise<JsonStrictRead<T>> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return { found: false };
		throw new FileStoreError("FILE_UNREADABLE", filePath, "存储文件读取失败", errnoCode(err));
	}
	try {
		return { found: true, value: JSON.parse(raw) as T };
	} catch {
		throw new FileStoreError("FILE_CORRUPT", filePath, "存储文件不是合法 JSON");
	}
}

export type JsonlStrictRead<T> = {
	records: T[];
	/** Bytes after the last newline of an unsealed log; excluded from `records`. */
	tornTail?: string;
};

/**
 * Parse JSONL text without skipping malformed lines.
 *
 * `allowTornTail` is only valid for the *active* append-only segment: a record
 * is committed by the trailing newline, so a final line without one is proof
 * that the append never completed. Any other malformed line means the data is
 * corrupt and the caller must stop instead of scoring a partial ledger.
 */
export function parseJsonlStrict<T>(
	raw: string,
	filePath: string,
	options?: { allowTornTail?: boolean },
): JsonlStrictRead<T> {
	if (raw.length === 0) return { records: [] };

	const lines = raw.split("\n");
	let tornTail: string | undefined;
	if (!raw.endsWith("\n")) {
		tornTail = lines.pop();
		if (!options?.allowTornTail) {
			throw new FileStoreError("FILE_CORRUPT", filePath, "日志文件结尾存在未提交记录");
		}
		if (!tornTail) tornTail = undefined;
	}
	// A trailing newline leaves one empty element; drop it. Any other empty
	// line is a gap in the ledger, not a formatting detail.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const records: T[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			throw new FileStoreError("FILE_CORRUPT", filePath, "日志文件存在空行", `line ${i + 1}`);
		}
		try {
			records.push(JSON.parse(line) as T);
		} catch {
			throw new FileStoreError("FILE_CORRUPT", filePath, "日志文件存在无法解析的记录", `line ${i + 1}`);
		}
	}
	return tornTail ? { records, tornTail } : { records };
}

/** Read a JSONL file in strict mode. */
export async function readJsonlStrict<T>(
	filePath: string,
	options?: { allowTornTail?: boolean },
): Promise<JsonlStrictRead<T>> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return { records: [] };
		throw new FileStoreError("FILE_UNREADABLE", filePath, "存储文件读取失败", errnoCode(err));
	}
	return parseJsonlStrict<T>(raw, filePath, options);
}

/** fsync a directory so a rename is durable. Unsupported on some platforms. */
async function syncDirectory(dirPath: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(dirPath, "r");
		await handle.sync();
	} catch (err) {
		// Windows and some macOS filesystems reject directory handles. The file
		// itself was already fsynced; losing only the directory entry ordering
		// is the best this platform can promise.
		logger.debug({ err, dirPath }, "directory fsync unsupported");
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Atomically write a file with a unique temp name, fsync it, then rename. */
export async function writeFileDurable(
	filePath: string,
	content: string,
	options?: { mode?: number },
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	// A per-process/random temp name keeps two contenders from clobbering the
	// same scratch file even when they were supposed to be serialized.
	const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(tmp, "wx", options?.mode ?? 0o644);
		await handle.writeFile(content, "utf-8");
		await handle.sync();
	} catch (err) {
		await handle?.close().catch(() => undefined);
		await unlink(tmp).catch(() => undefined);
		throw new FileStoreError("FILE_IO", filePath, "存储文件写入失败", errnoCode(err));
	}
	await handle.close();
	try {
		await rename(tmp, filePath);
	} catch (err) {
		await unlink(tmp).catch(() => undefined);
		throw new FileStoreError("FILE_IO", filePath, "存储文件替换失败", errnoCode(err));
	}
	if (options?.mode !== undefined) {
		await chmod(filePath, options.mode).catch((err) => logger.warn({ err, filePath }, "failed to chmod file"));
	}
	await syncDirectory(dirname(filePath));
}

/** Atomically write JSON (2-space indent, trailing newline). */
export async function writeJsonDurable<T>(filePath: string, data: T, options?: { mode?: number }): Promise<void> {
	await writeFileDurable(filePath, JSON.stringify(data, null, 2) + "\n", options);
}

/** Atomically write whole JSONL content. */
export async function writeJsonlDurable<T>(filePath: string, records: T[]): Promise<void> {
	const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
	await writeFileDurable(filePath, body);
}

/** Append one JSONL record and fsync it before returning. */
export async function appendJsonlDurable<T>(filePath: string, record: T): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(filePath, "a", 0o644);
		await handle.appendFile(JSON.stringify(record) + "\n", "utf-8");
		await handle.sync();
	} catch (err) {
		throw new FileStoreError("FILE_IO", filePath, "日志追加失败", errnoCode(err));
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Create a file only if it does not exist (atomic across processes). */
export async function createFileExclusive(filePath: string, content: string): Promise<boolean> {
	await mkdir(dirname(filePath), { recursive: true });
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(filePath, "wx", 0o600);
		await handle.writeFile(content, "utf-8");
		await handle.sync();
		return true;
	} catch (err) {
		if (errnoCode(err) === "EEXIST") return false;
		throw new FileStoreError("FILE_IO", filePath, "独占创建文件失败", errnoCode(err));
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function readTextStrict(filePath: string): Promise<{ found: false } | { found: true; text: string }> {
	try {
		return { found: true, text: await readFile(filePath, "utf-8") };
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return { found: false };
		throw new FileStoreError("FILE_UNREADABLE", filePath, "存储文件读取失败", errnoCode(err));
	}
}

/** Directory listing without throwing on a missing directory. */
export async function listDirectory(dirPath: string): Promise<string[]> {
	try {
		return (await readdir(dirPath)).sort();
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return [];
		throw new FileStoreError("FILE_UNREADABLE", dirPath, "目录读取失败", errnoCode(err));
	}
}

export async function statFile(filePath: string): Promise<Stats | undefined> {
	try {
		return await stat(filePath);
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return undefined;
		throw new FileStoreError("FILE_UNREADABLE", filePath, "文件状态读取失败", errnoCode(err));
	}
}

export async function renameFile(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (err) {
		throw new FileStoreError("FILE_IO", to, "存储文件改名失败", errnoCode(err));
	}
}

export async function removeFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return;
		throw new FileStoreError("FILE_IO", filePath, "存储文件删除失败", errnoCode(err));
	}
}

export function sha256Hex(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}
