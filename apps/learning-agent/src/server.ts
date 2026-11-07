import { resolveCapabilities, type EffectiveCapabilities } from "./shared/capabilities.js";
import { disabledRouteCapability } from "./server/capability-policy.js";
// Register source-map-support so that compiled JS stack traces and
// pino-caller call sites map back to the original TS source locations.
import "source-map-support/register.js";

import { createServer, type IncomingMessage as HttpReq, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { loadConfig, type InnoConfig } from "./config.js";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { applyProviderProxyBypass } from "./utils/proxy-bypass.js";
import { ensureDir, readJson, readText, statFile, writeJson } from "./storage/file-store.js";
import { initializeLearnerStore } from "./memory/learner/profile-store.js";
import {
	getCurrentSessionId,
	getSession,
	getActivePromptToken,
	initSession,
	syncConfig,
	refreshConfiguredProviders,
	switchModel,
	type QueueTaskOptions,
	setPromptEventObserver,
	setWorkspaceCwdResolver,
	createNewSession,
	switchSessionFile,
	deleteSessionFileInQueue,
	applyWorkspaceCwd,
} from "./agent/pi-runner.js";
import { SessionUnavailableError, sessionLifecycle } from "./agent/session-lifecycle.js";
import { completePromptOnce, abortPromptForTurnToken, currentModelIdentity, isCompletionModelReady, runSideChannelCompletion } from "./agent/pi-runner.js";
import { HttpError, json } from "./server/http-helpers.js";
import { runQueuedHttpOperation } from "./server/queued-operation.js";
import { serveStatic } from "./server/static-serve.js";
import { createRouteDispatcher, requiresAgent } from "./server/route-dispatch.js";
import { safeJoinReal } from "./server/file-helpers.js";
import { handleSettingsRoutes } from "./server/routes/settings.js";
import { handleSessionsRoutes } from "./server/routes/sessions.js";
import { handleLearnerRoutes } from "./server/routes/learner.js";
import { handleWikiRoutes } from "./server/routes/wiki.js";
import { handleChatRoutes } from "./server/routes/chat.js";
import { handleCommandsRoutes } from "./server/routes/commands.js";
import { handleCoursesRoutes } from "./server/routes/courses.js";
import { CourseStore } from "./courses/course-store.js";
import { parseSessionContent, type ParsedSession } from "./server/session-parser.js";
import { mergeSessionAgentCommands } from "./server/agent-command-store.js";
import { recordToolWorkspaceActivity } from "./server/workspace-activity-store.js";
import { stripUploadedImagesPrefix } from "./server/upload-prefix.js";
import {
	mergeChannels,
	TOPIC_UPGRADE_MESSAGE_THRESHOLD,
	type SessionChannel,
	type SessionChannelMetadata,
	type SessionMessageSummary,
	type SessionQuestionMetadata,
	type SessionSummary,
} from "./server/session-model.js";
import { hasRecordedTopic, SessionMetaStore } from "./shared/session-meta-store.js";
import { getL2Memory } from "./memory/l2/l2-memory.js";
import { LearningRecordStore } from "./learning/record-store.js";
import { logger } from "./logger.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { createGracefulShutdownHandler, installProcessFallbacks } from "./utils/process-fallback.js";
import { questionBridge } from "./agent/question-bridge.js";
import { permissionBridge } from "./agent/permission-bridge.js";
import { streamRegistry } from "./chat/stream-registry.js";
import { TEMP_WORKSPACE_ID, WorkspaceRegistry } from "./workspace/workspace-registry.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// bodyTimeout: 15 min safety net for LLM provider requests. Provider-level
// timeout (retry.provider.timeoutMs, default 10 min) should fire first; this
// ensures a hung connection can't live longer than 15 minutes even if the
// provider timeout fails to abort.
// headersTimeout: keep undici's 300s default so a provider that never sends
// response headers cannot leave the route waiting indefinitely.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 900_000, headersTimeout: 300_000 }));
installFetchLogger();

const parsed = parseRuntimeArgs(process.argv.slice(2));
const paths = resolveRuntimePaths(parsed.options);
await applyRuntimeEnvironment(paths);

// Port is resolved from CLI / env only — config.json is read lazily.
const port = parsed.options.port
	?? (process.env.INNO_PORT ? Number.parseInt(process.env.INNO_PORT, 10) : undefined)
	?? 3000;

// Config is loaded on first API request, not at startup.
let config!: InnoConfig;
let capabilities!: EffectiveCapabilities;

// ---------------------------------------------------------------------------
// Lazy bootstrap — directories, stores, channels, and agent session are
// deferred until the first meaningful web request (not /health or static files).
// Before that, no INNO_HOME subdirectories or files are created.
// ---------------------------------------------------------------------------

const dataDir = paths.dataDir;
// Single owner of sessions/meta.json. Server, sessions routes, auto-title and
// delete all write through it; nothing else may touch the file.
const sessionMetaStore = new SessionMetaStore({ dataDir });
// Single owner of the authoritative per-session learning record. The record is
// written before its projection into meta.json (see learning/record-store.ts).
const learningRecordStore = new LearningRecordStore({ dataDir, metaStore: sessionMetaStore });
// Single owner of `<dataDir>/courses/state.json` (E4.1). Course ownership is
// never inferred: only this store's explicit bindings associate a session,
// source or goal with a course.
const courseStore = new CourseStore({ dataDir });
const l2DataDir = paths.l2DataDir;
// All stateful services are declared with !: — they are guaranteed to be
// initialised before any API handler that uses them runs, because the HTTP
// handler calls ensureBootstrapped() before dispatching.
let workspaceRegistry!: WorkspaceRegistry;

let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;
let agentReadyPromise: Promise<void> | null = null;

/**
 * One-shot lazy bootstrap. Idempotent — concurrent requests while the first
 * bootstrap is still in-flight all await the same promise.
 */
async function ensureBootstrapped(): Promise<void> {
	if (bootstrapped) return;
	if (bootstrapPromise) return bootstrapPromise;

	bootstrapPromise = (async () => {
		logger.info("[inno-server] first meaningful request — bootstrapping...");

		// ---- config (loaded lazily, not at process start) ----
		config = loadConfig(paths.configPath);
		capabilities = resolveCapabilities(config);
		applyProviderProxyBypass(config);

		// ---- data directories ----
		ensureDir(paths.learnerDataDir);
		ensureDir(paths.sessionDir);
		ensureDir(paths.skillsDir);
		ensureDir(paths.workspaceDir);

		// L1 write ownership + crash recovery. A second process on the same data
		// directory stays read-only; the web server still starts.
		const learnerStore = await initializeLearnerStore(paths.learnerDataDir);
		if (learnerStore.mode !== "owner") {
			logger.warn({ mode: learnerStore.mode, code: learnerStore.code }, "L1 learner store is not writable in this process");
		}

		workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir, dataDir);
		workspaceRegistry.ensureBootstrapped();
		// Resolve agent cwd per session based on its workspace binding.
		setWorkspaceCwdResolver((sessionPath: string) => {
			const id = basename(sessionPath);
			const workspaceId = workspaceRegistry.getSessionWorkspaceId(id);
			return workspaceRegistry.resolveWorkspaceDir(workspaceId);
		});
		setPromptEventObserver((event, sessionPath) => {
			if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update") return;
			// Progress events normally omit args; the start event is the source of
			// truth in that case, so do not turn a harmless update into an
			// incomplete-tracking warning.
			if (event.type === "tool_execution_update" && event.args === undefined) return;
			const sessionId = sessionPath ? basename(sessionPath) : getCurrentSessionId();
			if (!sessionId) return;
			const workspaceId = workspaceRegistry.getSessionWorkspaceId(sessionId);
			const workspaceRoot = workspaceRegistry.resolveWorkspaceDir(workspaceId);
			if (!workspaceRoot) return;
			recordToolWorkspaceActivity(dataDir, {
				sessionId,
				workspaceId,
				workspaceRoot,
				toolName: event.toolName,
				args: event.args,
			});
		});

		// Passive APIs need stores, not extension/MCP session_start hooks. Publish
		// application readiness before starting the Agent on the next event loop.
		bootstrapped = true;
		logger.info("[inno-server] application bootstrap complete");
		void ensureAgentReady().catch((err) => {
			logger.warn({ err }, "[inno-server] background agent initialization failed");
		});
	})().catch((err) => {
		logger.error({ err }, "[inno-server] application bootstrap failed");
		bootstrapPromise = null;
		throw err;
	});
	return bootstrapPromise;
}

