import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * D3/D4 over the real HTTP API, real session files, a real B2 record and the
 * real L1 ledger.
 *
 * Locked behaviour:
 * - deleting the active session switches to an existing visible conversation
 *   and never creates a replacement;
 * - a hidden blank session is not eligible;
 * - with no eligible replacement the delete is refused (409) and nothing is
 *   created or modified;
 * - deleting a non-active session leaves the runtime and the learner's view
 *   alone;
 * - an explicit chat to a deleted session is a 404 and never falls back to the
 *   runtime's current session (the old behaviour wrote into B);
 * - a live stream still blocks deletion;
 * - deleting a session with C3 evidence removes B2 but leaves L1 untouched;
 * - after a restart the deleted id stays gone and the replacement still works.
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const known = new Set<string>();
const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown = {}) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (path: string) => request(path, { method: "DELETE" });

const QUESTION = {
	prompt: "请用自己的话解释 Python 闭包为什么会持有外层变量。",
	kind: "free_recall",
	reference_answer: "闭包捕获的是变量绑定而不是值的副本。",
	rubric: [{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 }],
	hints: ["先想想变量存在哪里"],
};
const ASSESSMENT = {
	result: "correct",
	feedback: "回答准确，指出了变量绑定。",
	criteria: [{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" }],
};

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
		if (child.exitCode !== null) throw new Error("delete server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* lazy startup */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("delete server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
	child.kill();
	await exited;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-delete-d3-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			const slow = body.includes("slow-delete");
			const answer = body.includes("judgment")
				? JSON.stringify(ASSESSMENT)
				: body.includes("只输出一个 JSON 对象")
					? JSON.stringify(QUESTION)
					: "收到。";
			setTimeout(() => {
				if (res.destroyed) return;
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.write(`data: ${sseChunk(answer.slice(0, 60), null)}\n\n`);
				res.write(`data: ${sseChunk(answer.slice(60), null)}\n\n`);
				res.write(`data: ${sseChunk("", "stop")}\n\n`);
				res.end("data: [DONE]\n\n");
			}, slow ? 1_800 : 0);
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
	await stopServer();
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((yes) => provider.close(() => yes()));
	}
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-delete-d3-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

const chatFile = (id: string) => join(home, "data", "sessions", id);
const readText = async (path: string) => readFile(path, "utf-8").catch(() => "");
const sessionFiles = async () => (await readdir(join(home, "data", "sessions")))
	.filter((file) => file.endsWith(".jsonl")).sort();
const evidenceCount = async () =>
	(await readText(join(home, "data", "learner", "events.jsonl"))).split("\n").filter(Boolean).length;

async function createSession(): Promise<string> {
	const created = await post("/api/sessions");
	expect(created.status).toBe(201);
	const id = ((await created.json()) as { id: string }).id;
	known.add(id);
	return id;
}

async function activate(id: string): Promise<void> {
	const response = await post(`/api/sessions/${encodeURIComponent(id)}/activate`);
	expect(response.status).toBe(200);
	expect(((await response.json()) as { active: boolean }).active).toBe(true);
}

async function chat(sessionId: string, prompt: string): Promise<string> {
	const response = await post("/api/chat", { sessionId, prompt });
	expect(response.status).toBe(200);
	return ((await response.json()) as { response: string }).response;
}

/** A request that genuinely omits `sessionId`: only this may use the runtime. */
async function chatUnscoped(prompt: string): Promise<string> {
	const response = await post("/api/chat", { prompt });
	expect(response.status).toBe(200);
	return ((await response.json()) as { response: string }).response;
}

/** Delete every known session except the ids we want to keep. */
async function cleanupExcept(...keep: string[]): Promise<void> {
	const kept = new Set(keep);
	for (const id of [...known]) {
		if (kept.has(id)) continue;
		if (!existsSync(chatFile(id))) { known.delete(id); continue; }
		const response = await del(`/api/sessions/${encodeURIComponent(id)}`);
		expect([200, 404]).toContain(response.status);
		known.delete(id);
	}
}

it("deleting the active session switches to an existing conversation instead of creating one", async () => {
	const a = await createSession();
	const b = await createSession();
	expect(await chat(b, "B 里的一条真实消息")).toBe("收到。");
	const bBefore = await readText(chatFile(b));
	const filesBefore = await sessionFiles();
	await activate(a);

	const response = await del(`/api/sessions/${encodeURIComponent(a)}`);
	expect(response.status).toBe(200);
	const body = await response.json() as { deleted: boolean; newActiveId: string | null; replacedWith: string | null };
	expect(body).toEqual({ id: a, deleted: true, newActiveId: b, replacedWith: "existing" });

	expect(existsSync(chatFile(a))).toBe(false);
	expect(existsSync(chatFile(b))).toBe(true);
	// B takes over untouched: same bytes, no new hidden successor.
	expect(await readText(chatFile(b))).toBe(bBefore);
	const filesAfter = await sessionFiles();
	expect(filesAfter).toHaveLength(filesBefore.length - 1);
	expect(filesAfter).not.toContain(a);
	expect(filesAfter).toContain(b);

	// The replacement is a real, visible conversation.
	const listed = await request("/api/sessions");
	const ids = (await listed.json() as Array<{ id: string }>).map((row) => row.id);
	expect(ids).toContain(b);
}, 60_000);

it("does not treat a hidden blank session as a replacement", async () => {
	const a = await createSession();
	await cleanupExcept(a);
	const blank = await createSession();
	await activate(a);
	const filesBefore = await sessionFiles();
	const aBefore = await readText(chatFile(a));

	const response = await del(`/api/sessions/${encodeURIComponent(a)}`);
	expect(response.status).toBe(409);
	const body = await response.json() as { error: string; requiresExplicitChoice?: boolean };
	expect(body.error).toBe("no_replacement_session");
	expect(body.requiresExplicitChoice).toBe(true);
	expect(await readText(chatFile(a))).toBe(aBefore);
	expect(existsSync(chatFile(blank))).toBe(true);
	expect(await sessionFiles()).toEqual(filesBefore);
}, 60_000);

it("refuses to delete the only session: 409, no file, no B2/L1 change", async () => {
	const only = await createSession();
	await cleanupExcept(only);
	await activate(only);
	const filesBefore = await sessionFiles();
	const chatBefore = await readText(chatFile(only));
	const profileBefore = await readText(join(home, "data", "learner", "profile.json"));
	const eventsBefore = await readText(join(home, "data", "learner", "events.jsonl"));

	const response = await del(`/api/sessions/${encodeURIComponent(only)}`);
	expect(response.status).toBe(409);
	expect(((await response.json()) as { error: string }).error).toBe("no_replacement_session");
	expect(await sessionFiles()).toEqual(filesBefore);
	expect(await readText(chatFile(only))).toBe(chatBefore);
	expect(await readText(join(home, "data", "learner", "profile.json"))).toBe(profileBefore);
	expect(await readText(join(home, "data", "learner", "events.jsonl"))).toBe(eventsBefore);

	// The documented remedy works: explicitly create B (creation makes it the
	// runtime), then A is non-active and can be removed without a replacement.
	const replacement = await createSession();
	const retry = await del(`/api/sessions/${encodeURIComponent(only)}`);
	expect(retry.status).toBe(200);
	const retryBody = await retry.json() as { newActiveId: string | null };
	expect(retryBody.newActiveId).toBeNull();
	expect(existsSync(chatFile(only))).toBe(false);
	expect(existsSync(chatFile(replacement))).toBe(true);
}, 60_000);

it("deleting a non-active session does not move the runtime or the view", async () => {
	const a = [...known].find((id) => existsSync(chatFile(id)));
	expect(a).toBeTruthy();
	const keep = a!;
	await activate(keep);
	const other = await createSession();
	await activate(keep);
	const aBefore = await readText(chatFile(keep));

	const response = await del(`/api/sessions/${encodeURIComponent(other)}`);
	expect(response.status).toBe(200);
	const body = await response.json() as { newActiveId: string | null; replacedWith: string | null };
	expect(body.newActiveId).toBeNull();
	expect(body.replacedWith).toBeNull();
	expect(existsSync(chatFile(other))).toBe(false);
	expect(await readText(chatFile(keep))).toBe(aBefore);

	// The runtime is still A: an unscoped request lands in A, not in a new one.
	expect(await chatUnscoped("只属于 A 的后续")).toBe("收到。");
}, 60_000);

it("never falls back to the runtime's current session for an explicit deleted id", async () => {
	const a = await createSession();
	const b = await createSession();
	await activate(a);
	await cleanupExcept(a, b);
	await chat(a, "A 的上下文");
	await chat(b, "B 的上下文");
	await activate(a);
	const bBefore = await readText(chatFile(b));

	const deleted = await del(`/api/sessions/${encodeURIComponent(a)}`);
	expect(deleted.status).toBe(200);
	expect(((await deleted.json()) as { newActiveId: string }).newActiveId).toBe(b);

	const explicit = await post("/api/chat", { sessionId: a, prompt: "这条消息绝不能落到 B" });
	expect(explicit.status).toBe(404);
	const stream = await post("/api/chat/stream", {
		sessionId: a, prompt: "stream must not fall back", clientRequestId: "deleted-a-stream",
	});
	expect(stream.status).toBe(404);
	expect(await readText(chatFile(b))).toBe(bBefore);

	// B is still the live runtime and accepts a new turn; no fallback needed.
	expect(await chat("", "B 的后续")).toBe("收到。");
	expect(await readText(chatFile(b))).not.toBe(bBefore);
}, 60_000);

it("refuses to delete a session with a live stream, and the file survives", async () => {
	const streamed = await createSession();
	await cleanupExcept(streamed);
	await activate(streamed);
	const stream = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt: "slow-delete", sessionId: streamed, clientRequestId: "delete-stream-1" }),
	});
	expect(stream.ok).toBe(true);

	const blocked = await del(`/api/sessions/${encodeURIComponent(streamed)}`);
	expect(blocked.status).toBe(409);
	expect(((await blocked.json()) as { error: string }).error).toContain("active chat turn");
	expect(existsSync(chatFile(streamed))).toBe(true);
	// Drain the turn so it cannot still hold the queue in the next test.
	await stream.text();
}, 60_000);

