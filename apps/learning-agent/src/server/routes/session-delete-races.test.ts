import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueTaskCancelledError, type QueueTaskOptions } from "../../agent/session-queue.js";
import type { SessionDeletionPlan } from "../../agent/pi-runner.js";
import { NoReplacementSessionError, sessionLifecycle, SessionUnavailableError } from "../../agent/session-lifecycle.js";
import { runQueuedHttpOperation } from "../queued-operation.js";
import { handleChatRoutes, type ChatRouteContext } from "./chat.js";
import { handleSessionsRoutes, type SessionsRouteContext } from "./sessions.js";

const runner = vi.hoisted(() => ({
	getCurrentSessionId: vi.fn(),
	deleteSessionFileInQueue: vi.fn(),
	createNewSession: vi.fn(),
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
	// Default: the route's queue task selects B, validates it, and unlinks A.
	runner.deleteSessionFileInQueue.mockImplementation((id: string, activePath: string, plan: SessionDeletionPlan) => {
		if (runner.getCurrentSessionId() !== id) {
			unlinkSync(activePath);
			return Promise.resolve({ tookOver: false, newActiveId: null });
		}
		const replacement = plan.selectReplacement();
		if (!replacement) return Promise.reject(new NoReplacementSessionError(id));
		plan.validateReplacement(replacement);
		unlinkSync(activePath);
		return Promise.resolve({ tookOver: true, newActiveId: replacement.id });
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

function sessionsContext(timeoutMs?: number): SessionsRouteContext {
	return {
		dataDir,
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
		runner.deleteSessionFileInQueue.mockImplementation((id: string, activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = plan.selectReplacement();
			if (!replacement) return Promise.reject(new NoReplacementSessionError(id));
			plan.validateReplacement(replacement);
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
		runner.deleteSessionFileInQueue.mockImplementation((id: string, activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = plan.selectReplacement();
			if (!replacement) return Promise.reject(new NoReplacementSessionError(id));
			plan.validateReplacement(replacement);
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
		expect(existsSync(aPath)).toBe(true);
	});

	it("keeps A and releases the lease when the replacement disappears in the queue", async () => {
		const gate = deferred<void>(), started = deferred<void>();
		runner.deleteSessionFileInQueue.mockImplementation((_id: string, _activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = plan.selectReplacement();
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
		runner.deleteSessionFileInQueue.mockImplementation((id: string, activePath: string, plan: SessionDeletionPlan, options?: QueueTaskOptions) => {
			started.resolve();
			const replacement = plan.selectReplacement();
			if (!replacement) return Promise.reject(new NoReplacementSessionError(id));
			plan.validateReplacement(replacement);
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
