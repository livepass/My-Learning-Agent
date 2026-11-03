import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * End-to-end C4-A: two complete questions in one learning session against a real
 * server process, a real B2 record and a real L1 ledger. The only fake is the
 * model's text, served by a local deterministic provider that distinguishes
 * generation from scoring by the request it receives.
 *
 * The flow under test is the acceptance gate: A → answer → score → record
 * evidence → B → answer → score → record → restart → replay. Every step goes
 * through HTTP; nothing pokes at the stores directly except to assert the
 * private authoritative file and the evidence ledger.
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;
let providerCalls = 0;
let generationRound = 0;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const RUBRIC = [{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 }];

function questionReply() {
	generationRound += 1;
	return {
		prompt: generationRound === 1
			? "第一题：请解释 Python 闭包为什么会持有外层变量。"
			: "第二题：闭包在循环里捕获变量时会发生什么？",
		kind: "free_recall",
		reference_answer: "闭包捕获的是变量绑定而不是值的副本。",
		rubric: RUBRIC,
		hints: ["先想想变量存在哪里"],
	};
}

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
		if (child.exitCode !== null) throw new Error("C4 server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* Startup is deliberately lazy. */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("C4 server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
	child.kill();
	await exited;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-c4-http-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			providerCalls += 1;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			// A scoring prompt names the rubric judgment; a generation prompt asks
			// for a question. This is the same way a real provider is prompted.
			const answer = body.includes("criterion_id") && body.includes("judgment") ? ASSESSMENT : questionReply();
			const json = JSON.stringify(answer);
			res.write(`data: ${sseChunk(json.slice(0, 60), null)}\n\n`);
			res.write(`data: ${sseChunk(json.slice(60), null)}\n\n`);
			res.write(`data: ${sseChunk("", "stop")}\n\n`);
			res.end("data: [DONE]\n\n");
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-c4-http-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

type CheckpointView = {
	revision: number;
	status: string;
	step: string;
	question?: { question_id: string; question_version: string };
	pending_attempt_id?: string;
	last_completed_attempt_id?: string;
	knowledge?: { kind: string };
};
type AttemptView = {
	attempt_id: string;
	question_id: string;
	question_version: string;
	answer: string;
	stage: string;
	assessment?: { result: string; feedback: string; score?: number };
};
type LearningView = {
	exists: boolean;
	checkpoint: CheckpointView;
	questions: Array<{ question_id: string; question_version: string; prompt: string; concept_id: string }>;
	attempts?: AttemptView[];
};

async function generate(id: string, body: Record<string, unknown>) {
	const response = await post(`/api/sessions/${id}/learning/questions/generate`, body);
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function submit(id: string, body: Record<string, unknown>) {
	const response = await post(`/api/sessions/${id}/learning/attempts`, body);
	return { status: response.status, body: await response.json() as { checkpoint: CheckpointView; attempt: { attempt_id: string } } };
}

async function evaluate(id: string, attemptId: string, revision: number) {
	const response = await post(`/api/sessions/${id}/learning/attempts/${attemptId}/evaluate`, { revision });
	return { status: response.status, body: await response.json() as { checkpoint: CheckpointView; replayed: boolean } };
}

async function finalize(id: string, attemptId: string, revision: number) {
	const response = await post(`/api/sessions/${id}/learning/attempts/${attemptId}/finalize`, { revision });
	return {
		status: response.status,
		body: await response.json() as { replayed: boolean; attempt: { stage: string }; checkpoint: CheckpointView },
	};
}

/** Count formal evidence events in the real L1 ledger. */
async function evidenceCount(): Promise<number> {
	const path = join(home, "data", "learner", "events.jsonl");
	const text = await readFile(path, "utf-8").catch(() => "");
	return text.split("\n").filter((line) => line.trim()).reduce((count, line) => {
		try {
			const event = JSON.parse(line) as { evidence?: unknown };
			return event.evidence ? count + 1 : count;
		} catch {
			return count;
		}
	}, 0);
}

it("completes two different questions in one session, survives a restart, and replays idempotently", async () => {
	// 1. Session + record.
	const created = await post("/api/sessions", {});
	expect(created.status).toBe(201);
	const { id } = await created.json() as { id: string };
	const init = await post(`/api/sessions/${id}/learning`, {});
	expect(init.status).toBe(200);

	// 2. Question A.
	generationRound = 0;
	const first = await generate(id, {
		concept: "Python 闭包", request_id: "req_a", expected_revision: 1, allow_model_fallback: true,
	});
	expect(first.status).toBe(200);
	const firstBody = first.body as { created: boolean; question: { question_id: string }; checkpoint: CheckpointView };
	expect(firstBody.created).toBe(true);
	expect(firstBody.checkpoint).toMatchObject({ step: "awaiting_answer", question: { question_id: firstBody.question.question_id } });
	const questionA = firstBody.question.question_id;
	const revisionA = firstBody.checkpoint.revision;

	// 3. Answer, score and record A.
	const savedA = await submit(id, {
		attempt_id: "a1", question_id: questionA, question_version: "1",
		expected_revision: revisionA, answer: "闭包捕获变量绑定，所以外层变量仍可达。",
	});
	expect(savedA.status).toBe(200);
	const evaluatedA = await evaluate(id, "a1", savedA.body.checkpoint.revision);
	expect(evaluatedA.status).toBe(200);
	const finalizedA = await finalize(id, "a1", evaluatedA.body.checkpoint.revision);
	expect(finalizedA.status).toBe(200);
	expect(finalizedA.body.checkpoint).toMatchObject({
		step: "feedback", question: { question_id: questionA }, last_completed_attempt_id: "a1",
	});
	expect(finalizedA.body.checkpoint.pending_attempt_id).toBeUndefined();
	const feedbackRevision = finalizedA.body.checkpoint.revision;
	expect(await evidenceCount()).toBe(1);

	// 4. A GET between rounds is a pure read: no model call, no new evidence.
	const callsBeforeGet = providerCalls;
	const feedbackState = await request(`/api/sessions/${id}/learning`);
	const feedbackView = await feedbackState.json() as LearningView;
	expect(providerCalls).toBe(callsBeforeGet);
	expect(feedbackView.checkpoint.step).toBe("feedback");
	expect(feedbackView.attempts).toHaveLength(1);
	expect(feedbackView.attempts![0]).toMatchObject({ attempt_id: "a1", stage: "completed", answer: "闭包捕获变量绑定，所以外层变量仍可达。" });
	expect(await evidenceCount()).toBe(1);

	// 5. Continue with B, bound to A1.
	const second = await generate(id, {
		concept: "Python 闭包", request_id: "req_b", expected_revision: feedbackRevision,
		allow_model_fallback: true, after_attempt_id: "a1",
	});
	expect(second.status).toBe(200);
	const secondBody = second.body as { created: boolean; question: { question_id: string }; checkpoint: CheckpointView };
	expect(secondBody.created).toBe(true);
	const questionB = secondBody.question.question_id;
	expect(questionB).not.toBe(questionA);
	expect(secondBody.checkpoint).toMatchObject({
		revision: feedbackRevision + 1, step: "awaiting_answer",
		question: { question_id: questionB }, last_completed_attempt_id: "a1",
	});
	// History is untouched by generation: still one attempt, one evidence record,
	// and A's answer/score still readable.
	expect(await evidenceCount()).toBe(1);
	const midView = await request(`/api/sessions/${id}/learning`);
	const mid = await midView.json() as LearningView;
	expect(mid.questions.map((item) => item.question_id)).toEqual([questionA, questionB]);
	expect(mid.attempts).toHaveLength(1);
	expect(mid.attempts![0].question_id).toBe(questionA);

	// 6. Answer, score and record B.
	const savedB = await submit(id, {
		attempt_id: "b1", question_id: questionB, question_version: "1",
		expected_revision: secondBody.checkpoint.revision, answer: "循环里每次迭代都是同一个变量绑定，闭包会看到最终值。",
	});
	expect(savedB.status).toBe(200);
	const evaluatedB = await evaluate(id, "b1", savedB.body.checkpoint.revision);
	expect(evaluatedB.status).toBe(200);
	const finalizedB = await finalize(id, "b1", evaluatedB.body.checkpoint.revision);
	expect(finalizedB.status).toBe(200);
	expect(finalizedB.body.checkpoint).toMatchObject({
		step: "feedback", question: { question_id: questionB }, last_completed_attempt_id: "b1",
	});
	const finalRevision = finalizedB.body.checkpoint.revision;
	expect(await evidenceCount()).toBe(2);

	// 7. Restart: the current question and both answers survive.
	await stopServer();
	await startServer();
	const restarted = await request(`/api/sessions/${id}/learning`);
	expect(restarted.status).toBe(200);
	const afterRestart = await restarted.json() as LearningView;
	expect(afterRestart.checkpoint).toMatchObject({
		revision: finalRevision, step: "feedback", question: { question_id: questionB },
		last_completed_attempt_id: "b1",
	});
	expect(afterRestart.questions).toHaveLength(2);
	expect(afterRestart.attempts).toHaveLength(2);
	const answers = Object.fromEntries(afterRestart.attempts!.map((attempt) => [attempt.attempt_id, attempt.answer]));
	expect(answers).toEqual({
		a1: "闭包捕获变量绑定，所以外层变量仍可达。",
		b1: "循环里每次迭代都是同一个变量绑定，闭包会看到最终值。",
	});
	expect(afterRestart.attempts!.every((attempt) => attempt.stage === "completed")).toBe(true);
	expect(afterRestart.checkpoint.pending_attempt_id).toBeUndefined();

	// 8. Historical generation replays: identity and content are returned, but the
	//    checkpoint stays on B. A client must not reactivate A from this response.
	const replayA = await generate(id, {
		concept: "Python 闭包", request_id: "req_a", expected_revision: 1, allow_model_fallback: true,
	});
	expect(replayA.status).toBe(200);
	const replayABody = replayA.body as { created: boolean; question: { question_id: string }; checkpoint: CheckpointView };
	expect(replayABody.created).toBe(false);
	expect(replayABody.question.question_id).toBe(questionA);
	expect(replayABody.checkpoint).toMatchObject({
		revision: finalRevision, step: "feedback", question: { question_id: questionB },
	});

	const replayB = await generate(id, {
		concept: "Python 闭包", request_id: "req_b", expected_revision: feedbackRevision,
		allow_model_fallback: true, after_attempt_id: "a1",
	});
	expect(replayB.status).toBe(200);
	const replayBBody = replayB.body as { created: boolean; question: { question_id: string }; checkpoint: CheckpointView };
	expect(replayBBody.created).toBe(false);
	expect(replayBBody.question.question_id).toBe(questionB);
	expect(replayBBody.checkpoint.revision).toBe(finalRevision);

	// 9. Finalize replays: no extra evidence, no revision change.
	const callsBeforeReplay = providerCalls;
	const replayFinalizeA = await finalize(id, "a1", 0);
	expect(replayFinalizeA.status).toBe(200);
	expect(replayFinalizeA.body.replayed).toBe(true);
	const replayFinalizeB = await finalize(id, "b1", 0);
	expect(replayFinalizeB.status).toBe(200);
	expect(replayFinalizeB.body.replayed).toBe(true);
	expect(replayFinalizeB.body.checkpoint.revision).toBe(finalRevision);
	expect(await evidenceCount()).toBe(2);
	expect(providerCalls).toBe(callsBeforeReplay);

	// 10. Private material never leaves the server.
	const stateText = JSON.stringify(afterRestart);
	expect(stateText).not.toContain("闭包捕获的是变量绑定");
	expect(stateText).not.toContain("weight");
	expect(stateText).not.toContain("reference_answer");
}, 300_000);
