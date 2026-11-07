/**
 * L3 cross-conversation memory integration.
 *
 * Owns the lazily-opened L3 store and exposes:
 * - {@link createL3Tools}: an `l3_recall` tool the agent can call to search
 *   past conversations on demand.
 * - {@link recallForInjection}: threshold-gated retrieval used by the
 *   before_agent_start hook to auto-inject relevant history.
 * - {@link indexCurrentSession} / {@link backfillIndex}: keep the index fresh.
 *
 * Everything degrades to a no-op when node:sqlite is unavailable so the agent
 * keeps working on older runtimes.
 */

import { logger } from "../../logger.js";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openL3Store, type L3SearchHit, type L3Store } from "./sqlite-store.js";
import { indexAllSessions, indexSession } from "./indexer.js";
import { recall, formatRecallForPrompt, type RecallResult } from "./recall.js";
import {
	recallOptionsForScope,
	RECALL_SCOPE_UNAVAILABLE_TEXT,
	type RecallScope,
} from "./recall-scope.js";
import { resolveContainedPathAsync } from "../../utils/path-safety.js";

/**
 * Holds the singleton store for a runtime. The store opens lazily on first use
 * so startup cost is only paid when L3 is actually exercised.
 */
export class L3Memory {
	private store: L3Store | null = null;
	private opening: Promise<L3Store | null> | null = null;
	private indexQueue: Promise<unknown> = Promise.resolve();
	private backfilled = false;
	private backfillPromise: Promise<void> | null = null;

	constructor(
		private readonly l3DataDir: string,
		private readonly sessionDir: string,
	) {}

	private async ensureStore(): Promise<L3Store | null> {
		// Concurrent searches must await the same open, rather than observe a temporary null.
		this.opening ??= openL3Store(this.l3DataDir).then((store) => {
			this.store = store;
			if (!store) logger.warn("[L3] node:sqlite unavailable; index-backed retrieval disabled.");
			return store;
		});
		return this.opening;
	}

