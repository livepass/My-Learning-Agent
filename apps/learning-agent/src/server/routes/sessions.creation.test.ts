import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorkspaceCwd, createNewSession, getCurrentSessionId } from "../../agent/pi-runner.js";
import { SessionQueue } from "../../agent/session-queue.js";
import { TEMP_WORKSPACE_ID } from "../../workspace/workspace-registry.js";
import { runQueuedHttpOperation } from "../queued-operation.js";
import { handleSessionsRoutes, type SessionsRouteContext } from "./sessions.js";

vi.mock("../../agent/pi-runner.js", () => ({
	getSession: vi.fn(), getCurrentSessionId: vi.fn(), applyWorkspaceCwd: vi.fn(),
	branchSessionBeforeUserMessage: vi.fn(), createNewSession: vi.fn(),
	SessionEditError: class extends Error {}, switchSessionFile: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

function fixture() {
	const sessionId = "created.jsonl", dataDir = join(tmpdir(), "session-create-unit");
	const sessionPath = join(dataDir, "sessions", sessionId);
	const res = Object.assign(new EventEmitter(), {
		destroyed: false, writableFinished: false, writableEnded: false,
		writeHead: vi.fn(), end: vi.fn(),
	});
	const workspaceRegistry = { getWorkspace: vi.fn(), bindSession: vi.fn().mockReturnValue(true) };
	const runQueueOpWithTimeout: SessionsRouteContext["runQueueOpWithTimeout"] = (_req, response, op) =>
		runQueuedHttpOperation(response, op, { getQueueBlocker: () => null });
	const ctx = {
		dataDir, workspaceRegistry, paths: {},
		recordCurrentSessionChannel: vi.fn(), releaseQueueFromQuestionBlockedTurn: vi.fn(),
		sessionFileFromId: (_root: string, id: string) => id === sessionId ? sessionPath : null,
		runQueueOpWithTimeout,
	} as unknown as SessionsRouteContext;
	const req = new PassThrough() as PassThrough & IncomingMessage;
	req.headers = {};
	return { req, res, ctx, workspaceRegistry, sessionId, sessionPath };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getCurrentSessionId).mockReturnValue("created.jsonl");
});

describe("session creation completion after queue entry", () => {
	it("keeps workspace/channel cleanup after disconnect and never writes to the closed response", async () => {
		const f = fixture(), queue = new SessionQueue(), started = deferred<void>(), gate = deferred<string>();
		vi.mocked(createNewSession).mockImplementation(options => queue.enqueue(() => { started.resolve(undefined); return gate.promise; }, options));
		const handled = handleSessionsRoutes(f.req, f.res as unknown as ServerResponse, "POST", "/api/sessions", f.ctx);
		f.req.end("{}");
		await started.promise;
		f.res.destroyed = true;
		f.res.emit("close");
		gate.resolve(f.sessionId);
		await expect(handled).resolves.toBe(true);
		expect(f.ctx.recordCurrentSessionChannel).toHaveBeenCalledWith("web", f.sessionId, { setOriginIfEmpty: true });
		expect(f.workspaceRegistry.bindSession).toHaveBeenCalledWith(f.sessionId, TEMP_WORKSPACE_ID);
		expect(applyWorkspaceCwd).toHaveBeenCalledWith(f.sessionPath, { onlyIfCurrent: true });
		expect(f.res.writeHead).not.toHaveBeenCalled();
		expect(f.res.end).not.toHaveBeenCalled();
	});

	it("returns the created id after finishing a normal workspace binding", async () => {
		const f = fixture(), queue = new SessionQueue();
		vi.mocked(createNewSession).mockImplementation(options => queue.enqueue(async () => f.sessionId, options));
		const handled = handleSessionsRoutes(f.req, f.res as unknown as ServerResponse, "POST", "/api/sessions", f.ctx);
		f.req.end("{}");
		await expect(handled).resolves.toBe(true);
		expect(f.res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
		expect(JSON.parse(f.res.end.mock.calls[0][0])).toEqual({ id: f.sessionId, active: true, workspaceId: TEMP_WORKSPACE_ID });
		expect(applyWorkspaceCwd).toHaveBeenCalledWith(f.sessionPath, { onlyIfCurrent: true });
	});
});
