import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueTaskCancelledError, type QueueTaskOptions } from "../../agent/session-queue.js";
import type { SessionDeletionPlan } from "../../agent/pi-runner.js";
import {
	NoReplacementSessionError,
	ReplacementCreationError,
	sessionLifecycle,
	SessionUnavailableError,
} from "../../agent/session-lifecycle.js";
import { runQueuedHttpOperation } from "../queued-operation.js";
import { handleChatRoutes, type ChatRouteContext } from "./chat.js";
import { handleSessionsRoutes, type SessionsRouteContext } from "./sessions.js";

const runner = vi.hoisted(() => ({
	getCurrentSessionId: vi.fn(),
	deleteSessionFileInQueue: vi.fn(),
	createNewSession: vi.fn(),
	createNewSessionInQueueSlot: vi.fn(),
	switchSessionFile: vi.fn(),
	branchSessionBeforeUserMessage: vi.fn(),
	applyWorkspaceCwd: vi.fn(),
	getSession: vi.fn(),
	runPromptInSession: vi.fn(),
	runPromptSerialized: vi.fn(),
	runPromptStreamingInSession: vi.fn(),
	abortPromptForTurnToken: vi.fn(),
	getLoadedSkills: vi.fn(),
	persistCancelledQueuedTurn: vi.fn(),
	persistPendingUserTurn: vi.fn(),
}));

vi.mock("../../agent/pi-runner.js", () => ({
	...runner,
	SessionEditError: class extends Error {},
}));

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

let dataDir: string;
let sessionDir: string;
let seq = 0;
let aId: string, bId: string, aPath: string, bPath: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "inno-delete-races-"));
	sessionDir = join(dataDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(join(dataDir, "learning"), { recursive: true });
	const prefix = `s${++seq}`;
	aId = `${prefix}a.jsonl`;
	bId = `${prefix}b.jsonl`;
	aPath = join(sessionDir, aId);
	bPath = join(sessionDir, bId);
	writeFileSync(aPath, "");
	writeFileSync(bPath, "");
	vi.clearAllMocks();
	runner.getCurrentSessionId.mockReturnValue(aId);
	// Default: the route's queue task selects B (or creates a blank successor when
	// the plan allows it), validates it, and unlinks A.
	runner.deleteSessionFileInQueue.mockImplementation(async (id: string, activePath: string, plan: SessionDeletionPlan) => {
		if (runner.getCurrentSessionId() !== id) {
			unlinkSync(activePath);
			return { tookOver: false, newActiveId: null };
		}
		const existing = await plan.selectReplacement();
		if (!existing) {
			if (!plan.createReplacement) throw new NoReplacementSessionError(id);
			const created = await plan.createReplacement();
			unlinkSync(activePath);
			return { tookOver: true, newActiveId: created.id, createdReplacement: true };
		}
		await plan.validateReplacement(existing);
		unlinkSync(activePath);
		return { tookOver: true, newActiveId: existing.id };
	});
});

afterEach(async () => {
	if (dirname(dataDir) !== resolve(tmpdir()) || !basename(dataDir).startsWith("inno-delete-races-")) {
		throw new Error("Unexpected race test cleanup path");
	}
	await rm(dataDir, { recursive: true, force: true });
});

function responseFixture() {
	return Object.assign(new EventEmitter(), {
		destroyed: false,
		writableFinished: false,
		writableEnded: false,
		writeHead: vi.fn(),
		end: vi.fn(),
	});
}

function bodyOf(res: ReturnType<typeof responseFixture>): Record<string, unknown> {
	const payload = res.end.mock.calls.at(-1)?.[0];
	return typeof payload === "string" ? JSON.parse(payload) as Record<string, unknown> : {};
}

function requestFixture(body?: unknown) {
	const req = new PassThrough() as PassThrough & IncomingMessage;
	req.headers = {};
	if (body !== undefined) req.end(JSON.stringify(body));
	else req.end();
	return req;
}

