import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

let home: string, port: number, child: ChildProcess, provider: Server;
const request = (path: string, options?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(45_000) });
const post = (path: string, body: unknown) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-learning-http-"));
	provider = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "dummy", choices: [{ index: 0, delta: { role: "assistant", content: "Learning connection verified" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "dummy", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>(yes => provider.listen(0, "127.0.0.1", yes));
	const providerPort = (provider.address() as { port: number }).port;
	const allocator = createServer();
	await new Promise<void>(yes => allocator.listen(0, "127.0.0.1", yes));
	port = (allocator.address() as { port: number }).port;
	await new Promise<void>(yes => allocator.close(() => yes()));
	await mkdir(join(home, "config"), { recursive: true });
	await writeFile(join(home, "config", "config.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: "fixture", models: [{ id: "dummy" }] } }, memory: { l1Enabled: true, l2Enabled: false, l3Enabled: false }, mcp: { enabled: true }, plugins: { computerUse: { enabled: true }, officeEngine: { enabled: true }, codemode: { enabled: true } } }));
	child = spawn(process.execPath, ["--import", "tsx", resolve("apps/learning-agent/src/server.ts"), "--home", home, "--config-dir", join(home, "config"), "--data-dir", join(home, "data"), "--workspace", join(home, "workspace"), "--skills-dir", join(home, "skills"), "--port", String(port)], { cwd: process.cwd(), stdio: "ignore" });
	const deadline = Date.now() + 80_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("Learning server exited before readiness");
		try { if ((await request("/health")).ok) return; } catch { /* Startup is deliberately lazy. */ }
		await new Promise(yes => setTimeout(yes, 200));
	}
	throw new Error("Learning server readiness timeout");
}, 90_000);
afterAll(async () => {
	if (child && child.exitCode === null) { const exited = new Promise<void>(yes => child.once("exit", () => yes())); child.kill(); await exited; }
	if (provider) { provider.closeAllConnections(); await new Promise<void>(yes => provider.close(() => yes())); }
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-learning-http-")) await rm(home, { recursive: true, force: true });
}, 15_000);

it("returns one effective policy and rejects direct disabled APIs before initialization", async () => {
	const response = await request("/api/settings"); expect(response.status).toBe(200);
	const settings = await response.json() as { effectiveCapabilities: { schemaVersion: number; capabilities: Record<string, { enabled: boolean; reason?: string }> }; plugins?: unknown; computerUse?: unknown };
	expect(settings.effectiveCapabilities.schemaVersion).toBe(1);
	expect("profile" in settings.effectiveCapabilities).toBe(false);
	expect(settings.effectiveCapabilities.capabilities.learnerRead.enabled).toBe(true);
	expect(settings.effectiveCapabilities.capabilities.memoryL2).toEqual({ enabled: false, reason: "config_disabled" });
	expect(settings.effectiveCapabilities.capabilities.terminal).toEqual({ enabled: false, reason: "removed" });
	expect(settings.plugins).toBeUndefined(); expect(settings.computerUse).toBeUndefined();
	for (const path of ["/api/jobs", "/api/checkins", "/api/terminal/sessions", "/api/workspace/tree", "/api/mcp", "/api/skill-library", "/api/sessions/missing/showcase-export"]) {
		const rejected = await request(path); expect(rejected.status, path).toBe(403);
		expect((await rejected.json() as { error: string }).error).toBe("capability_disabled");
	}
	for (const relative of ["config/mcp-adapter.json", "data/jobs/jobs.json", "data/runs", "data/l2/index.db", "data/l3/memory.db"]) await expect(access(join(home, relative))).rejects.toThrow();
});
it("cannot create a preset workspace or reopen a disabled plugin through settings", async () => {
	expect((await post("/api/sessions", { presetId: "forbidden" })).status).toBe(403);
	expect((await request("/api/settings/computer-use", { method: "PUT", body: JSON.stringify({ enabled: true }) })).status).toBe(403);
	expect((await post("/api/settings/model", { provider: "fixture", model: "dummy", profile: "full" })).status).toBe(400);
	const persisted = JSON.parse(await readFile(join(home, "config", "config.json"), "utf8"));
	expect(persisted.profile).toBeUndefined();
	expect((await readdir(join(home, "data", "sessions"))).filter(name => name.endsWith(".jsonl")).length).toBeLessThanOrEqual(1);
});
it("supports real local-provider chat, session replacements and configuration saves without widening the profile", async () => {
	const created = await post("/api/sessions", {}); expect(created.status).toBe(201);
	const { id } = await created.json() as { id: string };
	const chat = await post("/api/chat", { sessionId: id, prompt: "Connection check" }); expect(chat.status).toBe(200);
	expect(JSON.stringify(await chat.json())).toContain("Learning connection verified");
	const saved = await request("/api/settings/theme", { method: "PUT", body: JSON.stringify({ theme: "dark" }) });
	expect(saved.status).toBe(200);
	const savedCaps = (await saved.json() as { effectiveCapabilities: { schemaVersion: number; capabilities: Record<string, { enabled: boolean }> } }).effectiveCapabilities;
	expect(savedCaps.schemaVersion).toBe(1); expect("profile" in savedCaps).toBe(false); expect(savedCaps.capabilities.learnerRead.enabled).toBe(true);
	expect(JSON.parse(await readFile(join(home, "config", "config.json"), "utf8")).profile).toBeUndefined();
	expect((await request("/api/definitely-unknown")).status).toBe(404);
}, 60_000);
