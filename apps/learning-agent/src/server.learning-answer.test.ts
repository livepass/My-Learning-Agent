import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * End-to-end C2: a real server process, a local deterministic provider, a real
 * learning record. The provider answers both question generation and scoring by
 * inspecting the prompt (a real provider would do the same work). The only thing
 * faked is the model's text.
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(45_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const QUESTION_ANSWER = {
	prompt: "请用自己的话解释 Python 闭包为什么会持有外层变量。",
	kind: "free_recall",
	reference_answer: "闭包捕获的是变量绑定而不是值的副本。",
	rubric: [
		{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 },
		{ criterion_id: "c2", description: "说明生命周期被延长", weight: 1 },
	],
	hints: ["先想想变量存在哪里"],
};

const ASSESSMENT_ANSWER = {
	result: "correct",
	feedback: "回答准确，指出了变量绑定并说明了生命周期。",
	criteria: [
		{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" },
		{ criterion_id: "c2", judgment: "met", explanation: "提到生命周期" },
	],
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
		if (child.exitCode !== null) throw new Error("C2 server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* Startup is deliberately lazy. */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("C2 server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
	child.kill();
	await exited;
}

/** A mutable switch so a test can force the provider to fail mid-flow. */
let providerMode: "question" | "assessment" | "error" = "question";

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-c2-http-"));
	provider = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const answer = providerMode === "assessment" ? ASSESSMENT_ANSWER
			: providerMode === "error" ? null
				: QUESTION_ANSWER;
		if (answer === null) {
			// Simulate a provider-level failure (empty error reply).
			res.end("data: [DONE]\n\n");
			return;
		}
		const json = JSON.stringify(answer);
		res.write(`data: ${sseChunk(json.slice(0, 60), null)}\n\n`);
		res.write(`data: ${sseChunk(json.slice(60), null)}\n\n`);
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
	await stopServer();
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((yes) => provider.close(() => yes()));
	}
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-c2-http-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

/** Create a session, init its record, generate one question, and return the id. */
async function setupQuestion(): Promise<{ id: string; questionId: string; revision: number }> {
	providerMode = "question";
	const created = await post("/api/sessions", {});
	expect(created.status).toBe(201);
	const { id } = await created.json() as { id: string };
	await post(`/api/sessions/${id}/learning`, {});
	const generated = await post(`/api/sessions/${id}/learning/questions/generate`, {
		concept: "Python 闭包", request_id: "req_c2", expected_revision: 1, allow_model_fallback: true,
	});
	expect(generated.status).toBe(200);
	const body = await generated.json() as { question: { question_id: string }; checkpoint: { revision: number } };
	return { id, questionId: body.question.question_id, revision: body.checkpoint.revision };
}

it("saves an answer, scores it, and never leaks the reference answer", async () => {
	const { id, questionId, revision } = await setupQuestion();
	// 1. Save the answer.
	const saved = await post(`/api/sessions/${id}/learning/attempts`, {
		attempt_id: "attempt_e2e", question_id: questionId, question_version: "1",
		expected_revision: revision, answer: "闭包捕获变量绑定，所以外层变量仍可达。",
	});
	expect(saved.status).toBe(200);
	const savedBody = await saved.json() as {
		created: boolean; attempt: { attempt_id: string };
		checkpoint: { revision: number; pending_attempt_id: string };
	};
	expect(savedBody.created).toBe(true);
	expect(savedBody.checkpoint.pending_attempt_id).toBe("attempt_e2e");

	// 2. Score it (the provider now answers with an assessment).
	providerMode = "assessment";
	const evaluated = await post(`/api/sessions/${id}/learning/attempts/attempt_e2e/evaluate`, {
		revision: savedBody.checkpoint.revision,
	});
	expect(evaluated.status).toBe(200);
	const evalBody = await evaluated.json() as {
		replayed: boolean;
		assessment: { result: string; score: number; feedback: string; criteria: unknown[] };
		checkpoint: { step: string };
	};
	expect(evalBody.replayed).toBe(false);
	expect(evalBody.assessment.result).toBe("correct");
	expect(evalBody.assessment.score).toBe(1);
	// The checkpoint is NOT advanced past awaiting_answer (C3 does that).
	expect(evalBody.checkpoint.step).toBe("awaiting_answer");

	// The public response must not leak the reference answer or rubric weights.
	const serialized = JSON.stringify(evalBody);
	expect(serialized).not.toContain("闭包捕获的是变量绑定");
	expect(serialized).not.toContain("weight");

	// The record on disk keeps the private material + assessment.
	const record = JSON.parse(await readFile(join(home, "data", "learning", `${id}.json`), "utf-8"));
	expect(record.attempts).toHaveLength(1);
	expect(record.attempts[0].progress.stage).toBe("evaluated");
	expect(record.attempts[0].answer).toBe("闭包捕获变量绑定，所以外层变量仍可达。");
	expect(record.attempts[0].progress.assessment.result).toBe("correct");
}, 60_000);

it("replays a repeated submit and evaluate without a second write", async () => {
	const { id, questionId, revision } = await setupQuestion();

	const payload = { attempt_id: "attempt_retry", question_id: questionId, question_version: "1", expected_revision: revision, answer: "答案" };
	const first = await post(`/api/sessions/${id}/learning/attempts`, payload);
	expect(first.status).toBe(200);
	const firstBody = await first.json() as { checkpoint: { revision: number } };

	const retry = await post(`/api/sessions/${id}/learning/attempts`, payload);
	expect(retry.status).toBe(200);
	const retryBody = await retry.json() as { created: boolean; attempt: { attempt_id: string } };
	expect(retryBody.created).toBe(false);
	expect(retryBody.attempt.attempt_id).toBe("attempt_retry");

	// Evaluate once, then re-evaluate: the second is a no-op recovery, not a
	// second model call.
	providerMode = "assessment";
	const eval1 = await post(`/api/sessions/${id}/learning/attempts/attempt_retry/evaluate`, { revision: firstBody.checkpoint.revision });
	expect(eval1.status).toBe(200);
	const eval1Body = await eval1.json() as { checkpoint: { revision: number } };

	// After evaluation the checkpoint still names the pending attempt; asking to
	// evaluate again returns the already-evaluated state without another call.
	const eval2 = await post(`/api/sessions/${id}/learning/attempts/attempt_retry/evaluate`, { revision: eval1Body.checkpoint.revision });
	expect(eval2.status).toBe(200);
	const eval2Body = await eval2.json() as { replayed: boolean };
	expect(eval2Body.replayed).toBe(true);
}, 60_000);

it("restores a saved answer after a server restart", async () => {
	const { id, questionId, revision } = await setupQuestion();

	await post(`/api/sessions/${id}/learning/attempts`, {
		attempt_id: "attempt_restart", question_id: questionId, question_version: "1",
		expected_revision: revision, answer: "重启前的作答",
	});

	await stopServer();
	providerMode = "assessment";
	await startServer();

	const state = await request(`/api/sessions/${id}/learning`);
	expect(state.status).toBe(200);
	const learning = await state.json() as { checkpoint: { pending_attempt_id: string; step: string }; questions: unknown[] };
	expect(learning.checkpoint.pending_attempt_id).toBe("attempt_restart");
	expect(learning.checkpoint.step).toBe("awaiting_answer");
}, 120_000);