function sessionsContext(
	timeoutMs?: number,
	courseScopes?: Map<string, { course_id: string; title: string; archived: boolean }>,
): SessionsRouteContext {
	return {
		dataDir,
		...(courseScopes ? {
			courseStore: {
				sessionCourseScopes: vi.fn(async () => courseScopes),
				removeSessionBinding: vi.fn(async () => undefined),
			},
		} : {}),
		paths: {},
		workspaceRegistry: { getWorkspace: vi.fn(), bindSession: vi.fn(() => true) },
		parseSessionFile: (filePath: string) => ({
			summary: {
				id: basename(filePath),
				name: basename(filePath),
				createdAt: "2026-11-01T00:00:00.000Z",
				updatedAt: basename(filePath) === bId ? "2026-11-02T00:00:00.000Z" : "2026-11-01T00:00:00.000Z",
				messageCount: 2,
				preview: "hello",
				channels: ["web"],
				origin: "web",
			},
			messages: [],
		}),
		sessionRevision: () => "0:0",
		readSessionChannelMetadata: () => ({}),
		sessionChannelMetadataPath: () => join(sessionDir, "channels.json"),
		sessionMetaStore: { get: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), readAll: vi.fn(async () => ({})) },
		learningRecordStore: { dir: join(dataDir, "learning"), remove: vi.fn(async () => undefined) },
		l2DataDir: join(dataDir, "l2"),
		l2Enabled: false,
		searchL2: null,
		completeModel: vi.fn(),
		checkModelReady: vi.fn(async () => false),
		recordCurrentSessionChannel: vi.fn(),
		readSessionQuestionMetadata: () => ({}),
		writeSessionQuestionMetadata: vi.fn(),
		releaseQueueFromQuestionBlockedTurn: vi.fn(),
		sessionFileFromId: (_dir: string, id: string) => id === aId ? aPath : id === bId ? bPath : null,
		runQueueOpWithTimeout: (_req: IncomingMessage, response: ServerResponse, op: (options: QueueTaskOptions) => Promise<unknown>) =>
			runQueuedHttpOperation(response, op, { timeoutMs, getQueueBlocker: () => null }),
	} as unknown as SessionsRouteContext;
}

function chatContext(): ChatRouteContext {
	return {
		dataDir,
		paths: { workspaceDir: join(dataDir, "workspace") },
		workspaceRegistry: {
			getSessionWorkspaceId: () => "temp",
			resolveWorkspaceDir: () => join(dataDir, "workspace"),
		},
		sessionFileFromId: (_dir: string, id: string) => id === aId ? aPath : id === bId ? bPath : null,
		releaseQueueFromQuestionBlockedTurn: vi.fn(),
		readSessionQuestionMetadata: () => ({}),
		writeSessionQuestionMetadata: vi.fn(),
		recordCurrentSessionChannel: vi.fn(),
		maybeAutoGenerateTopic: vi.fn(),
		parseSessionFile: () => null,
		sessionRevision: () => "0:0",
	} as unknown as ChatRouteContext;
}

/** A delete task that blocks on a controllable gate and honours queue aborts. */
function installBlockedReplace(gate: Promise<void>) {
	runner.deleteSessionFileInQueue.mockImplementation((_id: string, activePath: string, replacement: { id: string }, options?: QueueTaskOptions) => {
		return new Promise((resolvePromise, reject) => {
			const onAbort = () => reject(new QueueTaskCancelledError());
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			void gate.then(() => {
				options?.signal?.removeEventListener("abort", onAbort);
				unlinkSync(activePath);
				resolvePromise({ newActiveId: replacement.id });
			});
		});
	});
}

const deleteUrl = () => `/api/sessions/${aId}`;
const activateUrl = () => `/api/sessions/${aId}/activate`;

