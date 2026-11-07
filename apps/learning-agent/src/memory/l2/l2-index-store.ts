/**
 * L2 wiki retrieval index, backed by node:sqlite.
 *
 * A SEPARATE database from L3 (`index.db` here vs L3's `memory.db`): L2 indexes
 * durable wiki *pages* (knowledge), L3 indexes past *conversations* — different
 * corpora, kept isolated. This store provides lexical (FTS5/BM25) retrieval
 * over pages (see l2-search.ts).
 *
 * Reuses {@link segmentForFts} from the L3 store so index/query CJK bigram
 * tokenization stays identical across both layers. Degrades to null on
 * Node < 22.5 (where node:sqlite is unavailable) exactly like the L3 store, so
 * callers must treat a null store as "L2 index disabled" and fall back.
 */

import { logger } from "../../logger.js";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { segmentForFts } from "../l3/sqlite-store.js";

/** One indexed wiki page (the document unit for retrieval — whole page). */
export interface L2PageDoc {
	/** Wiki-relative path, e.g. `wiki/entities/foo.md`. Primary key. */
	path: string;
	title: string;
	/** WikiPageType as a string (source-summary | entity | concept | query | comparison | synthesis | analysis). */
	type: string;
	tags: string[];
	sourceIds: string[];
	body: string;
	/** sha256[:16] of the raw page file — detects staleness for incremental reindex. */
	contentHash: string;
	mtimeMs: number;
}

/** Page metadata as read back from the index (no body-less variant needed at our scale). */
export interface L2PageMeta {
	path: string;
	title: string;
	type: string;
	tags: string[];
	sourceIds: string[];
	body: string;
}

/** A lexical search hit. `bm25` is the raw FTS5 score (lower = more relevant). */
export interface L2LexHit {
	path: string;
	title: string;
	type: string;
	tags: string[];
	sourceIds: string[];
	bm25: number;
}

// node:sqlite has no stable public type export across Node versions; we keep
// the surface we use minimal and locally typed (mirrors l3/sqlite-store.ts).
interface SqliteStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

/**
 * Turn a user query into an FTS5 MATCH expression. Tokens are OR-combined so
 * partial overlaps still recall; each token is quoted to avoid FTS operator
 * injection from raw user text. (Copied from the L3 store, which keeps it
 * private.)
 */
function buildMatchExpression(query: string): string {
	const tokens = segmentForFts(query)
		.split(" ")
		.filter((t) => t.length > 0)
		.map((t) => `"${t.replace(/"/g, '""')}"`);
	return tokens.join(" OR ");
}

function parseJsonArray(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
	} catch {
		return [];
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
	path TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	type TEXT NOT NULL,
	tags TEXT NOT NULL,        -- JSON array
	source_ids TEXT NOT NULL,  -- JSON array
	body TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	mtime_ms INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- E4.2a: one row per (page, source). The FTS query joins this table so a
-- course scope is applied BEFORE bm25 ordering and LIMIT. Without it, a global
-- top-N could contain only other courses' pages and starve the scoped query.
-- A page must have at least one source and every source must be in scope; a
-- mixed page (several sources, only some allowed) is excluded rather than
-- leaking the disallowed part.
CREATE TABLE IF NOT EXISTS page_sources (
	page_path TEXT NOT NULL,
	source_id TEXT NOT NULL,
	PRIMARY KEY (page_path, source_id)
);
CREATE INDEX IF NOT EXISTS idx_page_sources_source ON page_sources(source_id);

-- Regular (non-contentless) FTS5 table: rowid mirrors pages.rowid for joins.
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
	tokens,
	tokenize='unicode61'
);

