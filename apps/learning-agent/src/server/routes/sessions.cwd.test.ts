import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeModelConfig } from "../../config.js";
import { resolveRuntimePaths } from "../../runtime.js";
import { handleSessionsRoutes, type SessionsRouteContext } from "./sessions.js";
import { runQueuedHttpOperation } from "../queued-operation.js";
import { TEMP_WORKSPACE_ID } from "../../workspace/workspace-registry.js";
import { applyWorkspaceCwd, getCurrentSessionId, initSession, switchSessionFile } from "../../agent/pi-runner.js";

const state = vi.hoisted(() => ({ agentDir: "", runtime: null as unknown }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getAgentDir: () => state.agentDir,
		SettingsManager: { create: vi.fn(() => ({})) },
		SessionManager: { create: vi.fn(() => ({})) },
		createAgentSessionRuntime: vi.fn(async () => state.runtime),
	};
});
vi.mock("../../logger.js", () => {
	const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() };
	logger.child.mockReturnValue(logger);
	return { logger };
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

let root: string, sessionA: string, sessionB: string;
let session: { sessionFile: string; bindExtensions: ReturnType<typeof vi.fn> };
let runtime: { session: typeof session; newSession: ReturnType<typeof vi.fn>; switchSession: ReturnType<typeof vi.fn>; setRebindSession: ReturnType<typeof vi.fn> };

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "inno-cwd-queue-"));
	state.agentDir = join(root, "config");
	await mkdir(state.agentDir);
	const paths = resolveRuntimePaths({ home: root, config: join(state.agentDir, "config.json"), configDir: state.agentDir, dataDir: join(root, "data"), skillsDir: join(root, "skills"), workspaceDir: join(root, "workspace") });
	await mkdir(paths.sessionDir, { recursive: true });
	sessionA = join(paths.sessionDir, "a.jsonl");
	sessionB = join(paths.sessionDir, "b.jsonl");
	await Promise.all([sessionA, sessionB].map(path => writeFile(path, "")));
	session = { sessionFile: join(paths.sessionDir, "initial.jsonl"), bindExtensions: vi.fn().mockResolvedValue(undefined) };
	runtime = {
		session,
		newSession: vi.fn(async () => { session.sessionFile = sessionA; }),
		switchSession: vi.fn(async (path: string) => { session.sessionFile = path; }),
		setRebindSession: vi.fn(),
	};
	state.runtime = runtime;
	await initSession({ defaultProvider: "fixture", defaultModel: "dummy", providers: { fixture: { baseUrl: "http://127.0.0.1:1", apiKey: "fixture", models: [normalizeModelConfig({ id: "dummy" })] } }, mcp: { enabled: false } }, paths);
});

afterEach(async () => {
	// Only this test's verified mkdtemp directory is recursively removed.
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("inno-cwd-queue-")) throw new Error("Unexpected cwd test cleanup path");
	await rm(root, { recursive: true, force: true });
});

describe("workspace cwd consistency after session creation", () => {
	it.each([true, false])("finishes creation metadata without overriding newer navigation (disconnected=%s)", async disconnected => {
		const createStarted = deferred<void>(), createGate = deferred<void>(), navigateStarted = deferred<void>(), navigateGate = deferred<void>(), bound = deferred<void>();
		runtime.newSession.mockImplementation(async () => { createStarted.resolve(undefined); await createGate.promise; session.sessionFile = sessionA; });
		runtime.switchSession.mockImplementation(async (path: string) => { navigateStarted.resolve(undefined); await navigateGate.promise; session.sessionFile = path; });
		const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false, writableEnded: false, writeHead: vi.fn(), end: vi.fn() });
		const recordCurrentSessionChannel = vi.fn();
		const bindSession = vi.fn(() => { bound.resolve(undefined); return true; });
		const runQueueOpWithTimeout: SessionsRouteContext["runQueueOpWithTimeout"] = (_req, response, op) => runQueuedHttpOperation(response, op, { getQueueBlocker: () => null });
		const ctx = {
			dataDir: dirname(dirname(sessionA)), paths: {}, workspaceRegistry: { getWorkspace: vi.fn(), bindSession },
			recordCurrentSessionChannel, releaseQueueFromQuestionBlockedTurn: vi.fn(),
			sessionFileFromId: (_dir: string, id: string) => id === "a.jsonl" ? sessionA : null,
			runQueueOpWithTimeout,
		} as unknown as SessionsRouteContext;
		const req = new PassThrough() as PassThrough & IncomingMessage;
		req.headers = {};
		const creating = handleSessionsRoutes(req, res as unknown as ServerResponse, "POST", "/api/sessions", ctx);
		req.end("{}");
		await createStarted.promise;
		if (disconnected) {
			res.destroyed = true;
			res.emit("close");
		}
		const navigating = switchSessionFile(sessionB);
		createGate.resolve(undefined);
		await navigateStarted.promise;
		await bound.promise;
		// The old creation's cwd apply is now behind B in the real shared queue.
		navigateGate.resolve(undefined);
		await navigating;
		await expect(creating).resolves.toBe(true);
		expect(recordCurrentSessionChannel).toHaveBeenCalledWith("web", "a.jsonl", { setOriginIfEmpty: true });
		expect(bindSession).toHaveBeenCalledWith("a.jsonl", TEMP_WORKSPACE_ID);
		expect(getCurrentSessionId()).toBe("b.jsonl");
		expect(runtime.switchSession).toHaveBeenCalledOnce();
		expect(runtime.switchSession.mock.calls[0][0]).toBe(resolve(sessionB));
		if (disconnected) {
			expect(res.writeHead).not.toHaveBeenCalled();
			expect(res.end).not.toHaveBeenCalled();
		} else {
			expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
			expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ id: "a.jsonl", active: false, workspaceId: TEMP_WORKSPACE_ID });
		}
	});

	it("still reapplies cwd for a current session addressed through an equivalent normalized path", async () => {
		session.sessionFile = sessionA;
		await applyWorkspaceCwd(`${dirname(sessionA)}${sep}.${sep}${basename(sessionA)}`, { onlyIfCurrent: true });
		expect(runtime.switchSession).toHaveBeenCalledOnce();
		expect(runtime.switchSession.mock.calls[0][0]).toBe(resolve(sessionA));
	});

	it("does not confuse a different session path with the same file name", async () => {
		session.sessionFile = sessionA;
		await applyWorkspaceCwd(join(root, "different-workspace", basename(sessionA)), { onlyIfCurrent: true });
		expect(runtime.switchSession).not.toHaveBeenCalled();
		expect(getCurrentSessionId()).toBe("a.jsonl");
	});

	it("preserves explicit workspace switches when onlyIfCurrent was not requested", async () => {
		session.sessionFile = sessionB;
		await applyWorkspaceCwd(sessionA);
		expect(runtime.switchSession).toHaveBeenCalledOnce();
		expect(getCurrentSessionId()).toBe("a.jsonl");
	});
});
