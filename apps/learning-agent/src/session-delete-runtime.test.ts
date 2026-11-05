import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeModelConfig } from "../src/config.js";
import { resolveRuntimePaths } from "../src/runtime.js";
import {
	appendAssistantNotificationInSession,
	branchSessionBeforeUserMessage,
	createNewSession,
	deleteSessionFileInQueue,
	initSession,
	replaceActiveSessionAndRemove,
	runPromptInSession,
	runPromptStreamingInSession,
	switchSessionFile,
} from "../src/agent/pi-runner.js";
import { NoReplacementSessionError, sessionLifecycle, SessionUnavailableError } from "../src/agent/session-lifecycle.js";

/**
 * Queue-level proof for D3: every entry point that can rebind the singleton
 * runtime re-validates its target *inside* the shared Agent queue, after any
 * wait. The barriers below are real deferred promises, not sleeps.
 */

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
vi.mock("../src/logger.js", () => {
	const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() };
	logger.child.mockReturnValue(logger);
	return { logger };
});

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

let root: string;
let seq = 0;
let sessionA: string, sessionB: string, sessionC: string;
let session: { sessionFile: string; bindExtensions: ReturnType<typeof vi.fn> };
let runtime: {
	session: typeof session;
	newSession: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "inno-delete-runtime-"));
	state.agentDir = join(root, "config");
	await mkdir(state.agentDir);
	const paths = resolveRuntimePaths({
		home: root,
		config: join(state.agentDir, "config.json"),
		configDir: state.agentDir,
		dataDir: join(root, "data"),
		skillsDir: join(root, "skills"),
		workspaceDir: join(root, "workspace"),
	});
	await mkdir(paths.sessionDir, { recursive: true });
	const prefix = `s${++seq}`;
	sessionA = join(paths.sessionDir, `${prefix}a.jsonl`);
	sessionB = join(paths.sessionDir, `${prefix}b.jsonl`);
	sessionC = join(paths.sessionDir, `${prefix}c.jsonl`);
	await Promise.all([sessionA, sessionB, sessionC].map(path => writeFile(path, "")));
	session = { sessionFile: sessionA, bindExtensions: vi.fn().mockResolvedValue(undefined) };
	runtime = {
		session,
		newSession: vi.fn(async () => { session.sessionFile = sessionC; }),
		switchSession: vi.fn(async (path: string) => { session.sessionFile = path; }),
		setRebindSession: vi.fn(),
	};
	state.runtime = runtime;
	await initSession({
		defaultProvider: "fixture",
		defaultModel: "dummy",
		providers: { fixture: { baseUrl: "http://127.0.0.1:1", apiKey: "fixture", models: [normalizeModelConfig({ id: "dummy" })] } },
	}, paths);
});

afterEach(async () => {
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("inno-delete-runtime-")) {
		throw new Error("Unexpected delete runtime cleanup path");
	}
	await rm(root, { recursive: true, force: true });
});

const idOf = (path: string) => basename(path);

describe("D3 queue-entry revalidation", () => {
	it("fails a queued prompt instead of recreating the deleted session", async () => {
		const gate = deferred();
		runtime.newSession.mockImplementation(async () => {
			await gate.promise;
			session.sessionFile = sessionC;
		});
		const creating = createNewSession();
		const prompting = runPromptInSession(sessionA, "must not resurrect A");

		// The prompt already passed the HTTP existence check and is waiting.
		const lease = sessionLifecycle.beginDeletion(idOf(sessionA));
		await unlink(sessionA);
		sessionLifecycle.completeDeletion(lease);

		gate.resolve();
		await creating;
		await expect(prompting).rejects.toBeInstanceOf(SessionUnavailableError);
		expect(existsSync(sessionA)).toBe(false);
		expect(runtime.switchSession).not.toHaveBeenCalledWith(resolve(sessionA), expect.anything());
	});

	it("refuses to switch, branch, notify, or stream into a deleted session", async () => {
		const lease = sessionLifecycle.beginDeletion(idOf(sessionA));
		await unlink(sessionA);
		sessionLifecycle.completeDeletion(lease);

		await expect(switchSessionFile(sessionA)).rejects.toBeInstanceOf(SessionUnavailableError);
		await expect(branchSessionBeforeUserMessage(sessionA, "entry")).rejects.toBeInstanceOf(SessionUnavailableError);
		await expect(appendAssistantNotificationInSession(sessionA, "late")).rejects.toBeInstanceOf(SessionUnavailableError);
		await expect(runPromptStreamingInSession(sessionA, "late", () => undefined)).rejects.toBeInstanceOf(SessionUnavailableError);
		expect(runtime.switchSession).not.toHaveBeenCalled();
		expect(existsSync(sessionA)).toBe(false);
	});
});

