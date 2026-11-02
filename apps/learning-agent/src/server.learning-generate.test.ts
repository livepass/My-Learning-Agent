import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * End-to-end C1: a real server process, a real (local, deterministic) provider,
 * a real learning record on disk. The only thing faked is the model reply.
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(45_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const ANSWER = {
	prompt: "请用自己的话解释 Python 闭包为什么会持有外层变量。",
	kind: "free_recall",
	reference_answer: "闭包捕获的是变量绑定而不是值的副本，因此外层变量在函数返回后仍然可达。",
	rubric: [
		{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 },
		{ criterion_id: "c2", description: "说明生命周期被延长", weight: 1 },
	],
	hints: ["先想想变量存在哪里"],
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
		if (child.exitCode !== null) throw new Error("C1 server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* Startup is deliberately lazy. */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("C1 server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
	child.kill();
	await exited;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-c1-http-"));
	provider = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		// Two content chunks so the client has to concatenate, as a real stream does.
		res.write(`data: ${sseChunk(JSON.stringify(ANSWER).slice(0, 60), null)}\n\n`);
		res.write(`data: ${sseChunk(JSON.stringify(ANSWER).slice(60), null)}\n\n`);
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
		// L2 off on purpose: C1 must still work through the model-knowledge path.
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-c1-http-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

it("generates, persists and restores one question with its knowledge basis", async () => {
	const created = await post("/api/sessions", {});
	expect(created.status).toBe(201);
	const { id } = await created.json() as { id: string };

	const init = await post(`/api/sessions/${id}/learning`, {});
	expect(init.status).toBe(200);
	expect((await init.json() as { checkpoint: { revision: number } }).checkpoint.revision).toBe(1);

	const generated = await post(`/api/sessions/${id}/learning/questions/generate`, {
		concept: "Python 闭包",
		request_id: "req_e2e_1",
		expected_revision: 1,
		allow_model_fallback: true,
	});
	expect(generated.status).toBe(200);
	const body = await generated.json() as {
		created: boolean;
		question: Record<string, unknown>;
		checkpoint: { revision: number; step: string; question: { question_id: string }; knowledge: { kind: string } };
		knowledge: { kind: string };
	};

	expect(body.created).toBe(true);
	expect(body.checkpoint.revision).toBe(2);
	expect(body.checkpoint.step).toBe("awaiting_answer");
	expect(body.knowledge.kind).toBe("model_knowledge");
	expect(body.checkpoint.knowledge.kind).toBe("model_knowledge");
	expect(body.question.prompt).toBe(ANSWER.prompt);
	// Public projection only: no answer material, no provenance blob.
	expect(JSON.stringify(body)).not.toContain(ANSWER.reference_answer);
	expect(JSON.stringify(body.question)).not.toContain("rubric");
	expect(JSON.stringify(body.question)).not.toContain("hints");
	expect(JSON.stringify(body.question)).not.toContain("knowledge");
	expect(JSON.stringify(body)).not.toContain("snippet");

	// The record on disk keeps the private material and the model identity.
	const record = JSON.parse(await readFile(join(home, "data", "learning", `${id}.json`), "utf-8"));
	expect(record.questions).toHaveLength(1);
	expect(record.questions[0].reference_answer).toBe(ANSWER.reference_answer);
	expect(record.questions[0].knowledge.kind).toBe("model_knowledge");
	expect(record.questions[0].knowledge.model.model_id).toBe("dummy");
	expect(record.questions[0].generation.request_id).toBe("req_e2e_1");

	// Reading the public state returns the same question without private fields.
	const state = await request(`/api/sessions/${id}/learning`);
	const learning = await state.json() as {
		checkpoint: { step: string; question: { question_id: string }; knowledge: { kind: string } };
		questions: Array<Record<string, unknown>>;
	};
	expect(learning.checkpoint.step).toBe("awaiting_answer");
	expect(learning.checkpoint.question.question_id).toBe(body.question.question_id);
	expect(learning.checkpoint.knowledge.kind).toBe("model_knowledge");
	expect(JSON.stringify(learning)).not.toContain(ANSWER.reference_answer);
	expect(JSON.stringify(learning)).not.toContain("rubric");
}, 60_000);

it("replays a repeated request without generating a second question", async () => {
	const created = await post("/api/sessions", {});
	const { id } = await created.json() as { id: string };
	await post(`/api/sessions/${id}/learning`, {});

	const payload = { concept: "Python 闭包", request_id: "req_retry", expected_revision: 1, allow_model_fallback: true };
	const first = await post(`/api/sessions/${id}/learning/questions/generate`, payload);
	expect(first.status).toBe(200);
	const firstBody = await first.json() as { question: { question_id: string }; checkpoint: { revision: number } };

	const retry = await post(`/api/sessions/${id}/learning/questions/generate`, payload);
	expect(retry.status).toBe(200);
	const retryBody = await retry.json() as { created: boolean; question: { question_id: string }; checkpoint: { revision: number } };
	expect(retryBody.created).toBe(false);
	expect(retryBody.question.question_id).toBe(firstBody.question.question_id);
	expect(retryBody.checkpoint.revision).toBe(firstBody.checkpoint.revision);

	const record = JSON.parse(await readFile(join(home, "data", "learning", `${id}.json`), "utf-8"));
	expect(record.questions).toHaveLength(1);
}, 60_000);

it("rejects a stale revision and an invalid payload", async () => {
	const created = await post("/api/sessions", {});
	const { id } = await created.json() as { id: string };
	await post(`/api/sessions/${id}/learning`, {});

	const stale = await post(`/api/sessions/${id}/learning/questions/generate`, {
		concept: "Python 闭包", request_id: "req_stale", expected_revision: 0, allow_model_fallback: true,
	});
	expect(stale.status).toBe(409);

	const invalid = await post(`/api/sessions/${id}/learning/questions/generate`, {
		concept: "", request_id: "req_invalid", expected_revision: 1, allow_model_fallback: true,
	});
	expect(invalid.status).toBe(400);

	const missing = await post(`/api/sessions/nope.jsonl/learning/questions/generate`, {
		concept: "闭包", request_id: "req_missing", expected_revision: 1, allow_model_fallback: true,
	});
	expect(missing.status).toBe(404);
}, 60_000);

it("restores the same question after a server restart", async () => {
	const created = await post("/api/sessions", {});
	const { id } = await created.json() as { id: string };
	await post(`/api/sessions/${id}/learning`, {});
	const generated = await post(`/api/sessions/${id}/learning/questions/generate`, {
		concept: "Python 闭包", request_id: "req_restart", expected_revision: 1, allow_model_fallback: true,
	});
	const body = await generated.json() as { question: { question_id: string } };

	await stopServer();
	await startServer();

	const state = await request(`/api/sessions/${id}/learning`);
	expect(state.status).toBe(200);
	const learning = await state.json() as {
		checkpoint: { revision: number; step: string; question: { question_id: string } };
		questions: Array<{ question_id: string; prompt: string }>;
	};
	expect(learning.checkpoint.revision).toBe(2);
	expect(learning.checkpoint.step).toBe("awaiting_answer");
	expect(learning.checkpoint.question.question_id).toBe(body.question.question_id);
	expect(learning.questions).toHaveLength(1);
	expect(learning.questions[0].prompt).toBe(ANSWER.prompt);
	// Still no private material in the public view after a restart.
	expect(JSON.stringify(learning)).not.toContain(ANSWER.reference_answer);
}, 120_000);
