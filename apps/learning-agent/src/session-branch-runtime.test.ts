import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeModelConfig } from "../src/config.js";
import { resolveRuntimePaths } from "../src/runtime.js";
import {
	branchSessionBeforeUserMessage,
	initSession,
	runPromptInSession,
	SessionEditError,
} from "../src/agent/pi-runner.js";
import { BranchEditRefusedError } from "../src/learning/branch-edit-guard.js";

/**
 * E1.1: the B2 guard and the branch-marker check must both run inside the Agent
 * queue slot that performs the mutation, not in the HTTP handler that merely
 * enqueued the task. The barriers below are real deferred promises, so each
 * assertion is about ordering, not about timing.
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

interface FakeEntry {
	id: string;
	type: string;
	parentId?: string;
	message?: { role: string; content: string };
}

let root: string;
let seq = 0;
let sessionA: string;
let sessionB: string;
let entries: FakeEntry[];
let leafId: string | null;
let manager: {
	getEntry: (id: string) => FakeEntry | undefined;
	getBranch: () => FakeEntry[];
	branch: ReturnType<typeof vi.fn>;
	resetLeaf: ReturnType<typeof vi.fn>;
	appendCustomEntry: ReturnType<typeof vi.fn>;
};
let session: {
	sessionFile: string;
	bindExtensions: ReturnType<typeof vi.fn>;
	sessionManager: typeof manager;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	refreshContext: ReturnType<typeof vi.fn>;
	agent: { transformContext: unknown };
};
let runtime: {
	session: typeof session;
	newSession: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "inno-branch-runtime-"));
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
	await Promise.all([sessionA, sessionB].map(path => writeFile(path, "")));

	entries = [
		{ id: "root", type: "session_info" },
		{ id: "u1", type: "message", parentId: "root", message: { role: "user", content: "第一问" } },
		{ id: "a1", type: "message", parentId: "u1", message: { role: "assistant", content: "回答" } },
	];
	leafId = "a1";
	manager = {
		getEntry: (id) => entries.find(entry => entry.id === id),
		getBranch: () => {
			const path: FakeEntry[] = [];
			let current = leafId ? entries.find(entry => entry.id === leafId) : undefined;
			while (current) {
				path.push(current);
				current = current.parentId ? entries.find(entry => entry.id === current!.parentId) : undefined;
			}
			return path.reverse();
		},
		branch: vi.fn((id: string) => { leafId = id; }),
		resetLeaf: vi.fn(() => { leafId = null; }),
		appendCustomEntry: vi.fn((_type: string, _data: unknown) => {
			const id = `marker-${entries.length}`;
			entries.push({ id, type: "custom", parentId: leafId ?? undefined });
			leafId = id;
			return id;
		}),
	};
	session = {
		sessionFile: sessionB,
		bindExtensions: vi.fn().mockResolvedValue(undefined),
		sessionManager: manager,
		subscribe: vi.fn(() => () => undefined),
		prompt: vi.fn(async () => undefined),
		refreshContext: vi.fn(),
		agent: { transformContext: undefined as unknown },
	};
	runtime = {
		session,
		newSession: vi.fn(),
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
	if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("inno-branch-runtime-")) {
		throw new Error("Unexpected branch runtime cleanup path");
	}
	await rm(root, { recursive: true, force: true });
});

describe("E1.1 branch guard ordering", () => {
	it("runs beforeBranch inside the queue slot, after the session switch", async () => {
		const gate = deferred(), switched = deferred();
		runtime.switchSession.mockImplementation(async (path: string) => {
			switched.resolve();
			await gate.promise;
			session.sessionFile = path;
		});
		let guardRan = false;
		const branching = branchSessionBeforeUserMessage(sessionA, "u1", {
			beforeBranch: () => { guardRan = true; },
		});
		await switched.promise;
		// The task is inside its slot, still waiting on the SDK switch.
		expect(guardRan).toBe(false);
		expect(manager.branch).not.toHaveBeenCalled();

		gate.resolve();
		const result = await branching;
		expect(guardRan).toBe(true);
		expect(manager.branch).toHaveBeenCalledWith("root");
		expect(manager.appendCustomEntry).toHaveBeenCalledTimes(1);
		expect(result.branchMarkerId).toBe(leafId);
	});

	it("leaves the tree untouched when beforeBranch refuses", async () => {
		await expect(branchSessionBeforeUserMessage(sessionA, "u1", {
			beforeBranch: () => { throw new BranchEditRefusedError("learning_evidence_locked", "locked"); },
		})).rejects.toBeInstanceOf(BranchEditRefusedError);

		expect(manager.branch).not.toHaveBeenCalled();
		expect(manager.resetLeaf).not.toHaveBeenCalled();
		expect(manager.appendCustomEntry).not.toHaveBeenCalled();
		expect(leafId).toBe("a1");
	});
});

describe("E1.1 branch marker commit check", () => {
	it("appends only while the expected marker is still the branch head", async () => {
		leafId = "marker-current";
		entries.push({ id: "marker-current", type: "custom", parentId: "a1" });

		await expect(runPromptInSession(sessionA, "修改后的问题", undefined, undefined, "marker-current"))
			.resolves.toBe("");
		expect(session.prompt).toHaveBeenCalledTimes(1);
	});

	it("refuses the prompt when another request changed the branch", async () => {
		leafId = "someone-elses-message";
		entries.push({ id: "someone-elses-message", type: "message", parentId: "a1", message: { role: "user", content: "并发问题" } });

		await expect(runPromptInSession(sessionA, "过期分支的问题", undefined, undefined, "marker-old"))
			.rejects.toMatchObject({ name: "SessionEditError", code: "stale_branch" });
		expect(session.prompt).not.toHaveBeenCalled();
		// The runtime was switched to A (the marker check runs there), but no
		// message was appended.
		expect(session.sessionFile).toBe(sessionA);
	});

	it("keeps the plain (unmarked) send working", async () => {
		await expect(runPromptInSession(sessionA, "普通问题")).resolves.toBe("");
		expect(session.prompt).toHaveBeenCalledTimes(1);
	});
});

describe("E1.1 error type", () => {
	it("carries a machine code the route can map", () => {
		const err = new SessionEditError("stale_branch", "changed");
		expect(err.code).toBe("stale_branch");
	});
});