describe("D3 replaceActiveSessionAndRemove", () => {
	it("switches to the replacement and removes the old file in one queue slot", async () => {
		session.sessionFile = sessionA;
		const result = await replaceActiveSessionAndRemove(idOf(sessionA), sessionA, {
			id: idOf(sessionB),
			path: sessionB,
		});
		expect(result.newActiveId).toBe(idOf(sessionB));
		expect(runtime.switchSession).toHaveBeenCalledTimes(1);
		expect(runtime.switchSession.mock.calls[0][0]).toBe(resolve(sessionB));
		expect(existsSync(sessionA)).toBe(false);
		expect(existsSync(sessionB)).toBe(true);
	});

	it("keeps A when the replacement disappeared while the task was queued", async () => {
		session.sessionFile = sessionA;
		await unlink(sessionB);
		await expect(replaceActiveSessionAndRemove(idOf(sessionA), sessionA, {
			id: idOf(sessionB),
			path: sessionB,
		})).rejects.toMatchObject({ reason: "missing" });
		expect(existsSync(sessionA)).toBe(true);
		expect(runtime.switchSession).not.toHaveBeenCalled();
	});

	it("rejects a replacement the route re-validation marked ineligible", async () => {
		session.sessionFile = sessionA;
		await expect(replaceActiveSessionAndRemove(idOf(sessionA), sessionA, {
			id: idOf(sessionB),
			path: sessionB,
			validate: () => { throw new SessionUnavailableError(idOf(sessionB), "ineligible"); },
		})).rejects.toMatchObject({ reason: "ineligible" });
		expect(existsSync(sessionA)).toBe(true);
		expect(existsSync(sessionB)).toBe(true);
		expect(runtime.switchSession).not.toHaveBeenCalled();
	});

	it("does not hijack a runtime that moved away before the task ran", async () => {
		session.sessionFile = sessionA;
		const gate = deferred();
		runtime.newSession.mockImplementation(async () => {
			await gate.promise;
			session.sessionFile = sessionC;
		});
		const creating = createNewSession();
		const replacing = replaceActiveSessionAndRemove(idOf(sessionA), sessionA, {
			id: idOf(sessionB),
			path: sessionB,
		});
		gate.resolve();
		await creating;

		const result = await replacing;
		expect(result.newActiveId).toBeNull();
		expect(existsSync(sessionA)).toBe(false);
		expect(existsSync(sessionB)).toBe(true);
		expect(session.sessionFile).toBe(sessionC);
		expect(runtime.switchSession).not.toHaveBeenCalled();
	});

	it("never removes A when the switch result cannot be verified", async () => {
		session.sessionFile = sessionA;
		runtime.switchSession.mockImplementation(async () => {
			// Simulate a switch that silently leaves the runtime on another path.
			session.sessionFile = sessionC;
		});
		await expect(replaceActiveSessionAndRemove(idOf(sessionA), sessionA, {
			id: idOf(sessionB),
			path: sessionB,
		})).rejects.toThrow(/switch verification failed/);
		expect(existsSync(sessionA)).toBe(true);
	});
});

