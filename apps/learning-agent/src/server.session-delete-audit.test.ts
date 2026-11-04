import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * Audit-only harness for D3/D4. It asserts what the *current* server does when
 * the active session is deleted, so the report can separate "observed" from
 * "designed". Nothing here changes production behaviour.
 *
 * Scenarios:
 * 1. active A + existing B -> DELETE A: the server creates a new session
 *    instead of switching to B (the D3 gap).
 * 2. deleting a non-active B leaves the runtime alone (newActiveId null).
 * 3. deleting the only session still creates a replacement (the D4 gap: no
 *    supported "no active session" state).
 * 4. a streaming session cannot be deleted (409), and its file survives.
 * 5. activating a deleted session is a 404 (no resurrection through activate).
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown = {}) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (path: string) => request(path, { method: "DELETE" });

function sseChunk(content: string, finish: string | null): string {
	return JSON.stringify({
		id: "fixture", object: "chat.completion.chunk", created: 0, model: "dummy",
		choices: [{ index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: finish }],
	});
}

async function startServer(): Promise<void> {
	child = spawn(process.execPath, [
		"--import", "tsx", resolve("apps/learning-agent/src/server.ts"),
		"--home", home,
		"--config-dir", join(home, "config"),
		"--data-dir", join(home, "data"),
		"--workspace", join(home, "workspace"),
		"--skills-dir", join(home, "skills"),
		"--port", String(port),
	], { cwd: process.cwd(), stdio: "ignore" });
	const deadline = Date.now() + 80_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("audit server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* lazy startup */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("audit server readiness timeout");
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-delete-audit-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			const slow = body.includes("slow-audit");
			setTimeout(() => {
				if (res.destroyed) return;
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.write(`data: ${sseChunk("收到。", null)}\n\n`);
				res.write(`data: ${sseChunk("", "stop")}\n\n`);
				res.end("data: [DONE]\n\n");
			}, slow ? 1_500 : 0);
		});
	});
	await new Promise<void>((yes) => provider.listen(0, "127.0.0.1", yes));
	const providerPort = (provider.address() as { port: number }).port;

	const allocator = createServer();
	await new Promise<void>((yes) => allocator.listen(0, "127.0.0.1", yes));
	port = (allocator.address() as { port: number }).port;
	await new Promise<void>((yes) => allocator.close(() => yes()));

	await mkdir(join(home, "config"), { recursive: true });
	await writeFile(join(home, "config", "config.json"), JSON.stringify({
		providers: { fixture: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: "fixture", models: [{ id: "dummy" }] } },
		memory: { l1Enabled: true, l2Enabled: false, l3Enabled: false },
	}));
	await startServer();
}, 120_000);

afterAll(async () => {
	if (child && child.exitCode === null) {
		const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
		child.kill();
		await exited;
	}
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((yes) => provider.close(() => yes()));
	}
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-delete-audit-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

async function createSession(): Promise<string> {
	const created = await post("/api/sessions");
	expect(created.status).toBe(201);
	return ((await created.json()) as { id: string }).id;
}

async function activate(id: string): Promise<void> {
	const response = await post(`/api/sessions/${encodeURIComponent(id)}/activate`);
	expect(response.status).toBe(200);
	expect(((await response.json()) as { active: boolean }).active).toBe(true);
}

const chatFile = (id: string) => join(home, "data", "sessions", id);

let deletedActive: string;
let existingB: string;
let replacement: string;

it("records that deleting the active session creates a replacement instead of switching to B", async () => {
	const a = await createSession();
	const b = await createSession();
	await activate(a);

	const response = await del(`/api/sessions/${encodeURIComponent(a)}`);
	expect(response.status).toBe(200);
	const body = await response.json() as { deleted: boolean; newActiveId: string | null };
	expect(body.deleted).toBe(true);
	expect(body.newActiveId).toBeTruthy();

	// Observed baseline: the replacement is a brand-new session, not the
	// existing B that a D3 design would pick.
	expect(body.newActiveId).not.toBe(a);
	expect(body.newActiveId).not.toBe(b);
	expect(existsSync(chatFile(a))).toBe(false);
	expect(existsSync(chatFile(b))).toBe(true);
	expect(existsSync(chatFile(body.newActiveId!))).toBe(true);

	deletedActive = a;
	existingB = b;
	replacement = body.newActiveId!;
}, 60_000);

it("leaves the runtime alone when a non-active session is deleted", async () => {
	// B never received a message, so the list intentionally hides it; the audit
	// keeps its id from the creation response.
	const response = await del(`/api/sessions/${encodeURIComponent(existingB)}`);
	expect(response.status).toBe(200);
	const body = await response.json() as { newActiveId: string | null };
	expect(body.newActiveId).toBeNull();
	expect(existsSync(chatFile(existingB))).toBe(false);
	expect(existsSync(chatFile(replacement))).toBe(true);
}, 60_000);

it("still creates a session when the only session is deleted (no unbind state)", async () => {
	// Delete the current replacement, then the next one, until a single
	// session remains; the final delete must still create a successor.
	const current = replacement;
	const response = await del(`/api/sessions/${encodeURIComponent(current)}`);
	expect(response.status).toBe(200);
	const first = await response.json() as { newActiveId: string | null };
	expect(first.newActiveId).toBeTruthy();

	const second = await del(`/api/sessions/${encodeURIComponent(first.newActiveId!)}`);
	expect(second.status).toBe(200);
	const secondBody = await second.json() as { newActiveId: string | null };
	expect(secondBody.newActiveId).toBeTruthy();
	expect(secondBody.newActiveId).not.toBe(first.newActiveId);
	expect(existsSync(chatFile(secondBody.newActiveId!))).toBe(true);

	// Observed baseline: the replacement is created without channel metadata and
	// has no messages, so GET /api/sessions hides it (origin falls back to "cli",
	// sessions.ts:281-297 + filter). The runtime is bound to a session the list
	// does not show — a D4 finding, recorded rather than treated as correct.
	const listed = await request("/api/sessions");
	const ids = (await listed.json() as Array<{ id: string }>).map((row) => row.id);
	expect(ids).not.toContain(secondBody.newActiveId);

	replacement = secondBody.newActiveId!;
}, 60_000);

it("refuses to delete a session with a live stream, and the file survives", async () => {
	const streamed = await createSession();
	await activate(streamed);

	const stream = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt: "slow-audit", sessionId: streamed, clientRequestId: "audit-stream-1" }),
	});
	expect(stream.ok).toBe(true);

	const blocked = await del(`/api/sessions/${encodeURIComponent(streamed)}`);
	expect(blocked.status).toBe(409);
	expect(((await blocked.json()) as { error: string }).error).toContain("active chat turn");
	expect(existsSync(chatFile(streamed))).toBe(true);
	await stream.body?.cancel().catch(() => undefined);
}, 60_000);

it("cannot re-activate a deleted session", async () => {
	const response = await post(`/api/sessions/${encodeURIComponent(deletedActive)}/activate`);
	expect(response.status).toBe(404);
	const stream = await post("/api/chat/stream", {
		prompt: "hello", sessionId: deletedActive, clientRequestId: "audit-stream-2",
	});
	expect(stream.status).toBe(404);
}, 60_000);