-- Tracks how far each page file has been indexed (incremental skip).
CREATE TABLE IF NOT EXISTS index_state (
	path TEXT PRIMARY KEY,
	content_hash TEXT NOT NULL,
	mtime_ms INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

export interface L2SourceScope {
	/**
	 * `undefined` = legacy global scope (unclassified session). `[]` = a course
	 * with no material and therefore no hits. A non-empty set is authoritative:
	 * only pages whose every source is in it may be returned.
	 */
	sourceIds?: readonly string[];
}

/**
 * The L2 index store. Construct via {@link openL2IndexStore}, which returns
 * null when node:sqlite is unavailable so callers can degrade gracefully.
 */
export class L2IndexStore {
	private db: SqliteDatabase;

	private constructor(db: SqliteDatabase) {
		this.db = db;
		this.db.exec(SCHEMA);
		this.backfillPageSources();
	}

	static async open(l2DataDir: string): Promise<L2IndexStore | null> {
		let DatabaseSync: (new (path: string) => SqliteDatabase) | undefined;
		try {
			const mod = (await import("node:sqlite")) as unknown as {
				DatabaseSync: new (path: string) => SqliteDatabase;
			};
			DatabaseSync = mod.DatabaseSync;
		} catch (err) {
			logger.warn({ err }, "[L2] node:sqlite not available on this runtime");
			return null;
		}
		if (!DatabaseSync) return null;
		try {
			await mkdir(l2DataDir, { recursive: true });
			const db = new DatabaseSync(join(l2DataDir, "index.db"));
			db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
			return new L2IndexStore(db);
		} catch (err) {
			logger.warn({ err }, `[L2] failed to open sqlite index: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** Insert or replace a page and its FTS row. */
	upsertPage(doc: L2PageDoc): void {
		const existing = this.db
			.prepare("SELECT rowid FROM pages WHERE path = ?")
			.get(doc.path) as { rowid?: number } | undefined;

		const tokens = segmentForFts([doc.title, doc.tags.join(" "), doc.body].join(" "));
		const tagsJson = JSON.stringify(doc.tags);
		const idsJson = JSON.stringify(doc.sourceIds);
		const now = Date.now();

		if (existing && typeof existing.rowid === "number") {
			this.db
				.prepare(
					"UPDATE pages SET title=?, type=?, tags=?, source_ids=?, body=?, content_hash=?, mtime_ms=?, updated_at=? WHERE path=?",
				)
				.run(doc.title, doc.type, tagsJson, idsJson, doc.body, doc.contentHash, doc.mtimeMs, now, doc.path);
			this.db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(existing.rowid);
			this.db.prepare("INSERT INTO pages_fts(rowid, tokens) VALUES (?, ?)").run(existing.rowid, tokens);
			this.writePageSources(doc.path, doc.sourceIds);
			return;
		}

		const info = this.db
			.prepare(
				"INSERT INTO pages(path,title,type,tags,source_ids,body,content_hash,mtime_ms,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
			)
			.run(doc.path, doc.title, doc.type, tagsJson, idsJson, doc.body, doc.contentHash, doc.mtimeMs, now);
		const rowid = Number(info.lastInsertRowid);
		this.db.prepare("INSERT INTO pages_fts(rowid, tokens) VALUES (?, ?)").run(rowid, tokens);
		this.writePageSources(doc.path, doc.sourceIds);
	}

	/** Insert many pages inside a single transaction. */
	upsertPages(docs: L2PageDoc[]): void {
		if (docs.length === 0) return;
		this.db.exec("BEGIN");
		try {
			for (const d of docs) this.upsertPage(d);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Remove a page, its FTS row, and index state. */
	deletePage(path: string): void {
		const row = this.db.prepare("SELECT rowid FROM pages WHERE path = ?").get(path) as
			| { rowid?: number }
			| undefined;
		this.db.exec("BEGIN");
		try {
			if (row && typeof row.rowid === "number") {
				this.db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(row.rowid);
			}
			this.db.prepare("DELETE FROM pages WHERE path = ?").run(path);
			this.db.prepare("DELETE FROM page_sources WHERE page_path = ?").run(path);
			this.db.prepare("DELETE FROM index_state WHERE path = ?").run(path);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * Lexical search over indexed pages, ordered by bm25 (most relevant first).
	 *
	 * E4.2a: the course scope is part of the SQL WHERE clause, so bm25, ORDER BY
	 * and LIMIT all operate on the allowed candidate set. A global top-N that
	 * happens to be other courses can no longer hide the course's own material.
	 */
	searchLexical(query: string, limit = 30, scope: L2SourceScope = {}): L2LexHit[] {
		const match = buildMatchExpression(query);
		if (!match) return [];
		const allowed = scope.sourceIds;
		if (allowed && allowed.length === 0) return [];
		try {
			const predicate = allowed ? this.scopePredicate("p", allowed) : null;
			const rows = this.db
				.prepare(
					`SELECT p.path AS path, p.title AS title, p.type AS type, p.tags AS tags,
					        p.source_ids AS source_ids, bm25(pages_fts) AS bm25
					 FROM pages_fts
					 JOIN pages p ON p.rowid = pages_fts.rowid
					 WHERE pages_fts MATCH ?
					 ${predicate ? `AND ${predicate.sql}` : ""}
					 ORDER BY bm25
					 LIMIT ?`,
				)
				.all(match, ...(predicate?.params ?? []), limit);
			return rows.map((r) => ({
				path: String(r.path),
				title: String(r.title),
				type: String(r.type),
				tags: parseJsonArray(r.tags),
				sourceIds: parseJsonArray(r.source_ids),
				bm25: Number(r.bm25),
			}));
		} catch (err) {
			logger.warn({ err }, `[L2] lexical search failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	/**
	 * Pages available to a course scope, including bodies, for query-time graph
	 * expansion. `undefined` keeps the legacy global set; `[]` is empty.
	 */
	getPages(scope: L2SourceScope = {}): L2PageMeta[] {
		const allowed = scope.sourceIds;
		if (allowed && allowed.length === 0) return [];
		const predicate = allowed ? this.scopePredicate("p", allowed) : null;
		const rows = this.db
			.prepare(`SELECT p.path, p.title, p.type, p.tags, p.source_ids, p.body FROM pages p${
				predicate ? ` WHERE ${predicate.sql}` : ""
			}`)
			.all(...(predicate?.params ?? []));
		return rows.map((r) => ({
			path: String(r.path),
			title: String(r.title),
			type: String(r.type),
			tags: parseJsonArray(r.tags),
			sourceIds: parseJsonArray(r.source_ids),
			body: String(r.body),
		}));
	}

	/** All page metadata (incl. body) — used to build the query-time link graph. */
	getAllPages(): L2PageMeta[] {
		const rows = this.db
			.prepare("SELECT path, title, type, tags, source_ids, body FROM pages")
			.all();
		return rows.map((r) => ({
			path: String(r.path),
			title: String(r.title),
			type: String(r.type),
			tags: parseJsonArray(r.tags),
			sourceIds: parseJsonArray(r.source_ids),
			body: String(r.body),
		}));
	}

	getIndexState(path: string): { contentHash: string; mtimeMs: number } | null {
		const row = this.db
			.prepare("SELECT content_hash, mtime_ms FROM index_state WHERE path = ?")
			.get(path) as { content_hash?: string; mtime_ms?: number } | undefined;
		if (!row) return null;
		return { contentHash: String(row.content_hash ?? ""), mtimeMs: Number(row.mtime_ms ?? 0) };
	}

	setIndexState(path: string, contentHash: string, mtimeMs: number): void {
		this.db
			.prepare(
				`INSERT INTO index_state(path, content_hash, mtime_ms, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
				   content_hash = excluded.content_hash, mtime_ms = excluded.mtime_ms, updated_at = excluded.updated_at`,
			)
			.run(path, contentHash, mtimeMs, Date.now());
	}

	listIndexedPaths(): string[] {
		const rows = this.db.prepare("SELECT path FROM pages").all();
		return rows.map((r) => String(r.path));
	}

	pageCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n?: number } | undefined;
		return Number(row?.n ?? 0);
	}

	/**
	 * SQL predicate for a course scope.
	 *
	 * Requires at least one source row (a page with no provenance is never
	 * silently global) and forbids any source outside the allowed set. A mixed
	 * page is therefore excluded rather than returning text that belongs to
	 * another course.
	 */
	private scopePredicate(alias: string, allowed: readonly string[]): { sql: string; params: unknown[] } {
		const placeholders = allowed.map(() => "?").join(",");
		return {
			sql: `EXISTS (SELECT 1 FROM page_sources ps_any WHERE ps_any.page_path = ${alias}.path)
				AND NOT EXISTS (
					SELECT 1 FROM page_sources ps_out
					WHERE ps_out.page_path = ${alias}.path AND ps_out.source_id NOT IN (${placeholders})
				)`,
			params: [...allowed],
		};
	}

	private writePageSources(pagePath: string, sourceIds: readonly string[]): void {
		this.db.prepare("DELETE FROM page_sources WHERE page_path = ?").run(pagePath);
		const insert = this.db.prepare("INSERT OR IGNORE INTO page_sources(page_path, source_id) VALUES (?, ?)");
		for (const sourceId of new Set(sourceIds)) insert.run(pagePath, sourceId);
	}

	/**
	 * Populate `page_sources` for an index created before E4.2a. Runs once: a
	 * non-empty table means every row was written by {@link upsertPage}.
	 */
	private backfillPageSources(): void {
		try {
			const count = this.db.prepare("SELECT COUNT(*) AS n FROM page_sources").get() as { n?: number } | undefined;
			if (Number(count?.n ?? 0) > 0) return;
			const rows = this.db.prepare("SELECT path, source_ids FROM pages").all();
			if (rows.length === 0) return;
			this.db.exec("BEGIN");
			try {
				const insert = this.db.prepare("INSERT OR IGNORE INTO page_sources(page_path, source_id) VALUES (?, ?)");
				for (const row of rows) {
					for (const sourceId of new Set(parseJsonArray(row.source_ids))) {
						insert.run(String(row.path), sourceId);
					}
				}
				this.db.exec("COMMIT");
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw err;
			}
		} catch (err) {
			// Backfill failure must not prevent opening the index: queries will
			// simply see no scoped candidates until the next successful upsert.
			logger.warn({ err }, "[L2] page_sources backfill failed");
		}
	}

	close(): void {
		try {
			this.db.close();
		} catch (err) {
			logger.warn({ err }, "[L2] failed to close sqlite index (may already be closed)");
		}
	}
}

/**
 * Open the L2 index store, returning null when node:sqlite is unavailable so
 * callers can disable index-backed retrieval without failing the agent.
 */
export function openL2IndexStore(l2DataDir: string): Promise<L2IndexStore | null> {
	return L2IndexStore.open(l2DataDir);
}