describe("D3 unified deletion boundary (queue-time runtime identity)", () => {
	it("takes over when activate(A) was paused and DELETE A arrives from a non-active snapshot", async () => {
		session.sessionFile = sessionB;
		const switchGate = deferred(), switchStarted = deferred();
		runtime.switchSession.mockImplementation(async (path: string) => {
			if (path === resolve(sessionA)) {
				switchStarted.resolve();
				await switchGate.promise;
			}
			session.sessionFile = path;
		});

		const activating = switchSessionFile(sessionA);
		await switchStarted.promise; // switchSession(A) is paused inside the SDK

		const lease = sessionLifecycle.beginDeletion(idOf(sessionA));
		const deleting = deleteSessionFileInQueue(idOf(sessionA), sessionA, {
			selectReplacement: () => ({ id: idOf(sessionC), path: sessionC }),
			validateReplacement: () => undefined,
		});

		switchGate.resolve();
		await activating;
		const outcome = await deleting;
		sessionLifecycle.completeDeletion(lease);

		expect(outcome).toEqual({ tookOver: true, newActiveId: idOf(sessionC) });
		expect(session.sessionFile).toBe(sessionC);
		expect(existsSync(sessionA)).toBe(false);
		expect(existsSync(sessionC)).toBe(true);
	});

	it("keeps A when the queue-time runtime became A but no replacement exists", async () => {
		session.sessionFile = sessionB;
		const switchGate = deferred(), switchStarted = deferred();
		runtime.switchSession.mockImplementation(async (path: string) => {
			if (path === resolve(sessionA)) {
				switchStarted.resolve();
				await switchGate.promise;
			}
			session.sessionFile = path;
		});

		const activating = switchSessionFile(sessionA);
		await switchStarted.promise;
		const lease = sessionLifecycle.beginDeletion(idOf(sessionA));
		const deleting = deleteSessionFileInQueue(idOf(sessionA), sessionA, {
			selectReplacement: () => null,
			validateReplacement: () => undefined,
		});

		switchGate.resolve();
		await activating;
		await expect(deleting).rejects.toBeInstanceOf(NoReplacementSessionError);
		expect(session.sessionFile).toBe(sessionA);
		expect(existsSync(sessionA)).toBe(true);
		sessionLifecycle.abortDeletion(lease);
	});

	it("rolls back to A when B starts deleting during the asynchronous switch", async () => {
		session.sessionFile = sessionA;
		const switchGate = deferred(), switchStarted = deferred();
		let paused = false;
		runtime.switchSession.mockImplementation(async (path: string) => {
			if (!paused && path === resolve(sessionB)) {
				paused = true;
				switchStarted.resolve();
				await switchGate.promise;
			}
			session.sessionFile = path;
		});

		const aLease = sessionLifecycle.beginDeletion(idOf(sessionA));
		const deletingA = deleteSessionFileInQueue(idOf(sessionA), sessionA, {
			selectReplacement: () => ({ id: idOf(sessionB), path: sessionB }),
			validateReplacement: (replacement) => {
				if (sessionLifecycle.isBlocked(replacement.id)) {
					throw new SessionUnavailableError(replacement.id, "ineligible");
				}
			},
		});
		await switchStarted.promise;

		// DELETE B lands while A is paused inside switchSession(B).
		const bLease = sessionLifecycle.beginDeletion(idOf(sessionB));
		const deletingB = deleteSessionFileInQueue(idOf(sessionB), sessionB, {
			selectReplacement: () => ({ id: idOf(sessionC), path: sessionC }),
			validateReplacement: () => undefined,
		});

		switchGate.resolve();
		await expect(deletingA).rejects.toBeInstanceOf(SessionUnavailableError);
		expect(session.sessionFile).toBe(sessionA);
		expect(existsSync(sessionA)).toBe(true);

		const bOutcome = await deletingB;
		expect(bOutcome).toEqual({ tookOver: false, newActiveId: null });
		expect(session.sessionFile).toBe(sessionA);
		expect(existsSync(sessionA)).toBe(true);
		expect(existsSync(sessionB)).toBe(false);

		sessionLifecycle.abortDeletion(aLease);
		sessionLifecycle.completeDeletion(bLease);
	});

	it("does not delete A when B becomes archived during the asynchronous switch", async () => {
		session.sessionFile = sessionA;
		const switchGate = deferred(), switchStarted = deferred();
		let archived = false;
		runtime.switchSession.mockImplementation(async (path: string) => {
			if (path === resolve(sessionB)) {
				switchStarted.resolve();
				await switchGate.promise;
			}
			session.sessionFile = path;
		});

		const lease = sessionLifecycle.beginDeletion(idOf(sessionA));
		const deleting = deleteSessionFileInQueue(idOf(sessionA), sessionA, {
			selectReplacement: () => ({ id: idOf(sessionB), path: sessionB }),
			validateReplacement: (replacement) => {
				if (archived || sessionLifecycle.isBlocked(replacement.id)) {
					throw new SessionUnavailableError(replacement.id, "ineligible");
				}
			},
		});
		await switchStarted.promise;
		archived = true; // the archive request wins while the SDK switch is paused
		switchGate.resolve();

		await expect(deleting).rejects.toMatchObject({ reason: "ineligible" });
		expect(session.sessionFile).toBe(sessionA);
		expect(existsSync(sessionA)).toBe(true);
		expect(existsSync(sessionB)).toBe(true);
		sessionLifecycle.abortDeletion(lease);
	});

	it("deletes a non-active A through the queue without letting queued chat recreate it", async () => {
		session.sessionFile = sessionB;
		await writeFile(sessionB, "B-original");
		const lease = sessionLifecycle.beginDeletion(idOf(sessionA));

		const deleting = deleteSessionFileInQueue(idOf(sessionA), sessionA, {
			selectReplacement: () => ({ id: idOf(sessionB), path: sessionB }),
			validateReplacement: () => undefined,
		});
		const prompting = runPromptInSession(sessionA, "queued non-streaming");
		const streaming = runPromptStreamingInSession(sessionA, "queued streaming", () => undefined);

		const outcome = await deleting;
		sessionLifecycle.completeDeletion(lease);

		expect(outcome).toEqual({ tookOver: false, newActiveId: null });
		await expect(prompting).rejects.toBeInstanceOf(SessionUnavailableError);
		await expect(streaming).rejects.toBeInstanceOf(SessionUnavailableError);
		expect(existsSync(sessionA)).toBe(false);
		expect(session.sessionFile).toBe(sessionB);
		expect(await readFile(sessionB, "utf-8")).toBe("B-original");
		expect(runtime.switchSession).not.toHaveBeenCalled();
	});
});