	private enqueueIndex<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.indexQueue.then(operation);
		this.indexQueue = result.catch(() => {});
		return result;
	}

	/** One-time backfill of all existing sessions (cheap: skips unchanged files). */
	async backfill(): Promise<void> {
		if (this.backfilled) return;
		if (this.backfillPromise) return this.backfillPromise;
		const run = (async () => {
			const store = await this.ensureStore();
			if (!store) return;
			try {
				const { sessions, chunks } = await this.enqueueIndex(() => indexAllSessions(store, this.sessionDir));
				this.backfilled = true;
				if (sessions > 0) logger.info(`[L3] indexed ${chunks} chunks from ${sessions} session(s).`);
			} catch (err) {
				logger.warn({ err }, `[L3] backfill failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		this.backfillPromise = run;
		try {
			await run;
		} finally {
			if (this.backfillPromise === run) this.backfillPromise = null;
		}
	}

	/** Full-text UI search over the visible user/assistant conversation branch. */
	async searchLexical(query: string, limit = 40): Promise<L3SearchHit[] | null> {
		await this.backfill();
		const store = await this.ensureStore();
		return store ? store.searchLexical(query, limit, 1) : null;
	}

	/** Incrementally (re)index a single session file by id. */
	async indexById(sessionId: string): Promise<void> {
		if (!sessionId) return;
		const store = await this.ensureStore();
		if (!store) return;
		try {
			const path = await resolveContainedPathAsync(this.sessionDir, sessionId);
			if (path) await this.enqueueIndex(() => indexSession(store, path));
		} catch (err) {
			logger.warn({ err }, `[L3] index ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Threshold-gated recall for prompt injection. */
	async recall(
		query: string,
		excludeSessionId?: string,
		options: { allowedSessionIds?: ReadonlySet<string> } = {},
	): Promise<RecallResult[]> {
		const store = await this.ensureStore();
		if (!store) return [];
		return recall(store, query, { excludeSessionId, ...options });
	}

	/**
	 * Recall with an explicit outcome, so the caller can tell the three cases
	 * apart instead of showing the same "nothing found" for all of them:
	 *
	 * - `unavailable` — node:sqlite missing or the index failed to open;
	 * - `empty_index` — the store works but has indexed nothing yet;
	 * - `ok` with zero results — the index has history, just nothing relevant.
	 */
	async recallWithStatus(
		query: string,
		excludeSessionId?: string,
		options: { allowedSessionIds?: ReadonlySet<string> } = {},
	): Promise<{
		status: "ok" | "empty_index" | "unavailable";
		results: RecallResult[];
	}> {
		await this.backfill();
		const store = await this.ensureStore();
		if (!store) return { status: "unavailable", results: [] };
		try {
			const chunks = store.chunkCount();
			const results = recall(store, query, { excludeSessionId, ...options });
			return { status: chunks === 0 ? "empty_index" : "ok", results };
		} catch (err) {
			logger.warn({ err }, "[L3] recall failed");
			return { status: "unavailable", results: [] };
		}
	}

	/**
	 * Close the store and reset the lazy-init flags so the holder can be
	 * reused. Mainly needed by tests: on Windows an open sqlite handle keeps
	 * memory.db locked and temp-dir cleanup fails with EBUSY.
	 */
	close(): void {
		this.store?.close();
		this.store = null;
		this.opening = null;
		this.indexQueue = Promise.resolve();
		this.backfilled = false;
		this.backfillPromise = null;
	}
}

/**
 * Register the `l3_recall` tool. The agent calls this to deliberately search
 * its memory of past conversations (separate from the automatic injection).
 */
export function createL3Tools(
	memory: L3Memory,
	getCurrentSessionId?: () => string,
	isEnabled?: () => boolean,
	/**
	 * E4.4b: resolve the course's allowed session set for the active session.
	 *
	 * Asynchronous on purpose: the authoritative answer lives in the course
	 * store, and pretending it is synchronous would mean caching "the current
	 * course" in a global that another turn could overwrite. The callback is
	 * server-side only — a tool parameter can never widen the scope.
	 */
	resolveRecallScope?: (currentSessionId: string | undefined) => Promise<RecallScope>,
): ToolDefinition[] {
	const recallTool = defineTool({
		name: "l3_recall",
		label: "回忆历史对话",
		description:
			"在过往会话记录（L3）中按语义/关键词检索，召回与当前问题相关的历史对话片段。" +
			"当用户提到「上次」「之前聊过」「我们讨论过」「你还记得吗」等指向过去对话的线索，" +
			"或你需要跨对话的上下文来连续地帮助用户时调用。结果带相关度，仅返回足够相关的片段。",
		parameters: Type.Object({
			query: Type.String({
				description: "检索关键词或问题，如「上次说的学习计划」「之前的 Python 报错」。",
			}),
			limit: Type.Optional(
				Type.Number({ description: "最多返回片段数，默认 4。", default: 4 }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isEnabled && !isEnabled()) {
				return {
					content: [{ type: "text" as const, text: "跨对话历史检索（L3）已在设置中关闭，当前仅使用本工作区与当前对话上下文。" }],
					details: { results: 0, disabled: true },
				};
			}
			const query = String((params as { query?: string }).query ?? "").trim();
			const limit = Number((params as { limit?: number }).limit ?? 4);
			if (!query) {
				return {
					content: [{ type: "text" as const, text: "请提供检索关键词或问题。" }],
					details: { results: 0 },
				};
			}
			// Resolve current session id from ctx (preferred) or the provided getter.
			let current = "";
			try {
				const sid = ctx.sessionManager.getSessionFile?.();
				if (sid) current = sid.split(/[\\/]/).pop() ?? "";
			} catch (err) {
				logger.warn({ err }, "failed to get session id from getter");
				// ignore
			}
			if (!current && getCurrentSessionId) {
				try {
					current = getCurrentSessionId();
				} catch (err) {
					logger.warn({ err }, "failed to get current session id from getter");
					// ignore
				}
			}

			const scope = resolveRecallScope
				? await resolveRecallScope(current || undefined)
				: ({ status: "unclassified" } as RecallScope);
			if (scope.status === "unavailable") {
				// Fail closed: an unknown scope must not become "search everything".
				return {
					content: [{ type: "text" as const, text: RECALL_SCOPE_UNAVAILABLE_TEXT }],
					details: { results: 0, scope: "unavailable", reason: scope.reason },
				};
			}
			const found = await memory.recallWithStatus(
				query,
				current || undefined,
				recallOptionsForScope(scope),
			);
			const results = found.results.slice(0, Math.max(1, limit));
			const scopeLabel = scope.status === "course" ? "course" : "legacy_global";
			if (results.length === 0) {
				const why = found.status === "unavailable"
					? "历史对话索引暂不可用，本次没有检索到内容。"
					: found.status === "empty_index"
						? "历史对话索引尚未建立，暂时没有可检索的历史。"
						: `未在${scope.status === "course" ? "本课程" : ""}历史对话中找到与「${query}」足够相关的内容。`;
				return {
					content: [{ type: "text" as const, text: why }],
					details: { results: 0, scope: scopeLabel, index: found.status },
				};
			}
			const body = formatRecallForPrompt(results);
			return {
				content: [{ type: "text" as const, text: body }],
				details: { results: results.length, scope: scopeLabel, index: found.status },
			};
		},
	});

	return [recallTool];
}

export { formatRecallForPrompt } from "./recall.js";

const registry = new Map<string, L3Memory>();

/** Per-dir singleton so the extension and tests share ONE handle within a process. */
export function getL3Memory(l3DataDir: string, sessionDir: string): L3Memory {
	let mem = registry.get(l3DataDir);
	if (!mem) {
		mem = new L3Memory(l3DataDir, sessionDir);
		registry.set(l3DataDir, mem);
	}
	return mem;
}

/**
 * Close and drop the per-dir singleton. Tests must call this before deleting
 * their temp data dir, otherwise the open sqlite handle keeps memory.db locked
 * on Windows and cleanup fails with EBUSY.
 */
export function closeL3Memory(l3DataDir: string): void {
	const mem = registry.get(l3DataDir);
	if (!mem) return;
	mem.close();
	registry.delete(l3DataDir);
}