describe("DELETE active session under concurrency", () => {
	it("refuses activate and explicit chat while the delete lease is held", async () => {
		const gate = deferred<void>(), started = deferred<void>();
		runner.deleteSessionFileInQueue.mockImplementation(async (id: string, activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = await plan.selectReplacement();
			if (!replacement) return Promise.reject(new NoReplacementSessionError(id));
			await plan.validateReplacement(replacement);
			return new Promise((resolvePromise, reject) => {
				const onAbort = () => reject(new QueueTaskCancelledError());
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				void gate.promise.then(() => {
					options?.signal?.removeEventListener("abort", onAbort);
					unlinkSync(activePath);
					resolvePromise({ tookOver: true, newActiveId: replacement.id });
				});
			});
		});

		const deleteRes = responseFixture();
		const deleting = handleSessionsRoutes(
			requestFixture(), deleteRes as unknown as ServerResponse, "DELETE", deleteUrl(), sessionsContext(),
		);
		await started.promise;

		const activateRes = responseFixture();
		await handleSessionsRoutes(
			requestFixture(), activateRes as unknown as ServerResponse,
			"POST", activateUrl(), sessionsContext(),
		);
		expect(activateRes.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(bodyOf(activateRes).error).toBe("session_deleting");
		expect(runner.switchSessionFile).not.toHaveBeenCalled();

		const chatRes = responseFixture();
		await handleChatRoutes(
			requestFixture({ sessionId: aId, prompt: "must not be written" }),
			chatRes as unknown as ServerResponse, "POST", "/api/chat", chatContext(),
		);
		expect(chatRes.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(bodyOf(chatRes).error).toBe("session_deleting");
		expect(runner.runPromptInSession).not.toHaveBeenCalled();
		expect(runner.runPromptSerialized).not.toHaveBeenCalled();

		gate.resolve();
		await deleting;
		expect(existsSync(aPath)).toBe(false);
		expect(bodyOf(deleteRes)).toMatchObject({ id: aId, deleted: true, newActiveId: bId, replacedWith: "existing" });
		// The tombstone keeps A unactivatable even after the lease is cleared.
		expect(sessionLifecycle.isDeleted(aId)).toBe(true);
		const lateActivate = responseFixture();
		await handleSessionsRoutes(
			requestFixture(), lateActivate as unknown as ServerResponse,
			"POST", activateUrl(), sessionsContext(),
		);
		expect(lateActivate.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
		expect(runner.switchSessionFile).not.toHaveBeenCalled();
	});

	it("runs B2 cleanup only after the runtime hand-off leaves the queue", async () => {
		const gate = deferred<void>(), started = deferred<void>();
		runner.deleteSessionFileInQueue.mockImplementation(async (id: string, activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = await plan.selectReplacement();
			if (!replacement) return Promise.reject(new NoReplacementSessionError(id));
			await plan.validateReplacement(replacement);
			return new Promise((resolvePromise, reject) => {
				const onAbort = () => reject(new QueueTaskCancelledError());
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				void gate.promise.then(() => {
					options?.signal?.removeEventListener("abort", onAbort);
					unlinkSync(activePath);
					resolvePromise({ tookOver: true, newActiveId: replacement.id });
				});
			});
		});
		const ctx = sessionsContext();
		const remove = ctx.learningRecordStore.remove as unknown as ReturnType<typeof vi.fn>;
		const res = responseFixture();
		const deleting = handleSessionsRoutes(requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(), ctx);
		await started.promise;
		// The Agent queue slot is still open; B2 must not be touched yet.
		expect(remove).not.toHaveBeenCalled();
		gate.resolve();
		await deleting;
		expect(remove).toHaveBeenCalledWith(aId);
	});

	it("routes a non-active file deletion through the Agent queue without touching the runtime", async () => {
		runner.getCurrentSessionId.mockReturnValue(bId);
		const res = responseFixture();
		await handleSessionsRoutes(requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(), sessionsContext());
		expect(runner.deleteSessionFileInQueue).toHaveBeenCalledTimes(1);
		expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({ id: aId, deleted: true, newActiveId: null, replacedWith: null });
		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
		expect(runner.switchSessionFile).not.toHaveBeenCalled();
	});

	it("returns no_replacement_session without creating a session when no B is eligible", async () => {
		unlinkSync(bPath);
		const res = responseFixture();
		await handleSessionsRoutes(requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(), sessionsContext());
		expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({ error: "no_replacement_session", requiresExplicitChoice: true });
		expect(runner.deleteSessionFileInQueue).toHaveBeenCalledTimes(1);
		expect(runner.createNewSession).not.toHaveBeenCalled();
		expect(runner.createNewSessionInQueueSlot).not.toHaveBeenCalled();
		expect(existsSync(aPath)).toBe(true);
	});

	it("deletes the last session and enters a new blank one when the client confirms", async () => {
		unlinkSync(bPath);
		const createdPath = join(sessionDir, `s${seq}new.jsonl`);
		writeFileSync(createdPath, "");
		runner.createNewSessionInQueueSlot.mockImplementation(async () => {
			runner.getCurrentSessionId.mockReturnValue(basename(createdPath));
			return basename(createdPath);
		});
		const ctx = sessionsContext();
		// The created file must resolve through the route's id -> path helper, and
		// a blank session is never an eligible existing replacement (messageCount 0).
		ctx.sessionFileFromId = (_dir: string, id: string) =>
			id === aId ? aPath : id === bId ? bPath : id === basename(createdPath) ? createdPath : null;
		ctx.parseSessionFile = (filePath: string) => {
			const id = basename(filePath);
			if (id === basename(createdPath)) return null;
			return (sessionsContext().parseSessionFile as (path: string) => unknown)(filePath) as never;
		};

		const res = responseFixture();
		await handleSessionsRoutes(
			requestFixture({ createReplacement: true }),
			res as unknown as ServerResponse,
			"DELETE", deleteUrl(), ctx,
		);

		expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({
			id: aId,
			deleted: true,
			newActiveId: basename(createdPath),
			replacedWith: "created",
		});
		// Original gone, blank successor present and registered like any web session.
		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(createdPath)).toBe(true);
		expect(ctx.recordCurrentSessionChannel).toHaveBeenCalledWith("web", basename(createdPath), { setOriginIfEmpty: true });
		expect(ctx.workspaceRegistry.bindSession).toHaveBeenCalledWith(basename(createdPath), expect.any(String));
		// The old session's authoritative record is still cleaned by the same path.
		expect(ctx.learningRecordStore.remove).toHaveBeenCalledWith(aId);
	});

	it("keeps the last session when the blank successor cannot be created", async () => {
		unlinkSync(bPath);
		runner.deleteSessionFileInQueue.mockRejectedValueOnce(new ReplacementCreationError(aId));
		const res = responseFixture();
		await handleSessionsRoutes(
			requestFixture({ createReplacement: true }),
			res as unknown as ServerResponse,
			"DELETE", deleteUrl(), sessionsContext(),
		);
		expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({ error: "replacement_create_failed", deleted: false, retryable: true });
		expect(existsSync(aPath)).toBe(true);
		expect(sessionLifecycle.isDeleting(aId)).toBe(false);
		expect(sessionLifecycle.isDeleted(aId)).toBe(false);
	});

	it("creates at most one blank successor for two concurrent deletes of the last session", async () => {
		unlinkSync(bPath);
		const createdPath = join(sessionDir, `s${seq}new.jsonl`);
		writeFileSync(createdPath, "");
		runner.createNewSessionInQueueSlot.mockImplementation(async () => {
			runner.getCurrentSessionId.mockReturnValue(basename(createdPath));
			return basename(createdPath);
		});
		const ctx = sessionsContext();
		ctx.sessionFileFromId = (_dir: string, id: string) =>
			id === aId ? aPath : id === bId ? bPath : id === basename(createdPath) ? createdPath : null;
		ctx.parseSessionFile = (filePath: string) => {
			if (basename(filePath) === basename(createdPath)) return null;
			return (sessionsContext().parseSessionFile as (path: string) => unknown)(filePath) as never;
		};

		const first = responseFixture();
		const second = responseFixture();
		await Promise.all([
			handleSessionsRoutes(requestFixture({ createReplacement: true }), first as unknown as ServerResponse, "DELETE", deleteUrl(), ctx),
			handleSessionsRoutes(requestFixture({ createReplacement: true }), second as unknown as ServerResponse, "DELETE", deleteUrl(), ctx),
		]);

		// One lease wins; the other is refused as "already being deleted" and never
		// creates a second blank conversation.
		const statuses = [first.writeHead.mock.calls[0]?.[0], second.writeHead.mock.calls[0]?.[0]].sort();
		expect(statuses).toEqual([200, 409]);
		expect(runner.createNewSessionInQueueSlot).toHaveBeenCalledTimes(1);
	});

	it("leaves a non-active delete untouched by the replacement flag", async () => {
		runner.getCurrentSessionId.mockReturnValue(bId);
		const res = responseFixture();
		await handleSessionsRoutes(
			requestFixture({ createReplacement: true }),
			res as unknown as ServerResponse,
			"DELETE", deleteUrl(), sessionsContext(),
		);
		expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({ id: aId, deleted: true, newActiveId: null, replacedWith: null });
		expect(runner.createNewSessionInQueueSlot).not.toHaveBeenCalled();
		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
	});

	it("keeps A and releases the lease when the replacement disappears in the queue", async () => {
		const gate = deferred<void>(), started = deferred<void>();
		runner.deleteSessionFileInQueue.mockImplementation(async (_id: string, _activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = await plan.selectReplacement();
			if (!replacement) return Promise.reject(new NoReplacementSessionError(_id));
			return new Promise((_resolve, reject) => {
				const onAbort = () => reject(new QueueTaskCancelledError());
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				void gate.promise.then(() => reject(new SessionUnavailableError(replacement.id, "missing")));
			});
		});
		const res = responseFixture();
		const deleting = handleSessionsRoutes(requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(), sessionsContext());
		await started.promise;
		gate.resolve();
		await deleting;
		expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(bodyOf(res).error).toBe("replacement_unavailable");
		expect(existsSync(aPath)).toBe(true);
		expect(sessionLifecycle.isDeleting(aId)).toBe(false);
		expect(sessionLifecycle.isDeleted(aId)).toBe(false);
	});

	it("does not remove A when the queue times out before the delete starts", async () => {
		installBlockedReplace(new Promise<void>(() => undefined));
		const res = responseFixture();
		await handleSessionsRoutes(
			requestFixture(), res as unknown as ServerResponse,
			"DELETE", deleteUrl(), sessionsContext(100),
		);
		expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(bodyOf(res).error).toBe("session_busy");
		expect(existsSync(aPath)).toBe(true);
		expect(sessionLifecycle.isDeleting(aId)).toBe(false);
		expect(sessionLifecycle.isDeleted(aId)).toBe(false);
	});

	it("keeps the session when the runtime hand-off throws", async () => {
		const gate = deferred<void>(), started = deferred<void>();
		runner.deleteSessionFileInQueue.mockImplementation(async (id: string, activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = await plan.selectReplacement();
			if (!replacement) return Promise.reject(new NoReplacementSessionError(id));
			await plan.validateReplacement(replacement);
			return new Promise((_resolve, reject) => {
				const onAbort = () => reject(new QueueTaskCancelledError());
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				void gate.promise.then(() => reject(new Error("switch failed")));
			});
		});
		const res = responseFixture();
		const deleting = handleSessionsRoutes(requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(), sessionsContext());
		await started.promise;
		gate.resolve();
		await deleting;
		expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({ error: "session_switch_failed", deleted: false });
		expect(existsSync(aPath)).toBe(true);
		expect(sessionLifecycle.isDeleting(aId)).toBe(false);
	});
});

describe("explicit chat validation", () => {
	it("404s a deleted id instead of falling back to the runtime session", async () => {
		const lease = sessionLifecycle.beginDeletion(aId);
		unlinkSync(aPath);
		sessionLifecycle.completeDeletion(lease);
		const res = responseFixture();
		await handleChatRoutes(
			requestFixture({ sessionId: aId, prompt: "no fallback" }),
			res as unknown as ServerResponse, "POST", "/api/chat", chatContext(),
		);
		expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
		expect(runner.runPromptInSession).not.toHaveBeenCalled();
		expect(runner.runPromptSerialized).not.toHaveBeenCalled();
	});

	it("still uses the runtime session when sessionId is genuinely absent", async () => {
		runner.runPromptSerialized.mockResolvedValue("ok");
		const res = responseFixture();
		await handleChatRoutes(
			requestFixture({ prompt: "use the current runtime" }),
			res as unknown as ServerResponse, "POST", "/api/chat", chatContext(),
		);
		expect(runner.runPromptSerialized).toHaveBeenCalledTimes(1);
		expect(runner.runPromptInSession).not.toHaveBeenCalled();
	});
});

describe("E4.7-R2a — replacement excludes archived-course conversations", () => {
	const archivedScope = { course_id: "course_archived", title: "归档课程", archived: true };

	it("does not fall back to a child of an archived course", async () => {
		const res = responseFixture();
		const ctx = sessionsContext(undefined, new Map([[bId, archivedScope]]));
		await handleSessionsRoutes(requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(), ctx);

		// No legal successor and no explicit confirmation: keep A, refuse.
		expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({ error: "no_replacement_session" });
		expect(existsSync(aPath)).toBe(true);
		expect(existsSync(bPath)).toBe(true);
	});

	it("re-validates the course state before removing A", async () => {
		const scopes = new Map<string, { course_id: string; title: string; archived: boolean }>();
		runner.deleteSessionFileInQueue.mockImplementation(async (id: string, activePath: string, plan: SessionDeletionPlan) => {
			const replacement = await plan.selectReplacement();
			if (!replacement) throw new NoReplacementSessionError(id);
			// The course is archived while the SDK switch is in flight. A second
			// look-up inside the queue must reject the target.
			scopes.set(bId, archivedScope);
			await plan.validateReplacement(replacement);
			unlinkSync(activePath);
			return { tookOver: true, newActiveId: replacement.id };
		});

		const res = responseFixture();
		await handleSessionsRoutes(
			requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(),
			sessionsContext(undefined, scopes),
		);

		expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({ error: "replacement_unavailable", retryable: true });
		expect(existsSync(aPath)).toBe(true);
		expect(existsSync(bPath)).toBe(true);
	});
});

describe("E4.7-R2a — partial delete reports the real state", () => {
	it("says the chat is gone when only B2/metadata cleanup failed", async () => {
		const ctx = sessionsContext();
		const removeRecord = ctx.learningRecordStore.remove as unknown as ReturnType<typeof vi.fn>;
		const removeMeta = ctx.sessionMetaStore.remove as unknown as ReturnType<typeof vi.fn>;
		removeRecord.mockRejectedValueOnce(new Error("B2 locked"));
		removeMeta.mockRejectedValueOnce(new Error("meta locked"));

		const res = responseFixture();
		await handleSessionsRoutes(requestFixture(), res as unknown as ServerResponse, "DELETE", deleteUrl(), ctx);

		// The transcript is gone; reporting `deleted: false` would tell the client
		// the original conversation is still there.
		expect(existsSync(aPath)).toBe(false);
		expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({
			error: "session_cleanup_failed",
			deleted: true,
			partial: true,
			cleanup_failures: ["learning_record", "session_meta"],
			retryable: true,
		});
		// Both owners were attempted; one failure did not skip the other.
		expect(removeRecord).toHaveBeenCalledWith(aId);
		expect(removeMeta).toHaveBeenCalledWith(aId);
	});
});

describe("E4.7-R2a — retry after a partial delete", () => {
	it("finishes cleanup without recreating the deleted conversation", async () => {
		const ctx = sessionsContext();
		const removeRecord = ctx.learningRecordStore.remove as unknown as ReturnType<typeof vi.fn>;
		const removeMeta = ctx.sessionMetaStore.remove as unknown as ReturnType<typeof vi.fn>;
		removeRecord.mockRejectedValueOnce(new Error("B2 locked"));
		removeMeta.mockRejectedValueOnce(new Error("meta locked"));

		const first = responseFixture();
		await handleSessionsRoutes(requestFixture(), first as unknown as ServerResponse, "DELETE", deleteUrl(), ctx);
		expect(bodyOf(first)).toMatchObject({ error: "session_cleanup_failed", deleted: true });

		// The chat file is gone; a learning record is the leftover a retry finds,
		// and the runtime has already handed over to B.
		writeFileSync(join(dataDir, "learning", `${aId}.json`), "{}");
		(ctx.sessionMetaStore.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: aId });
		runner.getCurrentSessionId.mockReturnValue(bId);
		runner.createNewSessionInQueueSlot.mockClear();

		const retry = responseFixture();
		await handleSessionsRoutes(requestFixture(), retry as unknown as ServerResponse, "DELETE", deleteUrl(), ctx);

		expect(retry.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		expect(bodyOf(retry)).toMatchObject({ id: aId, deleted: true });
		expect(removeRecord).toHaveBeenCalledTimes(2);
		expect(removeMeta).toHaveBeenCalledTimes(2);
		// A retry cleans up; it never resurrects A or creates another successor.
		expect(existsSync(aPath)).toBe(false);
		expect(runner.createNewSessionInQueueSlot).not.toHaveBeenCalled();
	});
});

describe("E4.7-R2a closeout — successor init and durable cleanup retry", () => {
	it("initialises the blank successor before a failed B2 cleanup", async () => {
		// Only A exists; the successor is created by this delete.
		unlinkSync(bPath);
		runner.createNewSessionInQueueSlot.mockImplementation(async () => {
			writeFileSync(bPath, "");
			return bId;
		});
		const ctx = sessionsContext();
		const removeRecord = ctx.learningRecordStore.remove as unknown as ReturnType<typeof vi.fn>;
		removeRecord.mockRejectedValueOnce(new Error("B2 locked"));

		const res = responseFixture();
		await handleSessionsRoutes(
			requestFixture({ createReplacement: true }), res as unknown as ServerResponse,
			"DELETE", deleteUrl(), ctx,
		);

		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
		expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		expect(bodyOf(res)).toMatchObject({
			error: "session_cleanup_failed",
			deleted: true,
			partial: true,
			newActiveId: bId,
			cleanup_failures: ["learning_record"],
		});
		// B is a complete web session even though A's B2 cleanup failed.
		expect(ctx.recordCurrentSessionChannel).toHaveBeenCalledWith("web", bId, { setOriginIfEmpty: true });
		expect(ctx.workspaceRegistry.bindSession).toHaveBeenCalledWith(bId, expect.any(String));
		const marker = JSON.parse(readFileSync(join(sessionDir, "pending-cleanup.json"), "utf-8")) as Record<string, {
			failures: string[];
			new_active_id?: string;
		}>;
		expect(marker[aId]).toMatchObject({ failures: ["learning_record"], new_active_id: bId });

		// Retry: finish cleanup only. No second blank session, no resurrected A.
		runner.createNewSessionInQueueSlot.mockClear();
		const retry = responseFixture();
		await handleSessionsRoutes(requestFixture(), retry as unknown as ServerResponse, "DELETE", deleteUrl(), ctx);
		expect(retry.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		expect(bodyOf(retry)).toMatchObject({ id: aId, deleted: true, cleanup: "complete" });
		expect(runner.createNewSessionInQueueSlot).not.toHaveBeenCalled();
		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
		expect(JSON.parse(readFileSync(join(sessionDir, "pending-cleanup.json"), "utf-8"))[aId]).toBeUndefined();
	});

	it("retries one failed sidecar after other steps completed, even across a restart", async () => {
		// A real archive entry proves later steps still ran after the first failure.
		writeFileSync(join(sessionDir, "archives.json"), JSON.stringify({ [aId]: true, keep: true }));
		// A directory at the metadata path makes the first step throw on write.
		mkdirSync(join(sessionDir, "channels.json"));
		const ctx = sessionsContext();
		(ctx as unknown as { readSessionChannelMetadata: () => unknown }).readSessionChannelMetadata =
			() => ({ [aId]: { channel: "web" } });

		const first = responseFixture();
		await handleSessionsRoutes(requestFixture(), first as unknown as ServerResponse, "DELETE", deleteUrl(), ctx);

		expect(existsSync(aPath)).toBe(false);
		expect(first.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		expect(bodyOf(first)).toMatchObject({
			error: "session_cleanup_failed",
			deleted: true,
			cleanup_failures: ["channel_metadata"],
		});
		// Independent steps completed despite the first failure.
		const archivesAfterFirst = JSON.parse(readFileSync(join(sessionDir, "archives.json"), "utf-8")) as Record<string, unknown>;
		expect(archivesAfterFirst[aId]).toBeUndefined();
		expect(archivesAfterFirst.keep).toBe(true);
		const marker = JSON.parse(readFileSync(join(sessionDir, "pending-cleanup.json"), "utf-8")) as Record<string, unknown>;
		expect(marker[aId]).toBeDefined();

		// Simulate a process restart: a fresh context reads the marker from disk.
		rmSync(join(sessionDir, "channels.json"), { recursive: true, force: true });
		const restarted = sessionsContext();
		(restarted as unknown as { readSessionChannelMetadata: () => unknown }).readSessionChannelMetadata =
			() => ({ [aId]: { channel: "web" } });
		runner.createNewSessionInQueueSlot.mockClear();

		const retry = responseFixture();
		await handleSessionsRoutes(requestFixture(), retry as unknown as ServerResponse, "DELETE", deleteUrl(), restarted);

		expect(retry.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		expect(bodyOf(retry)).toMatchObject({ id: aId, deleted: true, cleanup: "complete" });
		expect(JSON.parse(readFileSync(join(sessionDir, "pending-cleanup.json"), "utf-8"))[aId]).toBeUndefined();
		// No ghost session and no second successor.
		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
		expect(runner.createNewSessionInQueueSlot).not.toHaveBeenCalled();
	});
});

describe("E4.7-R2a closeout — successor initialisation failure", () => {
	it("reports deleted:true and finishes B's setup on retry", async () => {
		unlinkSync(bPath);
		runner.createNewSessionInQueueSlot.mockImplementation(async () => {
			writeFileSync(bPath, "");
			return bId;
		});
		const ctx = sessionsContext();
		(ctx as unknown as { recordCurrentSessionChannel: () => void }).recordCurrentSessionChannel =
			() => { throw new Error("channel store locked"); };

		const first = responseFixture();
		await handleSessionsRoutes(
			requestFixture({ createReplacement: true }), first as unknown as ServerResponse,
			"DELETE", deleteUrl(), ctx,
		);

		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
		expect(first.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
		expect(bodyOf(first)).toMatchObject({
			error: "session_cleanup_failed",
			deleted: true,
			partial: true,
			newActiveId: bId,
			cleanup_failures: ["replacement_init"],
		});
		const marker = JSON.parse(readFileSync(join(sessionDir, "pending-cleanup.json"), "utf-8")) as Record<string, {
			new_active_id?: string;
		}>;
		expect(marker[aId]).toMatchObject({ new_active_id: bId });

		// Retry with a working channel store: B is initialised, marker cleared.
		const retryCtx = sessionsContext();
		const retry = responseFixture();
		await handleSessionsRoutes(requestFixture(), retry as unknown as ServerResponse, "DELETE", deleteUrl(), retryCtx);
		expect(retry.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
		expect(bodyOf(retry)).toMatchObject({ id: aId, deleted: true, cleanup: "complete" });
		expect(retryCtx.recordCurrentSessionChannel).toHaveBeenCalledWith("web", bId, { setOriginIfEmpty: true });
		expect(JSON.parse(readFileSync(join(sessionDir, "pending-cleanup.json"), "utf-8"))[aId]).toBeUndefined();
		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
	});
});
