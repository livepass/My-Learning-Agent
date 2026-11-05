import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * E1: editing a persisted user turn must branch the real PI session before the
 * replacement prompt. The old answer belongs to the abandoned branch and must
 * not survive as the answer to the edited message.
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown = {}) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
		if (child.exitCode !== null) throw new Error("branch server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* lazy startup */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("branch server readiness timeout");
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-branch-http-"));
	provider = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(`data: ${sseChunk("收到。", null)}\n\n`);
		res.write(`data: ${sseChunk("", "stop")}\n\n`);
		res.end("data: [DONE]\n\n");
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-branch-http-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

async function createSession(): Promise<string> {
	const created = await post("/api/sessions");
	expect(created.status).toBe(201);
	return ((await created.json()) as { id: string }).id;
}

async function chat(sessionId: string, prompt: string): Promise<void> {
	const response = await post("/api/chat", { sessionId, prompt });
	expect(response.status).toBe(200);
}

async function messages(sessionId: string): Promise<Array<{ role: string; content: string; entryId?: string }>> {
	const response = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
	expect(response.status).toBe(200);
	return ((await response.json()) as { messages: Array<{ role: string; content: string; entryId?: string }> }).messages;
}

it("branches before an edited user turn and never reuses the abandoned answer", async () => {
	const id = await createSession();
	await chat(id, "第一问：解释闭包");
	await chat(id, "第二问：闭包与作用域");

	const before = await messages(id);
	expect(before).toHaveLength(4);
	const firstUser = before[0]!;
	expect(firstUser.role).toBe("user");
	expect(firstUser.entryId).toBeTruthy();

	const branched = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: firstUser.entryId,
	});
	expect(branched.status).toBe(200);
	const branchBody = await branched.json() as { sessionId: string; replacedEntryId: string; branchMarkerId: string };
	expect(branchBody).toMatchObject({ sessionId: id, replacedEntryId: firstUser.entryId });
	expect(await messages(id)).toHaveLength(0);

	await chat(id, "修改后的问题：闭包捕获变量绑定");
	const after = await messages(id);
	expect(after).toHaveLength(2);
	expect(after[0]).toMatchObject({ role: "user", content: "修改后的问题：闭包捕获变量绑定" });
	expect(after[1]).toMatchObject({ role: "assistant", content: "收到。" });
	expect(after.some((message) => message.content.includes("第一问"))).toBe(false);
	expect(after.some((message) => message.content.includes("第二问"))).toBe(false);
}, 90_000);

it("rejects an entry that is no longer on the active branch", async () => {
	const id = await createSession();
	await chat(id, "第一问");
	await chat(id, "第二问");
	const before = await messages(id);
	const first = before[0]!;
	const second = before[2]!;

	expect((await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: first.entryId,
	})).status).toBe(200);

	const stale = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: second.entryId,
	});
	expect([404, 409]).toContain(stale.status);
	expect(["entry_not_found", "not_active_branch"]).toContain(
		((await stale.json()) as { code?: string }).code,
	);
	expect(await messages(id)).toHaveLength(0);
}, 90_000);
