import type { EffectiveCapabilities } from "../../shared/capabilities.js";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildContextUsage, unavailableContextUsage } from "../../agent/context-usage.js";
import {
	applyWorkspaceCwd,
	branchSessionBeforeUserMessage,
	createNewSession,
	createNewSessionInQueueSlot,
	deleteSessionFileInQueue,
	getCurrentSessionId,
	getSession,
	SessionEditError,
	switchSessionFile,
	type QueueTaskOptions,
	type SessionDeletionPlan,
} from "../../agent/pi-runner.js";
import {
	NoReplacementSessionError,
	ReplacementCreationError,
	sessionLifecycle,
	SessionUnavailableError,
	type SessionDeletionLease,
} from "../../agent/session-lifecycle.js";
import { streamRegistry } from "../../chat/stream-registry.js";
import { logger } from "../../logger.js";
import type { RuntimePaths } from "../../runtime.js";
import { readJson, writeJson } from "../../storage/file-store.js";
import { TEMP_WORKSPACE_ID, type WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import {
	clearSessionAttachments,
	mergeSessionAttachments,
} from "../attachments-store.js";
import { clearSessionAgentCommands } from "../agent-command-store.js";
import { clearSessionTraces, mergeSessionTraces } from "../trace-store.js";
import { clearSessionBtw } from "../btw-store.js";
import { contentDispositionAttachment } from "../file-helpers.js";
import { clearWorkspaceActivity } from "../workspace-activity-store.js";
import { HttpError, json, matchRoute, readBody } from "../http-helpers.js";
import { refuseChatWrite } from "../chat-write-guard.js";
import {
	isSessionManuallyArchived,
	sessionArchiveMetadataPath,
	withArchiveMetadataLock,
} from "../session-archive-store.js";
import {
	clearSessionCleanup,
	readSessionCleanup,
	writeSessionCleanup,
} from "../session-cleanup-store.js";
import { selectReplacementSession } from "../session-replacement.js";
import {
	mergeChannels,
	TOPIC_UPGRADE_MESSAGE_THRESHOLD,
	type SessionChannel,
	type SessionChannelMetadata,
	type SessionMessageSummary,
	type SessionQuestionMetadata,
	type SessionSummary,
	type SessionTopicMetadata,
} from "../session-model.js";
import { SessionMetaError, type SessionMetaStore } from "../../shared/session-meta-store.js";
import { LearningRecordError, publicCheckpoint, type LearningRecordStore } from "../../learning/record-store.js";
import { BranchEditRefusedError, evaluateBranchEditSafety } from "../../learning/branch-edit-guard.js";
import type { L2SearchResult } from "../../memory/l2/l2-search.js";
import type { CourseStore } from "../../courses/course-store.js";
import { CourseStoreError } from "../../courses/course-store.js";
import {
	checkConceptScope,
	CourseContextError,
	resolveCourseContext,
	retrievalSourceScope,
	type ResolvedCourseContext,
} from "../../courses/course-context.js";
import { loadProfile } from "../../memory/learner/profile-store.js";
import { LearningContractError } from "../../learning/contracts.js";
import { parseQuestionRequest, type QuestionGenerationRequest } from "../../learning/question-request.js";
import { generateAndCommitQuestion, type QuestionServiceResult } from "../../learning/question-service.js";
import { evaluateAttempt, finalizeAttempt, saveAnswer } from "../../learning/answer-service.js";
import type { ModelCompletion } from "../../shared/model-completion.js";
import type { LearningModelIdentity } from "../../memory/learner/types.js";

/**
 * Server-owned dependencies the sessions routes touch. Most of these are
 * session-metadata helpers that still live in server.ts because the chat
 * domain (not yet extracted) uses them too; they are injected rather than
 * imported so the route bodies stay verbatim.
 */
export interface SessionsRouteContext {
	capabilities?: EffectiveCapabilities;
	workspaceRegistry: WorkspaceRegistry;
	dataDir: string;
	paths: RuntimePaths;
	parseSessionFile: (filePath: string) => { summary: SessionSummary; messages: SessionMessageSummary[] } | null;
	sessionRevision: (filePath: string) => string;
	readSessionChannelMetadata: () => SessionChannelMetadata;
	sessionChannelMetadataPath: () => string;
	/** Single owner of sessions/meta.json (title + learning projection). */
	sessionMetaStore: SessionMetaStore;
	/** Single owner of the authoritative per-session learning record. */
	learningRecordStore: LearningRecordStore;
	/** L2 store root, read by C1 during knowledge selection. */
	l2DataDir: string;
	/** Whether the L2 capability is on for this configuration. */
	l2Enabled: boolean;
	/** Indexed L2 search; `null` when L2 is off. `null` results mean "index unavailable". */
	searchL2: ((query: string, options?: { sourceIds?: readonly string[] }) => Promise<L2SearchResult[] | null>) | null;
	/** Side-channel model call used for question generation. */
	completeModel: ModelCompletion;
	/** Lightweight readiness probe: false means "do not spend an evaluation retry". */
	checkModelReady: () => Promise<boolean>;
	/** Runtime-reported model identity (decides whether model knowledge may be used). */
	currentModel: () => LearningModelIdentity | null;
	readSessionQuestionMetadata: () => SessionQuestionMetadata;
	writeSessionQuestionMetadata: (meta: SessionQuestionMetadata) => void;
	recordCurrentSessionChannel: (channel: SessionChannel, explicitSessionId?: string, options?: { setOriginIfEmpty?: boolean }) => void;
	generateSessionTopic: (summary: SessionSummary, messages: SessionMessageSummary[]) => Promise<string>;
	sessionFileFromId: (sessionDir: string, id: string) => string | null;
	/**
	 * E4.1: the single course store, so a deleted session's course binding is
	 * cleaned by its owner instead of leaving a dangling reference. Optional so
	 * route tests that never touch courses can omit it.
	 */
	courseStore?: CourseStore;
	releaseQueueFromQuestionBlockedTurn: (sessionId: string) => void;
	runQueueOpWithTimeout: <T>(
		req: HttpReq,
		res: ServerResponse,
		op: (options: QueueTaskOptions) => Promise<T>,
		timeoutMs?: number,
	) => Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Learning-state recovery constants (B2). Scoring/evidence work is a later
// package; these only feed the existing learningRecoveryAction state machine so
// the public state can name the next step without executing it.
// ---------------------------------------------------------------------------

/** Identifies this process for the "evaluating" recovery branch. */
const PROCESS_RUN_ID = randomUUID();
/** Evaluation retry budget; the same value the future scoring package will use. */
const MAX_EVALUATION_ATTEMPTS = 3;

/** Map a learning-record store failure to an HTTP status + public error. */
function sendLearningRecordError(res: ServerResponse, err: unknown): boolean {
	if (!(err instanceof LearningRecordError)) return false;
	switch (err.code) {
		case "RECORD_NOT_FOUND":
			json(res, 404, { error: "learning_not_found" });
			return true;
		case "RECORD_CONFLICT":
			json(res, 409, { error: "learning_conflict", revision: err.currentRevision });
			return true;
		case "RECORD_STATE_INVALID":
			json(res, 409, { error: "learning_state_invalid" });
			return true;
		case "RECORD_INVALID":
		case "RECORD_CORRUPT":
			json(res, 422, { error: "learning_corrupt" });
			return true;
		case "RECORD_WRITER_LOCK":
		case "RECORD_LOCK_LOST":
			json(res, 503, { error: "learning_read_only" });
			return true;
		case "RECORD_CLOSED":
			json(res, 503, { error: "learning_unavailable" });
			return true;
		default:
			json(res, 500, { error: "learning_store_failure" });
			return true;
	}
}

/**
 * E4.1a course-context failures.
 *
 * - invalid id / unreadable relation → 400/409 (the request cannot name a
 *   course);
 * - a corrupt or locked course file → 503, never "treat as unclassified":
 *   silently widening to the global scope would cross course boundaries.
 */
function sendCourseContextError(res: ServerResponse, err: unknown): boolean {
	if (err instanceof CourseContextError) {
		const status = err.code === "course_context_invalid" ? 400 : 409;
		json(res, status, { error: err.code, message: err.message, category: "courses" });
		return true;
	}
	if (err instanceof CourseStoreError) {
		const status = err.code === "COURSE_CONFLICT" || err.code === "COURSE_NOT_FOUND" ? 409 : 503;
		json(res, status, { error: err.code.toLowerCase(), category: "courses" });
		return true;
	}
	return false;
}

/**
 * E4.7-R1 — history-only conversations stay readable, never writable.
 *
 * Two independent states produce the rule: the learner archived the session
 * itself, or the parent course is archived. Record creation, question
 * generation, answer submission, evaluation, finalisation and checkpoint
 * pause/resume are the only ways a session can produce formal learning records,
 * so each is refused with the state that caused it (`session_archived` /
 * `course_archived`). Reading a record and listing sessions stay allowed.
 */
/**
 * E4.8a — editing history ends in a chat turn, so it follows the chat rule.
 *
 * Without this, a learner could branch an unclassified or paused conversation
 * (truncating it) and only then be refused by `/api/chat` — losing the tail for
 * a turn that was never allowed. The check runs before the queue slot.
 */
async function refusesChatHistoryEdit(
	ctx: SessionsRouteContext,
	sessionId: string,
	res: ServerResponse,
): Promise<boolean> {
	const sessionPath = ctx.sessionFileFromId(join(ctx.dataDir, "sessions"), sessionId);
	const summary = sessionPath ? ctx.parseSessionFile(sessionPath)?.summary : undefined;
	const channels = ctx.readSessionChannelMetadata()[sessionId]?.channels ?? summary?.channels;
	const refusal = await refuseChatWrite({
		courseStore: ctx.courseStore,
		dataDir: ctx.dataDir,
		sessionId,
		channels,
	});
	if (!refusal) return false;
	json(res, refusal.status, refusal.body);
	return true;
}

async function refusesReadOnlySessionWrite(
	ctx: SessionsRouteContext,
	sessionId: string,
	res: ServerResponse,
	context?: ResolvedCourseContext,
): Promise<boolean> {
	// E4.7-R1: two independent states can make a conversation history-only.
	// The session's own flag is checked first because it is the learner's direct
	// action and names a different remedy than an archived parent course.
	if (isSessionManuallyArchived(ctx.dataDir, sessionId)) {
		json(res, 409, {
			error: "session_archived",
			message: "该会话已归档，仅供查看；请在「系统设置 → 归档会话」恢复会话后再继续学习。",
			category: "sessions",
		});
		return true;
	}
	const resolved = context ?? await resolveCourseContext(ctx.courseStore, sessionId);
	if (resolved.status !== "course" || !resolved.courseArchived) return false;
	json(res, 409, {
		error: "course_archived",
		message: "课程已归档，历史记录仅供查看；请在设置中恢复课程后再继续学习。",
		category: "courses",
	});
	return true;
}

/**
 * E4.7-R2a — finish a blank successor's registration.
 *
 * The successor is created inside the Agent queue; its channel/origin and
 * workspace binding are ordinary web-session setup. This must run before any
 * cleanup of the old session can fail, and a retry may call it again: the
 * channel write is conditional (`setOriginIfEmpty`) and the workspace binding
 * is idempotent.
 */
async function initializeReplacementSession(
	ctx: SessionsRouteContext,
	sessionId: string,
): Promise<boolean> {
	try {
		ctx.recordCurrentSessionChannel("web", sessionId, { setOriginIfEmpty: true });
		ctx.workspaceRegistry.bindSession(sessionId, TEMP_WORKSPACE_ID);
		const createdPath = ctx.sessionFileFromId(join(ctx.dataDir, "sessions"), sessionId);
		if (!createdPath || !existsSync(createdPath)) return false;
		await applyWorkspaceCwd(createdPath, { onlyIfCurrent: true });
		return true;
	} catch (err) {
		logger.warn({ err, sessionId }, "session delete: blank replacement initialisation failed");
		return false;
	}
}

/**
 * E4.7-R2a — clean every independent sidecar and name the ones that failed.
 *
 * Each step has its own try/catch: one broken sidecar must not skip the rest,
 * and the caller must be able to retry exactly what is left. Names are part of
 * the API payload (`cleanup_failures`) and the durable marker, so they are stable
 * identifiers rather than free-form messages.
 */
async function cleanupSessionSidecars(
	ctx: SessionsRouteContext,
	sessionId: string,
): Promise<string[]> {
	const { dataDir } = ctx;
	const failures: string[] = [];
	const run = async (step: string, action: () => unknown | Promise<unknown>): Promise<void> => {
		try {
			await action();
		} catch (err) {
			logger.warn({ err, sessionId, step }, "session delete: sidecar cleanup failed");
			failures.push(step);
		}
	};

	await run("channel_metadata", () => {
		const channelMeta = ctx.readSessionChannelMetadata();
		if (!channelMeta[sessionId]) return;
		delete channelMeta[sessionId];
		writeJson(ctx.sessionChannelMetadataPath(), channelMeta);
	});
	// Same queue as archive/unarchive: a concurrent archive cannot write this
	// entry back after the delete has finished cleaning up.
	await run("archive_metadata", () => withArchiveMetadataLock(() => {
		const current = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(dataDir), {});
		// Presence check, not truthiness: a restored session carries an explicit
		// `false`, and leaving it behind would keep a marker for a deleted id.
		if (!Object.prototype.hasOwnProperty.call(current, sessionId)) return;
		delete current[sessionId];
		writeJson(sessionArchiveMetadataPath(dataDir), current);
	}));
	await run("question_metadata", () => {
		const questionMeta = ctx.readSessionQuestionMetadata();
		if (!questionMeta[sessionId]) return;
		delete questionMeta[sessionId];
		ctx.writeSessionQuestionMetadata(questionMeta);
	});
	await run("attachments", () => clearSessionAttachments(dataDir, sessionId));
	await run("agent_commands", () => clearSessionAgentCommands(dataDir, sessionId));
	await run("traces", () => clearSessionTraces(dataDir, sessionId));
	await run("btw", () => clearSessionBtw(dataDir, sessionId));
	await run("workspace_activity", () => clearWorkspaceActivity(dataDir, sessionId));
	if (ctx.courseStore) {
		await run("course_binding", () => ctx.courseStore!.removeSessionBinding(sessionId));
	}
	return failures;
}

/**
 * A session id is a single file name under `sessions/`. Reject anything that is
 * not exactly that: separators, a leftover `%` (the router already decoded once,
 * so a remaining escape means it was double-encoded), NUL, or a wrong extension.
 * This is checked on the raw request value before any store or path is touched.
 */
function isInvalidSessionId(id: string): boolean {
	return !id
		|| id.includes("/")
		|| id.includes("\\")
		|| id.includes("%")
		|| id.includes("\0")
		|| !id.endsWith(".jsonl");
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split). The two that closed
// over server module state take it as an explicit first parameter instead.
// ---------------------------------------------------------------------------

/** Format an ISO date string for display; returns "—" on invalid input. */
function safeFormatDate(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "—";
	return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** Pretty JSON.stringify with a fallback for non-serializable values. */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Serialize a parsed session (summary + merged messages) into a review-friendly
 * Markdown document. User turns become `## 🧑 用户`, assistant turns become
 * `## 🤖 助手`; thinking traces and tool calls are folded into `<details>` so
 * the linear reading flow stays clean while the full trace remains available.
 *
 * Images are inlined as data URLs so the exported file is self-contained.
 */
function sessionToMarkdown(
	summary: SessionSummary,
	messages: SessionMessageSummary[],
): string {
	const lines: string[] = [];
	const title = summary.name?.trim() || "未命名对话";
	lines.push(`# ${title}`, "");
	const createdAt = safeFormatDate(summary.createdAt);
	const updatedAt = safeFormatDate(summary.updatedAt);
	const channels = summary.channels.length > 0 ? summary.channels.join("、") : "—";
	lines.push(
		`> 共 ${messages.length} 条消息 · 渠道：${channels}`,
		`> 创建：${createdAt} · 更新：${updatedAt}`,
		`> 导出：${new Date().toISOString()}`,
		"",
		"---",
		"",
	);
	for (const msg of messages) {
		const time = safeFormatDate(new Date(msg.timestamp).toISOString());
		if (msg.role === "user") {
			lines.push(`## 🧑 用户`, "");
			lines.push(`*${time}*`, "");
		} else {
			lines.push(`## 🤖 助手`, "");
			lines.push(`*${time}*`, "");
		}
		if (msg.content.trim()) {
			lines.push(msg.content.trim(), "");
		}
		if (msg.images && msg.images.length > 0) {
			for (const img of msg.images) {
				if (img.previewUrl) {
					lines.push(`![image](${img.previewUrl})`, "");
				}
			}
		}
		if (msg.thinking && msg.thinking.trim()) {
			lines.push(
				"<details><summary>💭 思考过程</summary>",
				"",
				msg.thinking.trim(),
				"",
				"</details>",
				"",
			);
		}
		if (msg.tools && msg.tools.length > 0) {
			for (const tool of msg.tools) {
				const tag = tool.isError ? "❌" : "🔧";
				lines.push(
					`<details><summary>${tag} 工具调用：${tool.toolName}</summary>`,
					"",
					"**参数：**",
					"",
					"```json",
					safeStringify(tool.args),
					"```",
					"",
				);
				if (tool.result !== undefined) {
					lines.push("**结果：**", "", "```json", safeStringify(tool.result), "```", "");
				}
				lines.push("</details>", "");
			}
		}
	}
	return lines.join("\n");
}

/** Derive a session's origin, with backfill for legacy sessions lacking one. */
function deriveOrigin(meta: { channels: SessionChannel[]; origin?: SessionChannel } | undefined): SessionChannel {
	if (meta?.origin) return meta.origin;
	// Legacy backfill: prefer the first non-web channel the session touched
	// (channel-native sessions), otherwise treat it as web.
	const nonWeb = (meta?.channels ?? []).find((c) => c !== "web");
	return nonWeb ?? "web";
}

function withRecordedChannels(summary: SessionSummary, metadata: SessionChannelMetadata): SessionSummary {
	const meta = metadata[summary.id];
	const explicit = meta?.channels ?? [];
	if (explicit.length > 0) {
		// channels.json is the source of truth — merge with content-detected channels
		// but exclude the empty-array fallback from parseSessionFile.
		const contentChannels = summary.channels; // may be [] if nothing detected from JSONL
		return { ...summary, channels: mergeChannels(contentChannels, explicit), origin: deriveOrigin(meta) };
	}
	// No explicit metadata — use content-detected channels, or fall back to "cli"
	// for legacy sessions that predate channel tracking.
	const channels = summary.channels.length > 0 ? summary.channels : ["cli" as SessionChannel];
	return {
		...summary,
		channels,
		origin: deriveOrigin({ channels }),
	};
}

/** Exported for tests — pure merge of a listing summary with recorded topic metadata. */
export function withRecordedTopic(summary: SessionSummary, metadata: SessionTopicMetadata): SessionSummary {
	const recorded = metadata[summary.id];
	const topic = recorded?.topic?.trim();
	if (!topic) return { ...summary, hasTopic: false, topicPendingUpgrade: false };
	// A generated preview is only provisional once the conversation has enough
	// messages for the richer upgrade pass. Legacy generated topics without the
	// upgraded marker remain final until a later turn reaches that threshold.
	const topicPendingUpgrade = recorded.generated === true
		&& recorded.upgraded !== true
		&& summary.messageCount >= TOPIC_UPGRADE_MESSAGE_THRESHOLD;
	return { ...summary, name: topic, hasTopic: true, topicPendingUpgrade };
}


/**
 * /api/sessions* route domain (list/detail/create/delete, export.md,
 * showcase-export, topic, activate, archive). Returns true when the request
 * was handled. Extracted verbatim from server.ts during the P2 route split —
 * behavior unchanged.
 */
export async function handleSessionsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SessionsRouteContext,
): Promise<boolean> {
	const {
		workspaceRegistry,
		dataDir,
		parseSessionFile,
		sessionRevision,
		readSessionChannelMetadata,
		sessionMetaStore,
		learningRecordStore,
		l2DataDir,
		l2Enabled,
		searchL2,
		completeModel,
		checkModelReady,
		currentModel,
		readSessionQuestionMetadata,
		writeSessionQuestionMetadata,
		recordCurrentSessionChannel,
		generateSessionTopic,
		sessionFileFromId,
		releaseQueueFromQuestionBlockedTurn,
		runQueueOpWithTimeout,
	} = ctx;

	// Read-only: never switch the singleton runtime to inspect a different session.
	const contextMatch = matchRoute("GET", method, url, "/api/sessions/:id/context-usage");
	if (contextMatch) {
		const id = contextMatch.id;
		res.setHeader("Cache-Control", "no-store");
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (getCurrentSessionId() !== id) {
			json(res, 200, unavailableContextUsage(id, "inactive"));
			return true;
		}
		json(res, 200, buildContextUsage(id, getSession()));
		return true;
	}

	// --- Learning state API (B2) ---
	// Read the public learning state and the recovery action for the checkpoint.
	const learningGetMatch = matchRoute("GET", method, url, "/api/sessions/:id/learning");
	if (learningGetMatch) {
		const id = decodeURIComponent(learningGetMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		try {
			const state = await learningRecordStore.recoverState(basename(sessionPath), {
				processRunId: PROCESS_RUN_ID,
				maxEvaluationAttempts: MAX_EVALUATION_ATTEMPTS,
			});
			if (!state) {
				json(res, 200, { exists: false });
				return true;
			}
			json(res, 200, { exists: true, ...state });
		} catch (err) {
			if (sendLearningRecordError(res, err)) return true;
			throw err;
		}
		return true;
	}

	// Idempotently initialise the learning record for a session.
	const learningInitMatch = matchRoute("POST", method, url, "/api/sessions/:id/learning");
	if (learningInitMatch) {
		const id = decodeURIComponent(learningInitMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		// E4.7-R1: creating a record is a write. A history-only session keeps the
		// record it already has and gets no new one.
		if (await refusesReadOnlySessionWrite(ctx, basename(sessionPath), res)) return true;
		const body = await readBody(req) as Record<string, unknown>;
		const goalId = typeof body.goalId === "string" && body.goalId ? body.goalId : undefined;
		try {
			const record = await learningRecordStore.create(basename(sessionPath), {
				goalId,
				// Inside the store's write boundary: a concurrent delete wins.
				sessionExists: () => existsSync(sessionPath) && !sessionLifecycle.isBlocked(basename(sessionPath)),
			});
			json(res, 200, {
				checkpoint: {
					revision: record.checkpoint.revision,
					status: record.checkpoint.status,
					step: record.checkpoint.step,
					updated_at: record.checkpoint.updated_at,
				},
			});
		} catch (err) {
			if (sendLearningRecordError(res, err)) return true;
			throw err;
		}
		return true;
	}

	// Pause / resume the checkpoint with optimistic concurrency on its revision.
	const learningPauseMatch = matchRoute("POST", method, url, "/api/sessions/:id/learning/pause");
	const learningResumeMatch = matchRoute("POST", method, url, "/api/sessions/:id/learning/resume");
	if (learningPauseMatch || learningResumeMatch) {
		const match = (learningPauseMatch ?? learningResumeMatch)!;
		const id = decodeURIComponent(match.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		// Pausing/resuming is still a record write; a history-only conversation
		// stays frozen at the state it was archived in.
		if (await refusesReadOnlySessionWrite(ctx, basename(sessionPath), res)) return true;
		const body = await readBody(req) as Record<string, unknown>;
		const expectedRevision = body.revision;
		if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			json(res, 400, { error: "Missing or invalid revision" });
			return true;
		}
		try {
			const record = learningPauseMatch
				? await learningRecordStore.pause(basename(sessionPath), expectedRevision)
				: await learningRecordStore.resume(basename(sessionPath), expectedRevision);
			json(res, 200, {
				checkpoint: {
					revision: record.checkpoint.revision,
					status: record.checkpoint.status,
					step: record.checkpoint.step,
					updated_at: record.checkpoint.updated_at,
				},
			});
		} catch (err) {
			if (sendLearningRecordError(res, err)) return true;
			throw err;
		}
		return true;
	}

	// --- C1: generate a question (knowledge-grounded, atomically persisted) ---
	const learningGenerateMatch = matchRoute("POST", method, url, "/api/sessions/:id/learning/questions/generate");
	if (learningGenerateMatch) {
		const id = decodeURIComponent(learningGenerateMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		// E4.1a: the course context comes from persisted bindings, before the
		// request is parsed, so a derived concept id is scoped to the course and
		// every L2 lookup below uses the same scope. A client-supplied course id
		// is never accepted here — the session binding is the only authority.
		let courseContext: ResolvedCourseContext;
		try {
			courseContext = await resolveCourseContext(ctx.courseStore, basename(sessionPath));
		} catch (err) {
			if (sendCourseContextError(res, err)) return true;
			throw err;
		}
		// E4.7-R1: history-only sessions may be read, not continued. Refuse before
		// parsing the body so no question, L1 evidence or L2 write can happen.
		if (await refusesReadOnlySessionWrite(ctx, basename(sessionPath), res, courseContext)) return true;
		// Read inside a guard: a malformed or oversized body is a client error,
		// exactly as it was when the read happened inside the parse `try`.
		let rawBody: unknown;
		try {
			rawBody = await readBody(req);
		} catch {
			json(res, 400, { error: "invalid_request", message: "请求体无法解析" });
			return true;
		}
		const explicitConceptId = typeof (rawBody as { concept_id?: unknown })?.concept_id === "string"
			? (rawBody as { concept_id: string }).concept_id
			: null;
		let request: QuestionGenerationRequest;
		try {
			request = parseQuestionRequest(rawBody, {
				courseId: courseContext.status === "course" ? courseContext.courseId : null,
			});
		} catch (err) {
			json(res, 400, {
				error: "invalid_request",
				message: err instanceof LearningContractError ? err.message : "请求不合法",
			});
			return true;
		}
		// Reusing an existing L1 concept id is allowed (the UI knows the
		// learner's states), but only inside the course that already owns it.
		// A legacy state without course_id stays usable and stays unclassified.
		if (courseContext.status === "course" && explicitConceptId) {
			let states;
			try {
				states = (await loadProfile(ctx.paths.learnerDataDir)).knowledge_states;
			} catch (err) {
				logger.warn({ err }, "session generate: learner profile unavailable for the concept scope check");
				json(res, 503, { error: "learner_unavailable", message: "学习档案暂不可用，无法校验知识点归属。" });
				return true;
			}
			const compatibility = checkConceptScope(states, request.concept_id, courseContext.courseId);
			if (!compatibility.ok) {
				json(res, 409, {
					error: "concept_course_mismatch",
					message: "该知识点属于另一门课程，不能在当前课程中出题。",
					category: "courses",
				});
				return true;
			}
		}
		const allowedSourceIds = retrievalSourceScope(courseContext);
		let result: QuestionServiceResult;
		try {
			result = await generateAndCommitQuestion({
				learningRecordStore,
				l2DataDir,
				l2Enabled,
				search: searchL2,
				complete: completeModel,
				currentModel,
				// E4.1a: frozen into the question's private provenance and later
				// into the L1 evidence; `undefined` keeps legacy rows unclassified.
				courseId: courseContext.status === "course" ? courseContext.courseId : null,
				allowedSourceIds,
				// Same path the route already validated: a concurrent delete wins.
				sessionExists: () => existsSync(sessionPath) && !sessionLifecycle.isBlocked(basename(sessionPath)),
			}, basename(sessionPath), request);
		} catch (err) {
			if (sendLearningRecordError(res, err)) return true;
			throw err;
		}
		if (!result.ok) {
			json(res, result.status, {
				error: result.error,
				message: result.message,
				...(result.revision !== undefined ? { revision: result.revision } : {}),
			});
			return true;
		}
		json(res, 200, {
			created: result.created,
			question: result.publicQuestion,
			// Full public projection, not a hand-picked subset: continuing to the
			// next question must not drop `last_completed_attempt_id` (history the
			// client keeps for "previous feedback") or the knowledge badge.
			checkpoint: publicCheckpoint(result.record),
			// Source type only: no page path, no excerpt, no answer material.
			knowledge: { kind: result.knowledge },
		});
		return true;
	}

	// --- C2: submit an answer for the current question ---
	const learningAnswerMatch = matchRoute("POST", method, url, "/api/sessions/:id/learning/attempts");
	if (learningAnswerMatch) {
		const id = decodeURIComponent(learningAnswerMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (await refusesReadOnlySessionWrite(ctx, basename(sessionPath), res)) return true;
		let body: unknown;
		try {
			body = await readBody(req);
		} catch (err) {
			json(res, 400, { error: "invalid_request", message: "请求体无法解析" });
			return true;
		}
		const result = await saveAnswer({
			learningRecordStore,
			complete: completeModel,
			processRunId: PROCESS_RUN_ID,
			maxEvaluationAttempts: MAX_EVALUATION_ATTEMPTS,
			sessionExists: () => existsSync(sessionPath) && !sessionLifecycle.isBlocked(basename(sessionPath)),
		}, basename(sessionPath), body);
		if (!result.ok) {
			json(res, result.status, {
				error: result.error,
				message: result.message,
				...(result.revision !== undefined ? { revision: result.revision } : {}),
			});
			return true;
		}
		json(res, 200, {
			created: result.created,
			attempt: {
				attempt_id: result.attempt.attempt_id,
				question_id: result.attempt.question_id,
				question_version: result.attempt.question_version,
				accepted_at: result.attempt.accepted_at,
			},
			checkpoint: {
				revision: result.record.checkpoint.revision,
				status: result.record.checkpoint.status,
				step: result.record.checkpoint.step,
				updated_at: result.record.checkpoint.updated_at,
				pending_attempt_id: result.record.checkpoint.pending_attempt_id,
			},
		});
		return true;
	}

	// --- C2: evaluate a saved answer (model scoring) ---
	const learningEvaluateMatch = matchRoute("POST", method, url, "/api/sessions/:id/learning/attempts/:attemptId/evaluate");
	if (learningEvaluateMatch) {
		const id = decodeURIComponent(learningEvaluateMatch.id);
		const attemptId = decodeURIComponent(learningEvaluateMatch.attemptId);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (await refusesReadOnlySessionWrite(ctx, basename(sessionPath), res)) return true;
		const body = await readBody(req) as Record<string, unknown>;
		const expectedRevision = body.revision;
		if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			json(res, 400, { error: "Missing or invalid revision" });
			return true;
		}
		const retry = body.retry === true;
		const result = await evaluateAttempt({
			learningRecordStore,
			complete: completeModel,
			processRunId: PROCESS_RUN_ID,
			maxEvaluationAttempts: MAX_EVALUATION_ATTEMPTS,
			checkModelReady,
			sessionExists: () => existsSync(sessionPath) && !sessionLifecycle.isBlocked(basename(sessionPath)),
		}, basename(sessionPath), attemptId, expectedRevision, { retry });
		if (!result.ok) {
			json(res, result.status, {
				error: result.error,
				message: result.message,
				...(result.revision !== undefined ? { revision: result.revision } : {}),
			});
			return true;
		}
		// Public assessment: result + score + feedback + criteria + unknown_reason,
		// never the reference answer, rubric weights or the raw model reply.
		json(res, 200, {
			replayed: result.replayed,
			pending_action: result.pendingAction,
			...(result.assessment ? {
				assessment: {
					result: result.assessment.result,
					score: result.assessment.score,
					feedback: result.assessment.feedback,
					...(result.assessment.unknown_reason ? { unknown_reason: result.assessment.unknown_reason } : {}),
					criteria: result.assessment.criteria,
				},
			} : {}),
			checkpoint: {
				revision: result.record.checkpoint.revision,
				status: result.record.checkpoint.status,
				step: result.record.checkpoint.step,
				updated_at: result.record.checkpoint.updated_at,
				pending_attempt_id: result.record.checkpoint.pending_attempt_id,
			},
		});
		return true;
	}

	// --- C3: finalize attempt and record learning evidence ---
	const learningFinalizeMatch = matchRoute("POST", method, url, "/api/sessions/:id/learning/attempts/:attemptId/finalize");
	if (learningFinalizeMatch) {
		const id = decodeURIComponent(learningFinalizeMatch.id);
		const attemptId = decodeURIComponent(learningFinalizeMatch.attemptId);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (await refusesReadOnlySessionWrite(ctx, basename(sessionPath), res)) return true;
		const body = await readBody(req) as Record<string, unknown>;
		const expectedRevision = body.revision;
		if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			json(res, 400, { error: "Missing or invalid revision" });
			return true;
		}
		const result = await finalizeAttempt({
			learningRecordStore,
			learnerDataDir: ctx.paths.learnerDataDir,
			complete: completeModel,
			processRunId: PROCESS_RUN_ID,
			maxEvaluationAttempts: MAX_EVALUATION_ATTEMPTS,
			sessionExists: () => existsSync(sessionPath) && !sessionLifecycle.isBlocked(basename(sessionPath)),
		}, basename(sessionPath), attemptId, expectedRevision);
		if (!result.ok) {
			json(res, result.status, {
				error: result.error,
				message: result.message,
				...(result.revision !== undefined ? { revision: result.revision } : {}),
			});
			return true;
		}
		json(res, 200, {
			replayed: result.replayed,
			profile_version: result.profileVersion,
			attempt: {
				attempt_id: result.attempt.attempt_id,
				stage: result.attempt.progress.stage,
			},
			// Full public projection: the client keeps the question identity and the
			// completion history across the transition to `feedback`.
			checkpoint: publicCheckpoint(result.record),
		});
		return true;
	}

	// --- Sessions API ---
	if (method === "GET" && url === "/api/sessions") {
		const sessionDir = join(dataDir, "sessions");
		const channelMetadata = readSessionChannelMetadata();
		// Corrupt metadata now throws instead of silently becoming an empty map,
		// so listing fails loudly rather than dropping every recorded title.
		const topicMetadata = await sessionMetaStore.readAll();
		const archiveMetadata = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(dataDir), {});
		// E4.7-R1: one course-state read for the whole list. A session's daily
		// visibility is derived from its own archive flag *and* its parent course
		// status; the archive flag itself is never rewritten when a course is
		// archived or restored, so the two states stay independent.
		const courseScopes = ctx.courseStore
			? await ctx.courseStore.sessionCourseScopes().catch(() => new Map())
			: new Map();
		const currentSessionId = getCurrentSessionId();
		const sessions = existsSync(sessionDir)
			? readdirSync(sessionDir)
					.filter((file) => file.endsWith(".jsonl"))
					.map((file) => parseSessionFile(join(sessionDir, file))?.summary)
					.filter((summary): summary is SessionSummary => Boolean(summary))
					.map((summary) => withRecordedChannels(summary, channelMetadata))
					.map((summary) => withRecordedTopic(summary, topicMetadata))
					// A session becomes listable when it has real content, when the learner
					// explicitly managed it, or when it is the open web session. "Managed"
					// covers both archived (`true`) and explicitly restored (`false`): a
					// restored zero-message session must not fall back behind the
					// message-count filter, or its restore would be invisible. Sessions
					// that were never touched keep the old rule, so blank history is not
					// exposed wholesale.
					.filter((summary) => summary.messageCount > 0
						|| archiveMetadata[summary.id] !== undefined
						// E4.8: a course conversation is intentional even before its
						// first message — the workbench lists it so a second "新建对话"
						// cannot orphan the blank one that was just created.
						|| courseScopes.has(summary.id)
						|| (summary.id === currentSessionId && summary.origin === "web"))
					.map((summary) => {
						const archived = archiveMetadata[summary.id] === true;
						const course = courseScopes.get(summary.id) ?? null;
						return {
							...summary,
							archived,
							course,
							// What the daily lists may show; the archive centre uses the
							// two underlying states to explain why a session is hidden.
							daily_visible: !archived && course?.archived !== true,
						};
					})
					.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			: [];
		json(res, 200, sessions);
		return true;
	}

	const exportSessionMatch = matchRoute("GET", method, url, "/api/sessions/:id/export.md");
	if (exportSessionMatch) {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(exportSessionMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
			await sessionMetaStore.readAll(),
		);
		const md = sessionToMarkdown(summary, parsed.messages);
		const baseName = (summary.name?.trim() || summary.id.replace(/\.jsonl$/, "")).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
		res.writeHead(200, {
			"Content-Type": "text/markdown; charset=utf-8",
			"Content-Disposition": contentDispositionAttachment(`${baseName}.md`),
			"Cache-Control": "no-store",
		});
		res.end(md);
		return true;
	}

	const sessionMatch = matchRoute("GET", method, url, "/api/sessions/:id");
	if (sessionMatch) {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(sessionMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const channelMetadata = readSessionChannelMetadata();
		const topicMetadata = await sessionMetaStore.readAll();
		const sessionId = basename(sessionPath);
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, channelMetadata),
			topicMetadata,
		);
		json(res, 200, {
			...summary,
				messages: mergeSessionTraces(
					dataDir,
					sessionId,
					mergeSessionAttachments(dataDir, sessionId, parsed.messages),
				),
			messageCount: parsed.messages.length,
			sessionRevision: sessionRevision(sessionPath),
			// Attach any persisted pending question so the frontend can restore
			// the card after a full process restart (the in-memory turn and its
			// event replay are gone by then).
			pendingQuestion: readSessionQuestionMetadata()[basename(sessionPath)] ?? undefined,
		});
		return true;
	}

	const updateSessionMatch = matchRoute("PATCH", method, url, "/api/sessions/:id");
	if (updateSessionMatch) {
		const id = decodeURIComponent(updateSessionMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const body = await readBody(req) as Record<string, unknown>;
		const topic = typeof body.name === "string" ? body.name.trim() : "";
		if (!topic) {
			json(res, 400, { error: "Missing session topic" });
			return true;
		}
		await sessionMetaStore.setTopic(basename(sessionPath), topic.slice(0, 120), { generated: Boolean(body.generated) });
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
			await sessionMetaStore.readAll(),
		);
		json(res, 200, summary);
		return true;
	}

	const branchBeforeMessageMatch = matchRoute("POST", method, url, "/api/sessions/:id/branch-before-message");
	if (branchBeforeMessageMatch) {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(branchBeforeMessageMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const sessionId = basename(sessionPath);
		const lifecycleState = sessionLifecycle.status(sessionId);
		if (lifecycleState === "deleting") {
			json(res, 409, { error: "session_deleting", id: sessionId });
			return true;
		}
		if (lifecycleState === "deleted") {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Cannot edit a message while the session is generating" });
			return true;
		}
		if (await refusesChatHistoryEdit(ctx, sessionId, res)) return true;
		const body = await readBody(req) as Record<string, unknown>;
		const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
		if (!entryId) {
			json(res, 400, { error: "Missing message entryId" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed?.messages.some((message) => message.role === "user" && message.entryId === entryId)) {
			json(res, 404, { error: "Message entry not found", code: "entry_not_found" });
			return true;
		}

		// An abandoned branch may own a restored question card. Release it before
		// queueing the branch operation. Its persisted UI metadata is removed only
		// after the session branch succeeds.
		releaseQueueFromQuestionBlockedTurn(sessionId);

		try {
			const branched = await runQueueOpWithTimeout(
				req,
				res,
				(options) => branchSessionBeforeUserMessage(sessionPath, entryId, {
					...options,
					// E1.1: the client's earlier `GET /learning` is only a hint. Take
					// B2's writer lock inside the queue slot, decide from the
					// authoritative record, and branch while the lock is still held so
					// no create/commit/finalize can slip into the gap.
					beforeBranch: () => learningRecordStore.withRecordLock(sessionId, (record) => {
						const verdict = evaluateBranchEditSafety(record);
						if (!verdict.allowed) throw new BranchEditRefusedError(verdict.code, verdict.message);
					}),
				}),
			);
			if (branched === null) return true;
			const questions = readSessionQuestionMetadata();
			if (questions[sessionId]) {
				const nextQuestions = { ...questions };
				delete nextQuestions[sessionId];
				writeSessionQuestionMetadata(nextQuestions);
			}
			json(res, 200, { sessionId, ...branched, sessionRevision: sessionRevision(sessionPath) });
		} catch (err) {
			if (err instanceof BranchEditRefusedError) {
				json(res, 409, { error: err.code, code: err.code, message: err.message });
				return true;
			}
			if (err instanceof SessionUnavailableError) {
				json(res, err.reason === "deleting" ? 409 : 404, err.reason === "deleting"
					? { error: "session_deleting", id: sessionId }
					: { error: "Session not found" });
				return true;
			}
			if (err instanceof SessionEditError) {
				const status = err.code === "entry_not_found" ? 404 : 409;
				json(res, status, { error: err.message, code: err.code });
				return true;
			}
			if (sendLearningRecordError(res, err)) return true;
			throw err;
		}
		return true;
	}

	const generateSessionTopicMatch = matchRoute("POST", method, url, "/api/sessions/:id/generate-topic");
	if (generateSessionTopicMatch) {
		const id = decodeURIComponent(generateSessionTopicMatch.id);
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const parsed = parseSessionFile(sessionPath);
		if (!parsed) {
			json(res, 422, { error: "Unable to parse session" });
			return true;
		}
		const topic = await generateSessionTopic(parsed.summary, parsed.messages);
		const sessionId = basename(sessionPath);
		try {
			await sessionMetaStore.setTopic(sessionId, topic, {
				generated: true,
				upgraded: true,
				// Checked inside meta.json's write boundary: the session may have
				// been deleted while the title model call was in flight, and this
				// late write must not create an orphan entry for it.
				sessionExists: () => existsSync(sessionPath) && !sessionLifecycle.isBlocked(sessionId),
			});
		} catch (err) {
			if (err instanceof SessionMetaError && err.code === "META_SESSION_GONE") {
				json(res, 404, { error: "Session not found" });
				return true;
			}
			throw err;
		}
		const summary = withRecordedTopic(
			withRecordedChannels(parsed.summary, readSessionChannelMetadata()),
			await sessionMetaStore.readAll(),
		);
		json(res, 200, summary);
		return true;
	}

	const activateSessionMatch = matchRoute("POST", method, url, "/api/sessions/:id/activate");
	if (activateSessionMatch) {
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), decodeURIComponent(activateSessionMatch.id));
		if (!sessionPath || !existsSync(sessionPath)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		const sessionId = basename(sessionPath);
		const unavailable = sessionLifecycle.status(sessionId);
		if (unavailable === "deleting") {
			json(res, 409, { error: "session_deleting", id: sessionId });
			return true;
		}
		if (unavailable === "deleted") {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		// If the queue is held by another session's question-blocked turn,
		// abort it first — otherwise this switch could wait up to 30 min.
		releaseQueueFromQuestionBlockedTurn(sessionId);
		let switched: true | null;
		try {
			switched = await runQueueOpWithTimeout(
				req,
				res,
				(options) => switchSessionFile(sessionPath, options).then(() => true as const),
			);
		} catch (err) {
			// The delete lease may have started while this waited for the queue.
			if (err instanceof SessionUnavailableError) {
				json(res, err.reason === "deleting" ? 409 : 404, err.reason === "deleting"
					? { error: "session_deleting", id: sessionId }
					: { error: "Session not found" });
				return true;
			}
			throw err;
		}
		if (switched === null) return true; // 409 session_busy already sent (or client gone)
		json(res, 200, { id: sessionId, active: getCurrentSessionId() === sessionId });
		return true;
	}

	if (method === "POST" && url === "/api/sessions") {
		const body = await readBody(req).catch((err: unknown) => {
			// An oversized body must still surface as 413 — only a missing or
			// malformed payload is treated as {}.
			if (err instanceof HttpError && err.statusCode === 413) throw err;
			return {};
		}) as Record<string, unknown>;
		// Workspace selection is gone; an old client asking for one gets a clear 403.
		if (body.presetId || body.newWorkspace || body.workspaceId) {
			json(res, 403, { error: "capability_disabled", capability: "workspaceFiles" }); return true;
		}

		// A new session is always a different session — release the queue
		// from a question-blocked turn before enqueueing (issue #124).
		releaseQueueFromQuestionBlockedTurn("");
		const id = await runQueueOpWithTimeout(req, res, (options) => createNewSession(options));
		if (id === null) return true; // 409 session_busy already sent (or client gone)
		// This endpoint is exclusively the Web UI's session-creation path.
		// Record the origin immediately so Simple Mode includes the new empty
		// session before the first assistant response has finished streaming.
		recordCurrentSessionChannel("web", id, { setOriginIfEmpty: true });

		// Learning sessions always run in the shared temp workspace: the product
		// no longer exposes workspace selection or preset distribution.
		const workspaceId: string = TEMP_WORKSPACE_ID;
		// Creation has already started and now owns its consistency work.
		// Finish the workspace binding even if the original HTTP client left.
		try {
			workspaceRegistry.bindSession(id, workspaceId);
			// Apply the new workspace cwd to the active runtime so the agent's
			// tools (read/write/bash) operate inside the bound directory.
			const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
			if (sessionPath) {
				await applyWorkspaceCwd(sessionPath, { onlyIfCurrent: true });
			}
		} catch (err) {
			logger.warn({ err }, `failed to bind workspace for session ${id}`);
		}

		json(res, 201, { id, active: getCurrentSessionId() === id, workspaceId });
		return true;
	}

	const deleteSessionMatch = matchRoute("DELETE", method, url, "/api/sessions/:id");
	if (deleteSessionMatch) {
		// `matchRoute` already percent-decodes the param. Decoding again would let a
		// double-encoded value (%252F) smuggle a path segment through, and deriving
		// the session id with `basename()` would silently downgrade an illegal id
		// (e.g. "/s1.jsonl") into a different, legal session. Validate the raw id
		// first and refuse it outright: no store is touched for an illegal request.
		const id = deleteSessionMatch.id;
		if (isInvalidSessionId(id)) {
			json(res, 400, { error: "Invalid session id" });
			return true;
		}
		if (streamRegistry.getActiveForSession(id)) {
			json(res, 409, { error: "Cannot delete a session with an active chat turn" });
			return true;
		}
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath) {
			// Defence in depth: a canonical id that still escapes the sessions dir.
			json(res, 400, { error: "Invalid session id" });
			return true;
		}
		// The validated id is already canonical (sessionFileFromId enforces
		// basename(id) === id); never re-derive it from a path.
		const sessionId = id;
		const fileExists = existsSync(sessionPath);
		// E4.7-R2a: a previous attempt may have removed the chat/B2/title but left
		// a sidecar. The marker is what turns a retry into cleanup instead of 404.
		const pendingCleanup = readSessionCleanup(dataDir, sessionId);

		// E4.7-R2: an explicit `createReplacement=true` is the learner's own
		// confirmation ("delete this conversation and start a blank one"). Only
		// that flag lets the server create a successor when no existing
		// conversation can take over; without it the old 409 stands, so no
		// replacement is ever created silently. The body is optional — an older
		// client sends none.
		const deleteBody = await readBody(req).catch((err: unknown) => {
			if (err instanceof HttpError && err.statusCode === 413) throw err;
			return {} as Record<string, unknown>;
		}) as Record<string, unknown>;
		const createReplacement = deleteBody.createReplacement === true;

		// A retry after a partial delete finds no chat file but may still have the
		// authoritative learning record or the metadata entry. Those are leftovers
		// to finish cleaning, not a 404 — and an id with no leftovers at all is a
		// genuine 404.
		if (!fileExists) {
			const hasMeta = (await sessionMetaStore.get(sessionId).catch(() => undefined)) !== undefined;
			// Probe the authoritative file directly: a corrupt record still counts
			// as a leftover to clean, and reading it would throw.
			const hasLearning = existsSync(join(learningRecordStore.dir, `${sessionId}.json`));
			if (!hasMeta && !hasLearning && !pendingCleanup) {
				json(res, 404, { error: "Session not found" });
				return true;
			}
		}

		// Deleting any session file is a runtime-boundary operation, not just a
		// filesystem unlink. The lease is the single owner of this deletion;
		// whether the runtime is actually on A is decided inside the Agent queue
		// below, because an activate(A) may be queued ahead of us or paused
		// inside switchSession.
		const alreadyDeleted = sessionLifecycle.isDeleted(sessionId);
		// E4.7-R2a: a retry for a session whose chat file is already gone must only
		// finish cleanup. Re-entering the runtime hand-off could create a second
		// blank successor (or rebind the runtime to a conversation that should not
		// exist any more).
		const skipRuntimeHandoff = !fileExists && (alreadyDeleted || pendingCleanup !== undefined);
		let lease: SessionDeletionLease | null = null;
		if (!alreadyDeleted) {
			try {
				lease = sessionLifecycle.beginDeletion(sessionId);
			} catch (err) {
				if (err instanceof SessionUnavailableError) {
					json(res, 409, { error: "session_deleting", id: sessionId, message: "该会话正在删除中。" });
					return true;
				}
				throw err;
			}
		}

		let newActiveId: string | null = null;
		let replacedWith: "existing" | "created" | null = null;
		let filesRemoved = false;
		try {
			// `fileExists` decides whether there is anything to unlink; it does
			// not decide whether the runtime is on A. The queue-time check below
			// is authoritative for that, so a stale false cannot cause a direct
			// unlink under a paused switchSession(A).
			if (!skipRuntimeHandoff && (fileExists || getCurrentSessionId() === sessionId)) {
				// Release a question card owned by the current session so the delete
				// does not wait for its 30-minute timeout. For a non-active delete,
				// only a blocker belonging to that same session is released.
				releaseQueueFromQuestionBlockedTurn(getCurrentSessionId() === sessionId ? "" : sessionId);
				const plan: SessionDeletionPlan = {
					// Runs inside the queue slot: candidates that became archived,
					// deleting or deleted while we waited are filtered here.
					selectReplacement: async () => {
						const archiveMetadata = readJson<Record<string, boolean>>(
							sessionArchiveMetadataPath(dataDir), {},
						);
						// E4.7-R2a: a conversation hidden with its archived parent
						// course is not a legal daily target. The file scan cannot see
						// the course state, so read it here (same queue slot, one
						// snapshot). If that read fails, exclude every candidate
						// rather than risk switching into a hidden course.
						let archivedCourseSessions: Set<string> | null = new Set();
						if (ctx.courseStore) {
							archivedCourseSessions = await ctx.courseStore.sessionCourseScopes()
								.then((scopes) => new Set(
									[...scopes]
										.filter(([, course]) => course.archived)
										.map(([id]) => id),
								))
								.catch((err) => {
									logger.warn({ err }, "session delete: course scope unreadable, refusing existing replacements");
									return null;
								});
						}
						return selectReplacementSession({
							sessionsDir: join(dataDir, "sessions"),
							excludeId: sessionId,
							archiveMetadata,
							parseSessionFile: ctx.parseSessionFile,
							isBlocked: (candidate) => sessionLifecycle.isBlocked(candidate),
							isExcluded: (candidate) => archivedCourseSessions === null
								|| archivedCourseSessions.has(candidate),
						});
					},
					// Runs once before the SDK switch and again after it: a B that
					// was archived/deleted during the asynchronous switch must not
					// authorise deleting A. E4.7-R2a re-reads the parent course for
					// the same reason.
					validateReplacement: async (replacement) => {
						if (sessionLifecycle.isBlocked(replacement.id)) {
							throw new SessionUnavailableError(replacement.id, "ineligible");
						}
						if (!existsSync(replacement.path)) {
							throw new SessionUnavailableError(replacement.id, "missing");
						}
						const currentArchives = readJson<Record<string, boolean>>(
							sessionArchiveMetadataPath(dataDir), {},
						);
						if (currentArchives[replacement.id] === true) {
							throw new SessionUnavailableError(replacement.id, "ineligible");
						}
						if (!ctx.courseStore) return;
						const scopes = await ctx.courseStore.sessionCourseScopes().catch((err) => {
							logger.warn({ err, replacementId: replacement.id }, "session delete: course scope re-check failed");
							throw new SessionUnavailableError(replacement.id, "ineligible");
						});
						if (scopes.get(replacement.id)?.archived === true) {
							throw new SessionUnavailableError(replacement.id, "ineligible");
						}
					},
					// E4.7-R2: only an explicit confirmation reaches this branch.
					// Creation runs in the same queue slot as the switch and the
					// unlink, so the runtime is provably on the blank session before
					// the original file is removed.
					...(createReplacement ? {
						createReplacement: async () => {
							const createdId = await createNewSessionInQueueSlot();
							const createdPath = sessionFileFromId(join(dataDir, "sessions"), createdId);
							if (!createdPath) {
								throw new SessionUnavailableError(createdId, "missing");
							}
							return { id: createdId, path: createdPath };
						},
					} : {}),
				};

				let outcome: Awaited<ReturnType<typeof deleteSessionFileInQueue>> | null;
				try {
					outcome = await runQueueOpWithTimeout(req, res, (options) =>
						deleteSessionFileInQueue(sessionId, sessionPath, plan, options));
				} catch (err) {
					if (err instanceof NoReplacementSessionError) {
						// D4: the SDK has no supported "no session" state and this route
						// never creates a hidden replacement. E4.7-R2: the client may
						// retry with an explicit `createReplacement: true` after the
						// learner confirmed "delete this last conversation and start a
						// blank one".
						json(res, 409, {
							error: "no_replacement_session",
							id: sessionId,
							message: "这是当前唯一的会话。确认删除并新建空白对话后可以继续。",
							requiresExplicitChoice: true,
						});
						return true;
					}
					if (err instanceof ReplacementCreationError) {
						// The learner asked for a blank successor; creation failed. The
						// original session is untouched and the request can be retried.
						logger.warn({ err, sessionId }, "session delete: blank replacement creation failed");
						json(res, 500, {
							error: "replacement_create_failed",
							id: sessionId,
							deleted: false,
							message: "无法新建空白会话，原会话已保留，请重试。",
							retryable: true,
						});
						return true;
					}
					if (err instanceof SessionUnavailableError) {
						logger.warn({ err, sessionId }, "session delete: replacement unavailable");
						json(res, 409, {
							error: "replacement_unavailable",
							id: sessionId,
							message: "准备切换到的会话已不可用，当前会话已保留，请重试。",
							retryable: true,
						});
						return true;
					}
					throw err;
				}
				if (outcome === null) return true; // 409 session_busy already sent
				newActiveId = outcome.newActiveId;
				replacedWith = outcome.tookOver
					? (outcome.createdReplacement ? "created" : "existing")
					: null;
				filesRemoved = true;
			} else {
				// No chat file and the runtime is not bound to it: only metadata
				// leftovers remain.
				filesRemoved = true;
			}

			// From here on the id is permanently unusable in this process, even
			// after the `deleting` marker is cleared.
			if (lease) sessionLifecycle.completeDeletion(lease);

			// E4.7-R2a: initialise the blank successor before anything about the old
			// session can fail. Its channel/origin and workspace binding belong to B,
			// not to A's cleanup; skipping them because A's B2 was locked would leave
			// an unusable "blank" conversation. A retry repeats this idempotently.
			const cleanupFailures: string[] = [];
			const replacementToFinish = newActiveId ?? pendingCleanup?.new_active_id ?? null;
			if (replacementToFinish && (replacedWith === "created" || pendingCleanup?.new_active_id)) {
				if (!(await initializeReplacementSession(ctx, replacementToFinish))) {
					cleanupFailures.push("replacement_init");
				}
			}

			// Authoritative cleanup runs outside the Agent queue, preserving the
			// Agent -> B2 lock order. Never await the queue while holding a B2 lock.
			//
			// E4.7-R2a: the chat file is already gone by now. A cleanup failure is
			// therefore a *partial* delete, not "nothing happened": report the real
			// state so the client removes the conversation and retries the cleanup
			// instead of showing a session that no longer exists. Both owners are
			// attempted; one failure must not skip the other.
			try {
				await learningRecordStore.remove(sessionId);
			} catch (err) {
				logger.warn({ err, sessionId }, "session delete: learning record cleanup failed");
				cleanupFailures.push("learning_record");
			}
			try {
				// Same owner as title updates: a direct read-modify-write here would
				// drop a concurrent title write that landed in between.
				await sessionMetaStore.remove(sessionId);
			} catch (err) {
				logger.warn({ err, sessionId }, "session delete: session metadata cleanup failed");
				cleanupFailures.push("session_meta");
			}

			// Every sidecar is independent: one failure must not skip the rest, and
			// the returned names drive both the response and the retry marker.
			cleanupFailures.push(...await cleanupSessionSidecars(ctx, sessionId));

			if (cleanupFailures.length > 0) {
				// Persist exactly what is left, so a retry (even after a restart)
				// finds the session instead of 404 and does not create another B.
				await writeSessionCleanup(dataDir, sessionId, cleanupFailures, replacementToFinish);
				json(res, 500, {
					error: "session_cleanup_failed",
					id: sessionId,
					deleted: filesRemoved,
					partial: true,
					newActiveId: replacementToFinish,
					replacedWith,
					cleanup_failures: cleanupFailures,
					retryable: true,
					message: filesRemoved
						? "会话聊天已删除，但部分清理未完成；重试会继续清理，不会恢复会话。"
						: "会话清理未完成，原会话仍保留。",
				});
				return true;
			}

			// Nothing is left: drop the marker so a later id with the same name
			// cannot inherit a stale cleanup task.
			await clearSessionCleanup(dataDir, sessionId);
			json(res, 200, { id: sessionId, deleted: true, newActiveId, replacedWith, cleanup: "complete" });
			return true;
		} catch (err) {
			logger.warn({ err, sessionId }, "session delete: runtime hand-off failed");
			json(res, 500, { error: "session_switch_failed", id: sessionId, deleted: false, retryable: true });
			return true;
		} finally {
			// No file was removed: release the id so the learner can retry.
			if (lease && !filesRemoved) sessionLifecycle.abortDeletion(lease);
		}
	}

	// --- Session Archive ---
	// Both routes share one validation path: decode once (`matchRoute` already
	// did), refuse illegal ids before touching any store, and require the
	// session file to exist so no metadata is written for an imaginary session.
	// Repeated archive/unarchive is idempotent and still returns 200.
	const archiveMatch = matchRoute("POST", method, url, "/api/sessions/:id/archive");
	const unarchiveMatch = matchRoute("POST", method, url, "/api/sessions/:id/unarchive");
	if (archiveMatch || unarchiveMatch) {
		const archiving = Boolean(archiveMatch);
		const id = (archiveMatch ?? unarchiveMatch)!.id;
		if (isInvalidSessionId(id)) {
			json(res, 400, { error: "Invalid session id" });
			return true;
		}
		const sessionPath = sessionFileFromId(join(dataDir, "sessions"), id);
		if (!sessionPath) {
			json(res, 400, { error: "Invalid session id" });
			return true;
		}
		// A live turn owns this file; hiding it mid-answer would silently drop the
		// interaction from the learner's view. Ask them to finish or stop first.
		if (archiving && streamRegistry.getActiveForSession(id)) {
			json(res, 409, { error: "Cannot archive a session with an active chat turn" });
			return true;
		}
		// E4.7-R1: restoring a session cannot bypass its parent course. While the
		// course is archived the conversation stays hidden with it; clearing the
		// session's own flag would only pretend otherwise.
		if (!archiving && ctx.courseStore) {
			const context = await ctx.courseStore.getSessionContext(id).catch(() => undefined);
			if (context?.course.status === "archived") {
				json(res, 409, {
					error: "course_archived",
					message: "所属课程已归档，请先在「系统设置 → 归档课程」恢复课程，再恢复该会话。",
					category: "courses",
				});
				return true;
			}
		}
		const applied = await withArchiveMetadataLock(() => {
			// Re-checked inside the lock: a delete that already removed the file wins
			// over this archive instead of leaving a ghost entry behind.
			if (!existsSync(sessionPath)) return false;
			const archiveMeta = readJson<Record<string, boolean>>(sessionArchiveMetadataPath(dataDir), {});
			const state = archiveMeta[id];
			if (archiving) {
				if (state === true) return true;
				archiveMeta[id] = true;
			} else {
				// Restoring keeps an explicit `false`: the list uses it to bring a
				// zero-message session back without exposing never-used blank ones.
				// A session that was never archived gets no marker at all.
				if (state !== true) return true;
				archiveMeta[id] = false;
			}
			writeJson(sessionArchiveMetadataPath(dataDir), archiveMeta);
			return true;
		});
		if (!applied) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		json(res, 200, { id, archived: archiving });
		return true;
	}

	return false;
}