/** Only runtime operations wait here; failed Agent startup leaves data APIs usable. */
function ensureAgentReady(): Promise<void> {
	if (agentReadyPromise) return agentReadyPromise;
	agentReadyPromise = (async () => {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await ensureBootstrapped();
		// ---- agent session ----
		logger.info("[inno-server] initializing agent session...");
		const initialConfig = config;
		await initSession(initialConfig, paths, { capabilities });

		// Settings can change while session_start hooks are still pending.
		syncConfig(config);
		if (config !== initialConfig) {
			await refreshConfiguredProviders(config);
			const activeModel = getSession().model;
			if (activeModel?.provider !== config.defaultProvider || activeModel?.id !== config.defaultModel) {
				await switchModel(config.defaultProvider, config.defaultModel);
			}
		}

	})().catch((err) => {
		agentReadyPromise = null; // Retry runtime operations without recreating stores.
		throw err;
	});
	return agentReadyPromise;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sessionRevision(filePath: string): string {
	try {
		const stat = statSync(filePath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}


// ---------------------------------------------------------------------------
// Static file serving (web/dist/)
// ---------------------------------------------------------------------------

const webDistDir = paths.webDistDir;

// ---------------------------------------------------------------------------
// Local data helpers
// ---------------------------------------------------------------------------

function sessionFileFromId(sessionDir: string, id: string): string | null {
	const fileName = basename(id);
	if (fileName !== id || !fileName.endsWith(".jsonl")) return null;
	return safeJoinReal(sessionDir, fileName);
}

function parseSessionFile(filePath: string): ParsedSession | null {
	try {
		return parseSessionContent(filePath, readText(filePath), statSync(filePath).mtime.toISOString(),
			(messages) => mergeSessionAgentCommands(dataDir, basename(filePath), messages));
	} catch {
		return null;
	}
}

function sessionChannelMetadataPath(): string {
	return join(dataDir, "sessions", "channels.json");
}

// --- Pending question persistence (survives process restart) ---
function sessionQuestionMetadataPath(): string {
	return join(dataDir, "sessions", "questions.json");
}

/** In-memory cache of questions.json — read once, updated on every write.
 *  Avoids a synchronous readFileSync on every session-detail request. */
let _questionMetadataCache: SessionQuestionMetadata | null = null;

function readSessionQuestionMetadata(): SessionQuestionMetadata {
	if (_questionMetadataCache === null) {
		_questionMetadataCache = readJson<SessionQuestionMetadata>(sessionQuestionMetadataPath(), {});
	}
	return _questionMetadataCache;
}

function writeSessionQuestionMetadata(meta: SessionQuestionMetadata): void {
	_questionMetadataCache = meta;
	writeJson(sessionQuestionMetadataPath(), meta);
}

function readSessionChannelMetadata(): SessionChannelMetadata {
	return readJson<SessionChannelMetadata>(sessionChannelMetadataPath(), {});
}

function recordCurrentSessionChannel(
	channel: SessionChannel,
	explicitSessionId?: string,
	options?: { setOriginIfEmpty?: boolean },
): void {
	const id = explicitSessionId || (() => {
		const sessionFile = getSession().sessionFile;
		return sessionFile ? basename(sessionFile) : "";
	})();
	if (!id) return;
	const metadata = readSessionChannelMetadata();
	const prev = metadata[id];
	metadata[id] = {
		channels: mergeChannels(prev?.channels ?? [], [channel]),
		// origin is the immutable birthplace of the session: set once and never
		// overwritten. Interaction tagging (e.g. a web session pushing a file to
		// feishu) must NOT change origin, so it omits setOriginIfEmpty.
		origin: prev?.origin ?? (options?.setOriginIfEmpty ? channel : undefined),
		updatedAt: new Date().toISOString(),
	};
	writeJson(sessionChannelMetadataPath(), metadata);
}

/**
 * A manual "run now" job always happens in a conversation created for it, so
 * the session's birthplace IS the scheduler. Override the "web" origin that
 * POST /api/sessions stamped at creation time so the sidebar can badge it.
 */
function cleanGeneratedTopic(raw: string): string {
	return raw
		.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32);
}

/** Strip machine-injected prefixes (e.g. the image-upload hint prepended to
 *  user prompts) so titles reflect the user's actual words. */
function stripInjectedPrefix(content: string): string {
	return stripUploadedImagesPrefix(content);
}

function fallbackTopicFromMessages(messages: SessionMessageSummary[], summary: SessionSummary): string {
	const source = stripInjectedPrefix(messages.find((message) => message.role === "user")?.content || "") || summary.preview || summary.name;
	const cleaned = source.replace(/\s+/g, " ").trim();
	return cleaned ? (cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned) : "New conversation";
}

/** Build the dialogue excerpt for topic generation: first 2 + last 4 usable
 *  messages (the opening states the goal, the tail captures where the
 *  conversation actually went), consecutive duplicates dropped (scheduler
 *  nudges repeat), machine prefixes stripped, ~2400 chars. */
function buildTopicExcerpt(messages: SessionMessageSummary[]): string {
	const usable = messages
		.map((message) => ({
			role: message.role,
			content: stripInjectedPrefix(message.content).replace(/\s+/g, " ").trim(),
		}))
		.filter((message) => message.content)
		.filter((message, index, all) => index === 0 || message.content !== all[index - 1].content);
	const picked = usable.length <= 6 ? usable : [...usable.slice(0, 2), ...usable.slice(-4)];
	return picked
		.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content}`)
		.join("\n")
		.slice(0, 2400);
}

async function generateSessionTopic(summary: SessionSummary, messages: SessionMessageSummary[]): Promise<string> {
	const excerpt = buildTopicExcerpt(messages);

	if (!excerpt) return fallbackTopicFromMessages(messages, summary);

	const prompt = `请用一句简短的中文短语概括下面学习对话中用户的学习目标或任务。
要求：
- 只输出标题本身，不要解释
- 8 到 16 个中文字符
- 聚焦用户想学的内容或要做的任务，忽略寒暄、客套话和系统提示
- 不要使用引号、句号或冒号

示例一：
对话：
用户: 你好
助手: 你好！今天想学点什么？
用户: 我一直搞不清贝叶斯定理，能举个生活中的例子讲讲吗
标题：贝叶斯定理入门

示例二：
对话：
用户: 帮我把这份教案改成 45 分钟公开课的版本
助手: 好的，我先看看教案的结构……
标题：教案改编公开课版

对话：
${excerpt}
标题：`;

	try {
		// Reasoning models burn tokens on a thinking block before any visible
		// text — a tiny maxTokens (e.g. 64) gets fully consumed by thinking and
		// yields an empty title. 1024 leaves ample room for both.
		const generated = cleanGeneratedTopic(await completePromptOnce(prompt, 1024));
		return generated || fallbackTopicFromMessages(messages, summary);
	} catch (err) {
		return fallbackTopicFromMessages(messages, summary);
	}
}

/**
 * Auto-generate a topic for a session if it doesn't already have one.
 * Runs asynchronously — fire and forget.
 *
 * Two passes, both guarded by `_pendingAutoTopics`:
 * 1. First pass: no topic recorded yet and ≥2 messages (the first exchange).
 *    Ask the model for a useful title as soon as the first reply is available;
 *    fall back to the user's first-message preview if generation fails.
 * 2. Upgrade pass: the existing preview is auto-generated (never a manual
 *    rename), hasn't been upgraded yet, and the conversation has grown to
 *    TOPIC_UPGRADE_MESSAGE_THRESHOLD messages — generate a richer summary
 *    once there is enough context.
 */
const _pendingAutoTopics = new Set<string>();

function maybeAutoGenerateTopic(sessionId: string): void {
	if (!sessionId || _pendingAutoTopics.has(sessionId)) return;

	const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
	if (!sessionPath || !existsSync(sessionPath)) return;

	_pendingAutoTopics.add(sessionId);
	void (async () => {
		try {
			// Read inside the async pass: the metadata read is now async, and a
			// manual rename that lands between scheduling and running must win.
			const existing = await sessionMetaStore.get(sessionId);
			// "Entry exists" is not "title exists": initialising the learning record
			// creates a metadata entry with only a `learning` projection, and that
			// must still get its first auto title.
			const hasTitle = hasRecordedTopic(existing);
			// A real manual title always wins; an already-upgraded auto title is final.
			if (hasTitle && (existing!.generated !== true || existing!.upgraded === true)) return;
			const parsed = parseSessionFile(sessionPath);
			if (!parsed || parsed.messages.length < 2) return;
			// Only the upgrade pass waits for enough context; a first title does not.
			if (hasTitle && parsed.messages.length < TOPIC_UPGRADE_MESSAGE_THRESHOLD) return;
			const topic = await generateSessionTopic(parsed.summary, parsed.messages);
			// Atomic condition inside the write boundary: only applies when the
			// title is still auto-generated and the session still exists. It does
			// not key on the whole-entry `rev` (which a learning projection write
			// also bumps), and it never resurrects a session deleted mid-generation.
			const result = await sessionMetaStore.setAutoTopic(sessionId, topic, {
				upgraded: hasTitle ? true : undefined,
				// Evaluated inside the write boundary: a session deleted while the
				// model was generating must not be resurrected by this late write.
				sessionExists: () => existsSync(sessionPath),
			});
			if (result.applied) {
				logger.info(`[auto-topic] ${sessionId} → ${topic}${hasTitle ? " (upgraded)" : ""}`);
			}
		} catch (err) {
			// A rename/deletion race makes setAutoTopic return applied:false rather
			// than throw; only genuine failures land here and are non-fatal.
			logger.warn({ err }, `auto-topic generation failed for ${sessionId}`);
		} finally {
			_pendingAutoTopics.delete(sessionId);
		}
	})();
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

/**
 * The prompt currently holding the shared serial queue, if any. Session
 * replacement also holds this queue while loading resources, but is not an
 * active prompt and therefore has no prompt blocker metadata to expose.
 */
function getQueueBlocker(): { sessionId: string; turnId: string; questionPending: boolean } | null {
	const token = getActivePromptToken();
	if (!token) return null;
	const state = streamRegistry.getByTurn(token);
	if (!state || (state.status !== "queued" && state.status !== "running")) return null;
	const pending = questionBridge.pendingInfo();
	const pendingPermission = permissionBridge.pendingInfo();
	return {
		sessionId: state.sessionId,
		turnId: state.turnId,
		// A permission card parks the agent loop exactly like a question card.
		questionPending: pending?.turnId === state.turnId || pendingPermission?.turnId === state.turnId,
	};
}

/**
 * Session-retention policy (issue #124): a turn parked on a question card can
 * never progress without the user, yet it holds the shared prompt queue for
 * up to the 30-minute question timeout — blocking every session switch /
 * creation behind it. Navigating to a DIFFERENT session implicitly abandons
 * the card, so abort that turn to release the queue. Turns that are actively
 * generating are left alone (they end on their own; the user can still stop
 * them explicitly via the scoped abort endpoint).
 *
 * Mirrors the scoped abort route: cancel the registry state, resolve the
 * parked question (session.abort() alone cannot wake it), then abort.
 */
function releaseQueueFromQuestionBlockedTurn(targetSessionId: string): void {
	const blocker = getQueueBlocker();
	if (!blocker || !blocker.questionPending || blocker.sessionId === targetSessionId) return;
	const state = streamRegistry.getByTurn(blocker.turnId);
	if (!state) return;
	logger.info({ blockedSession: blocker.sessionId, turnId: blocker.turnId, targetSessionId }, "auto-aborting question-blocked turn to release the prompt queue");
	streamRegistry.requestCancel(state);
	questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "switched_away" });
	permissionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "switched_away" });
	if (state.status === "running") void abortPromptForTurnToken(state.turnId);
}

/**
 * Run an enqueue-backed operation with a hard wait bound. If the queue is
 * held by a long turn the caller gets a 409 with blocker details instead of
 * hanging for minutes; a client disconnect cancels the still-queued task so
 * it never executes out from under a user who already gave up.
 */
async function runQueueOpWithTimeout<T>(
	_req: HttpReq,
	res: ServerResponse,
	op: (options: QueueTaskOptions) => Promise<T>,
	timeoutMs = 8_000,
): Promise<T | null> {
	return runQueuedHttpOperation(res, op, { timeoutMs, getQueueBlocker });
}

/**
 * E4.4a: create a web session for a course learning start.
 *
 * Mirrors `POST /api/sessions` (same queue, same workspace binding, same
 * channel metadata) so a learning session is an ordinary session in every
 * respect; the only difference is who asked for it. Returns the previously
 * active session id so a failed course binding can be compensated.
 */
async function createSessionForLearning(
	req: HttpReq,
	res: ServerResponse,
): Promise<{ sessionId: string; previousSessionId: string } | null> {
	const previousSessionId = getCurrentSessionId();
	releaseQueueFromQuestionBlockedTurn("");
	const id = await runQueueOpWithTimeout(req, res, (options) => createNewSession(options));
	if (id === null) return null;
	recordCurrentSessionChannel("web", id, { setOriginIfEmpty: true });
	try {
		workspaceRegistry.bindSession(id, TEMP_WORKSPACE_ID);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (sessionPath) await applyWorkspaceCwd(sessionPath, { onlyIfCurrent: true });
	} catch (err) {
		logger.warn({ err, sessionId: id }, "learning start: workspace binding failed");
	}
	return { sessionId: id, previousSessionId };
}

/** Switch the runtime to an already-bound learning session (「继续学习」). */
async function activateLearningSession(
	sessionId: string,
	req: HttpReq,
	res: ServerResponse,
): Promise<"ok" | "busy" | "unavailable"> {
	const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
	if (!sessionPath || !existsSync(sessionPath)) return "unavailable";
	releaseQueueFromQuestionBlockedTurn(sessionId);
	try {
		const switched = await runQueueOpWithTimeout(req, res, (options) =>
			switchSessionFile(sessionPath, options).then(() => true as const));
		if (switched === null) return "busy";
		return getCurrentSessionId() === sessionId ? "ok" : "unavailable";
	} catch (err) {
		if (err instanceof SessionUnavailableError) return "unavailable";
		throw err;
	}
}

/**
 * E4.4a compensation: remove a session this request created seconds ago.
 *
 * Only an empty session may be discarded — a conversation that already has a
 * message is somebody's history, and deleting it to tidy up a failed binding
 * would be worse than leaving it unclassified (「未归类」 is a safe state).
 */
async function discardLearningSession(
	sessionId: string,
	previousSessionId: string,
	req: HttpReq,
	res: ServerResponse,
): Promise<{ discarded: boolean; reason?: string }> {
	const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
	if (!sessionPath) return { discarded: false, reason: "invalid_session" };
	if (!existsSync(sessionPath)) return { discarded: true };
	try {
		const stat = await statFile(sessionPath);
		if (stat && stat.size > 0) return { discarded: false, reason: "session_has_content" };
	} catch {
		return { discarded: false, reason: "unreadable" };
	}
	const previousPath = previousSessionId
		? sessionFileFromId(join(dataDir, "sessions"), previousSessionId)
		: null;
	if (!previousPath || !existsSync(previousPath)) return { discarded: false, reason: "no_replacement" };
	try {
		const outcome = await runQueueOpWithTimeout(req, res, (options) => deleteSessionFileInQueue(
			sessionId,
			sessionPath,
			{
				selectReplacement: () => ({ id: previousSessionId, path: previousPath }),
				validateReplacement: () => undefined,
			},
			options,
		));
		if (outcome === null) return { discarded: false, reason: "queue_busy" };
		await learningRecordStore.remove(sessionId).catch(() => undefined);
		await sessionMetaStore.remove(sessionId).catch(() => undefined);
		return { discarded: true };
	} catch (err) {
		logger.warn({ err, sessionId }, "learning start: compensating delete failed");
		return { discarded: false, reason: "delete_failed" };
	}
}

/** B2 initialisation for a started session; existing records are returned as-is. */
async function initializeLearningRecordForSession(
	sessionId: string,
	goalId: string | null,
): Promise<{ created: boolean; checkpoint: { revision: number; status: string; step: string } | null }> {
	const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
	if (!sessionPath) return { created: false, checkpoint: null };
	const existing = await learningRecordStore.get(sessionId).catch(() => undefined);
	const record = await learningRecordStore.create(sessionId, {
		...(goalId ? { goalId } : {}),
		sessionExists: () => existsSync(sessionPath) && !sessionLifecycle.isBlocked(sessionId),
	});
	return {
		created: !existing,
		checkpoint: {
			revision: record.checkpoint.revision,
			status: record.checkpoint.status,
			step: record.checkpoint.step,
		},
	};
}

const { dispatch: dispatchRoutes } = createRouteDispatcher({
	// --- Sessions API (extracted to server/routes/sessions.ts) ---
	sessions: (req, res, method, url) => handleSessionsRoutes(req, res, method, url, {
		workspaceRegistry, dataDir, paths, capabilities,
		parseSessionFile, sessionRevision,
		readSessionChannelMetadata, sessionChannelMetadataPath,
		sessionMetaStore, learningRecordStore,
		// C1: knowledge selection reads the same L2 store the wiki tools use.
		// Reuse the per-dir singleton (shared handle + index sync) instead of
		// constructing a fresh L2Memory per request, which would reopen the SQLite
		// index and lose the backfill/incremental index state the wiki tools keep.
		// The backfill before search is idempotent and cheap (skips unchanged
		// files), and it closes the "index not yet synced" gap: without it a fresh
		// process that never ran the agent extension would report a populated wiki
		// as "empty", because the on-disk pages were never indexed.
		l2DataDir,
		l2Enabled: capabilities.capabilities.memoryL2.enabled,
		searchL2: capabilities.capabilities.memoryL2.enabled
			? async (query: string, options?: { sourceIds?: readonly string[] }) => {
				const memory = getL2Memory(l2DataDir);
				await memory.backfill();
				return memory.search(query, 5, options);
			}
			: null,
		completeModel: runSideChannelCompletion,
		checkModelReady: isCompletionModelReady,
		currentModel: currentModelIdentity,
		readSessionQuestionMetadata, writeSessionQuestionMetadata,
		recordCurrentSessionChannel, generateSessionTopic,
		sessionFileFromId, releaseQueueFromQuestionBlockedTurn, runQueueOpWithTimeout,
		// E4.1: the session-delete route drops its course binding through the
		// store that owns it, so no dangling session reference is left behind.
		courseStore,
	}),

	// --- Wiki + L2 raw upload API (extracted to server/routes/wiki.ts) ---
	wiki: (req, res, method, url) => handleWikiRoutes(req, res, method, url, { l2DataDir, capabilities }),

	// --- Learner profile API (extracted to server/routes/learner.ts) ---
	learner: (req, res, method, url) => handleLearnerRoutes(req, res, method, url, { paths, capabilities }),

	// --- Course API (E4.1; server/routes/courses.ts) ---
	courses: (req, res, method, url) => handleCoursesRoutes(req, res, method, url, {
		courseStore,
		paths,
		l2Enabled: capabilities.capabilities.memoryL2.enabled,
		// A session binding must name a real session file, never a client claim.
		// Async on purpose: this runs on the request path (no sync fs calls).
		sessionExists: async (sessionId: string) => {
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
			if (!sessionPath) return false;
			return statFile(sessionPath).then((stat) => Boolean(stat), () => false);
		},
		// E4.3b: a plan draft uses the same side channel as C1 — no chat history,
		// no prompt queue — and the same L2 singleton, with a course scope pushed
		// into the search rather than applied to its results.
		completeModel: runSideChannelCompletion,
		currentModel: currentModelIdentity,
		searchL2: capabilities.capabilities.memoryL2.enabled
			? async (query: string, options?: { sourceIds?: readonly string[] }) => {
				const memory = getL2Memory(l2DataDir);
				await memory.backfill();
				return memory.search(query, 8, options);
			}
			: null,
		// E4.4a: session creation stays behind the one Agent queue this module
		// already owns; the course route only asks for it.
		learningRuntime: {
			createSession: createSessionForLearning,
			activateSession: activateLearningSession,
			discardSession: discardLearningSession,
			sessionState: (sessionId: string) => {
				const state = sessionLifecycle.status(sessionId);
				return state === "deleting" || state === "deleted" ? state : null;
			},
			initializeLearningRecord: initializeLearningRecordForSession,
		},
	}),

	// --- Settings API (extracted to server/routes/settings.ts) ---
	settings: (req, res, method, url) => handleSettingsRoutes(req, res, method, url, {
		paths, capabilities,
		getConfig: () => config,
		setConfig: (next) => { config = next; },
		// The settings status card may only claim "ready" after a real model
		// call. Reuse the side channel (no conversation history, no queue) with
		// a one-word prompt; the runtime is started on demand because the user
		// explicitly asked for this check.
		// The budget is deliberately larger than the answer needs: providers that
		// emit reasoning tokens hit a 16-token cap and report stopReason "length"
		// (observed live against qwen3.8-flash), which the side channel correctly
		// treats as a failure and would show as "not ready" for a working model.
		verifyModel: async () => {
			await ensureAgentReady();
			return runSideChannelCompletion({ prompt: "ping", maxTokens: 512, timeoutMs: 20_000 });
		},
	}),

	// --- Slash commands API (extracted to server/routes/commands.ts) ---
	commands: (req, res, method, url) => handleCommandsRoutes(req, res, method, url),

	// --- Chat API (extracted to server/routes/chat.ts) ---
	chat: (req, res, method, url) => handleChatRoutes(req, res, method, url, {
		workspaceRegistry, dataDir, paths, capabilities,
		sessionFileFromId, releaseQueueFromQuestionBlockedTurn,
		readSessionQuestionMetadata, writeSessionQuestionMetadata,
		recordCurrentSessionChannel, maybeAutoGenerateTopic,
		parseSessionFile, sessionRevision,
	}),
});

const requestIdSymbol = Symbol("requestId");
const server = createServer(async (req, response) => {
	const startedAt = performance.now();
	const requestId = randomUUID();
	const res = Object.assign(response, { [requestIdSymbol]: requestId });
	res.setHeader("x-request-id", requestId);
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	const path = url.split("?", 1)[0];
	const logLevel = path.startsWith("/api/") && path !== "/api/health" ? "info" : "debug";

	// Defensive only: response stream errors must have a listener.
	res.once("error", (err) => logger.debug({ err, requestId }, "HTTP response stream error"));
	let accessLogged = false;
	const logAccess = () => {
		// Normal responses emit close after finish; disconnected SSE may only emit close.
		if (accessLogged) return;
		accessLogged = true;
		logger[logLevel]({
			method,
			path,
			statusCode: res.statusCode,
			durationMs: Math.round(performance.now() - startedAt),
			requestId,
			outcome: res.writableFinished ? "finished" : "disconnected",
		}, "HTTP request");
	};
	res.once("finish", logAccess);
	res.once("close", logAccess);

	try {
		// --- Health check (no bootstrap needed) ---
		if (method === "GET" && (url === "/health" || url === "/api/health")) {
			json(res, 200, { status: "ok" });
			return;
		}

		// --- Lazy bootstrap on first API request ---
		// Data APIs only need application stores. Agent hooks must not block
		// history, file previews, settings, search, or terminal access.
		// Static files and SPA fallback skip this so no directories are
		// created until the user actually interacts with the web UI.
		if (url.startsWith("/api/")) {
			await ensureBootstrapped();
			const disabled = disabledRouteCapability(method, url, capabilities);
			if (disabled) { json(res, 403, { error: "capability_disabled", capability: disabled }); return; }
			if (requiresAgent(method, url)) await ensureAgentReady();
			if (res.destroyed) return;
		}

		if (await dispatchRoutes(req, res, method, url)) return;

		// --- Static files / SPA fallback ---
		if (method === "GET" || method === "HEAD") {
			const urlPath = decodeURIComponent(url.split("?")[0]);
			const staticPath = safeJoinReal(webDistDir, urlPath.replace(/^\/+/, ""));
			const sendBody = method === "GET";
			// Try exact file in web/dist
			if (staticPath && await serveStatic(req, res, staticPath, sendBody, webDistDir)) return;
			// Never route an asset miss through the SPA fallback. Returning
			// index.html with a 200 status for a stale hashed JS/CSS URL makes the
			// browser report an opaque dynamic-import failure instead of exposing
			// the real missing asset and prevents a panel retry from recovering.
			const isAssetRequest = urlPath === "/assets" || urlPath.startsWith("/assets/");
			// SPA fallback: serve index.html for non-API, non-asset paths only. An
			// unmatched /api/* route must fall through to the JSON 404 — returning
			// HTML with a 200 status breaks API client error handling.
			if (!isAssetRequest && urlPath !== "/api" && !urlPath.startsWith("/api/") && await serveStatic(req, res, join(webDistDir, "index.html"), sendBody, webDistDir)) return;
		}

		// --- 404 ---
		json(res, 404, { error: "Not found" });
	} catch (err) {
		logger.error({ err, requestId }, "unhandled error in HTTP handler");
		if (res.destroyed || res.writableEnded) return;
		// SSE/streaming responses have already sent headers — calling json()
		// here would throw ERR_HTTP_HEADERS_SENT from inside this catch block
		// and kill the process. The only safe move is to end the stream.
		if (res.headersSent) {
			try { res.end(); } catch { /* best effort */ }
			return;
		}
		// readBody failures carry a client-facing status (400/413); anything
		// else is an internal error and must not leak details.
		if (err instanceof HttpError) {
			if (err.statusCode === 413) {
				// The oversized body was never consumed, so this connection is
				// unsafe for keep-alive — Node closes it after the response.
				res.setHeader("Connection", "close");
			}
			json(res, err.statusCode, { error: err.message });
			return;
		}
		json(res, 500, { error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// Start listening immediately — /health and static files work right away.
// All other endpoints call ensureBootstrapped() lazily on first request.
// ---------------------------------------------------------------------------

// Inject persistence callbacks into questionBridge so pending question cards
// survive a full process restart.
questionBridge.setPersistence({
	save: (sessionId, question) => {
		const meta = readSessionQuestionMetadata();
		meta[sessionId] = question;
		writeSessionQuestionMetadata(meta);
	},
	remove: (sessionId) => {
		const meta = readSessionQuestionMetadata();
		if (sessionId in meta) {
			delete meta[sessionId];
			writeSessionQuestionMetadata(meta);
		}
	},
});

// Process-level last resort: a stray rejection or an exception escaping a
// catch block would otherwise kill the process silently (or via a secondary
// ERR_HTTP_HEADERS_SENT from the catch-all). Log at fatal level, close the
// HTTP/WS servers so clients see a clean close, then exit — after an
// uncaught exception the process state is untrustworthy, so we do not
// attempt to continue serving.
installProcessFallbacks({
	onFatal: () => {
		try { server.close(); } catch { /* best effort */ }
	},
});

const gracefulShutdown = createGracefulShutdownHandler({
	server,
	exit: (code) => {
		// Stop the resident renderer and remove its private profile on normal shutdown.
		const deadline = setTimeout(() => process.exit(code), 1_000);
		deadline.unref();
	},
});
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

server.listen(port, "127.0.0.1", () => {
	// Prewarm outside the request path; the HTTP server remains immediately usable.
	console.log(`[inno-server] listening on http://localhost:${port}`);
	console.log(`[inno-server] config: ${paths.configPath}`);
});