it("deletes B2 but leaves L1 evidence intact when the active session has C3 history", async () => {
	const a = await createSession();
	await cleanupExcept(a);
	expect((await post(`/api/sessions/${encodeURIComponent(a)}/learning`)).status).toBe(200);
	const generated = await post(`/api/sessions/${encodeURIComponent(a)}/learning/questions/generate`, {
		concept: "Python 闭包", request_id: "req_delete", expected_revision: 1, allow_model_fallback: true,
	});
	expect(generated.status).toBe(200);
	const generatedBody = await generated.json() as {
		question: { question_id: string; question_version: string };
		checkpoint: { revision: number };
	};
	const saved = await post(`/api/sessions/${encodeURIComponent(a)}/learning/attempts`, {
		attempt_id: "a_delete",
		question_id: generatedBody.question.question_id,
		question_version: generatedBody.question.question_version,
		expected_revision: generatedBody.checkpoint.revision,
		answer: "闭包捕获变量绑定，外层变量仍然可达。",
	});
	expect(saved.status).toBe(200);
	const savedBody = await saved.json() as { checkpoint: { revision: number } };
	const evaluated = await post(`/api/sessions/${encodeURIComponent(a)}/learning/attempts/a_delete/evaluate`, {
		revision: savedBody.checkpoint.revision,
	});
	expect(evaluated.status).toBe(200);
	const evaluatedBody = await evaluated.json() as { checkpoint: { revision: number } };
	const finalized = await post(`/api/sessions/${encodeURIComponent(a)}/learning/attempts/a_delete/finalize`, {
		revision: evaluatedBody.checkpoint.revision,
	});
	expect(finalized.status).toBe(200);

	const b2 = join(home, "data", "learning", `${a}.json`);
	const profile = join(home, "data", "learner", "profile.json");
	const events = join(home, "data", "learner", "events.jsonl");
	const profileBefore = await readText(profile);
	const eventsBefore = await readText(events);
	const evidenceBefore = await evidenceCount();
	expect(existsSync(b2)).toBe(true);

	const b = await createSession();
	expect(await chat(b, "B 用来接管")).toBe("收到。");
	await activate(a);

	const response = await del(`/api/sessions/${encodeURIComponent(a)}`);
	expect(response.status).toBe(200);
	expect(((await response.json()) as { newActiveId: string }).newActiveId).toBe(b);
	expect(existsSync(chatFile(a))).toBe(false);
	expect(existsSync(b2)).toBe(false);
	expect((await request(`/api/sessions/${encodeURIComponent(a)}/learning`)).status).toBe(404);
	expect(await readText(profile)).toBe(profileBefore);
	expect(await readText(events)).toBe(eventsBefore);
	expect(await evidenceCount()).toBe(evidenceBefore);
}, 120_000);

it("keeps the deleted id gone after a restart and the replacement usable", async () => {
	// The latest D3 pair from the previous test: A deleted, B took over.
	const surviving = [...known].filter((id) => existsSync(chatFile(id)));
	expect(surviving.length).toBeGreaterThan(0);
	const b = surviving[surviving.length - 1];
	const deletedA = [...known].find((id) => !existsSync(chatFile(id)));
	expect(deletedA).toBeTruthy();

	await stopServer();
	await startServer();

	const explicit = await post("/api/chat", { sessionId: deletedA, prompt: "restart must not revive it" });
	expect(explicit.status).toBe(404);
	expect(existsSync(chatFile(deletedA!))).toBe(false);

	await activate(b);
	expect(await chat(b, "重启后继续使用")).toBe("收到。");
}, 120_000);
