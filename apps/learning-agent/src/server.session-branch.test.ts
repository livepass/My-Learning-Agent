import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * E1: editing a persisted user turn must branch the real PI session before the
 * replacement prompt. The old answer belongs to the abandoned branch and must
 * not survive as the answer to the edited message.
 *
 * E1.1: the branch is additionally refused when B2 still backs a question or an
 * attempt, and the replacement prompt only lands while the branch the client
 * created is still the active head.
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

const QUESTION = {
	prompt: "请用自己的话解释 Python 闭包为什么会持有外层变量。",
	kind: "free_recall",
	reference_answer: "闭包捕获的是变量绑定而不是值的副本，因此外层变量在函数返回后仍然可达。",
	rubric: [
		{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 },
		{ criterion_id: "c2", description: "说明生命周期被延长", weight: 1 },
	],
	hints: ["先想想变量存在哪里"],
};

const learningFile = (sessionId: string) => join(home, "data", "learning", `${sessionId}.json`);
const learnerFile = (name: string) => join(home, "data", "learner", name);

async function seedLearning(sessionId: string, record: unknown): Promise<void> {
	await mkdir(join(home, "data", "learning"), { recursive: true });
	await writeFile(learningFile(sessionId), JSON.stringify(record, null, 2) + "\n", "utf-8");
}

async function readMaybe(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return null;
	}
}

function learningRecord(
	sessionId: string,
	checkpoint: Record<string, unknown>,
	attempts: Array<Record<string, unknown>> = [],
) {
	return {
		schema_version: 1,
		checkpoint: {
			schema_version: 1,
			session_id: sessionId,
			revision: 4,
			status: "active",
			step: "conversation",
			exposure_sequence: 0,
			updated_at: "2026-11-05T00:00:00.000Z",
			...checkpoint,
		},
		questions: [],
		exposures: [],
		attempts,
	};
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
		// Two reply modes: a normal chat turn, and the question JSON C1 expects.
		// The request body is inspected only to tell them apart.
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const answer = body.includes("严谨的出题助手") ? JSON.stringify(QUESTION) : "收到。";
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${sseChunk(answer, null)}\n\n`);
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

it("refuses the branch when B2 already holds formal evidence, leaving chat/B2/L1 untouched", async () => {
	const id = await createSession();
	await chat(id, "第一问");
	await chat(id, "第二问");
	const before = await messages(id);
	const firstUser = before[0]!;

	await seedLearning(id, learningRecord(id, { step: "feedback", last_completed_attempt_id: "att-old" }));
	const b2Before = await readFile(learningFile(id), "utf-8");
	const profileBefore = await readMaybe(learnerFile("profile.json"));
	const eventsBefore = await readMaybe(learnerFile("events.jsonl"));

	const response = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: firstUser.entryId,
	});
	expect(response.status).toBe(409);
	const body = await response.json() as { error: string; code: string; message: string };
	expect(body).toMatchObject({ error: "learning_evidence_locked", code: "learning_evidence_locked" });
	expect(body.message).toContain("学习证据");

	const after = await messages(id);
	expect(after.map((message) => message.entryId)).toEqual(before.map((message) => message.entryId));
	expect(await readFile(learningFile(id), "utf-8")).toBe(b2Before);
	expect(await readMaybe(learnerFile("profile.json"))).toBe(profileBefore);
	expect(await readMaybe(learnerFile("events.jsonl"))).toBe(eventsBefore);
}, 90_000);

it("refuses the branch while an answer is still pending or being evaluated", async () => {
	const id = await createSession();
	await chat(id, "第一问");
	const before = await messages(id);
	const attemptId = "att-pending";

	await seedLearning(id, learningRecord(
		id,
		{ step: "awaiting_answer", pending_attempt_id: attemptId },
		[{
			session_id: id,
			attempt_id: attemptId,
			question_id: "q1",
			question_version: "1",
			answer: "我的作答",
			accepted_at: "2026-11-05T00:00:00.000Z",
			accepted_revision: 4,
			question: {},
			hints: {},
			evaluation_attempts: 0,
			progress: { stage: "evaluating", process_run_id: "p", evaluation_run_id: "e", model: {}, started_at: "2026-11-05T00:00:00.000Z" },
		}],
	));
	const b2Before = await readFile(learningFile(id), "utf-8");

	const response = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: before[0]!.entryId,
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({
		error: "learning_attempt_pending",
		code: "learning_attempt_pending",
	});
	expect((await messages(id)).map((message) => message.entryId)).toEqual(before.map((message) => message.entryId));
	expect(await readFile(learningFile(id), "utf-8")).toBe(b2Before);
}, 90_000);

it("refuses a real saved answer produced by the learning API", async () => {
	const id = await createSession();
	await chat(id, "先聊一句");
	const before = await messages(id);

	const init = await post(`/api/sessions/${encodeURIComponent(id)}/learning`, {});
	expect(init.status).toBe(200);
	const initRevision = (await init.json() as { checkpoint: { revision: number } }).checkpoint.revision;

	const generated = await post(`/api/sessions/${encodeURIComponent(id)}/learning/questions/generate`, {
		concept: "Python 闭包",
		request_id: "req_branch_real",
		expected_revision: initRevision,
		allow_model_fallback: true,
	});
	expect(generated.status).toBe(200);
	const question = await generated.json() as {
		question: { question_id: string; question_version: string };
		checkpoint: { revision: number };
	};

	const saved = await post(`/api/sessions/${encodeURIComponent(id)}/learning/attempts`, {
		attempt_id: "attempt_branch_real",
		question_id: question.question.question_id,
		question_version: question.question.question_version,
		expected_revision: question.checkpoint.revision,
		answer: "闭包捕获的是变量绑定，而不是值的副本。",
	});
	expect(saved.status).toBe(200);
	const b2Before = await readFile(learningFile(id), "utf-8");

	const response = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: before[0]!.entryId,
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({
		error: "learning_attempt_pending",
		code: "learning_attempt_pending",
	});
	expect(await readFile(learningFile(id), "utf-8")).toBe(b2Before);
	expect((await messages(id)).map((message) => message.entryId)).toEqual(before.map((message) => message.entryId));
}, 90_000);

it("refuses the branch when evidence lands after the client's own pre-check", async () => {
	const id = await createSession();
	await chat(id, "第一问");
	const before = await messages(id);

	// What the edit UI calls before offering the editor: no record yet.
	const learning = await request(`/api/sessions/${encodeURIComponent(id)}/learning`);
	expect(learning.status).toBe(200);
	expect(await learning.json()).toMatchObject({ exists: false });

	// Another request finalizes an attempt in the window between that check and
	// the branch. The server must decide from B2, not from the client snapshot.
	await seedLearning(id, learningRecord(id, { step: "feedback", last_completed_attempt_id: "att-race" }));

	const response = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: before[0]!.entryId,
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: "learning_evidence_locked" });
	expect((await messages(id)).map((message) => message.entryId)).toEqual(before.map((message) => message.entryId));
}, 90_000);

it("appends the replacement only while the branch marker is still the head", async () => {
	const id = await createSession();
	await chat(id, "第一问");
	await chat(id, "第二问");
	const before = await messages(id);

	const branched = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: before[0]!.entryId,
	});
	expect(branched.status).toBe(200);
	const { branchMarkerId } = await branched.json() as { branchMarkerId: string };
	expect(branchMarkerId).toBeTruthy();

	const sent = await post("/api/chat", {
		sessionId: id,
		prompt: "修改后的问题：闭包捕获变量绑定",
		branchMarkerId,
	});
	expect(sent.status).toBe(200);
	const after = await messages(id);
	expect(after).toHaveLength(2);
	expect(after[0]).toMatchObject({ role: "user", content: "修改后的问题：闭包捕获变量绑定" });
}, 90_000);

it("rejects a replacement whose branch was replaced by another request", async () => {
	const id = await createSession();
	await chat(id, "第一问");
	await chat(id, "第二问");
	const before = await messages(id);

	const branched = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: before[0]!.entryId,
	});
	const { branchMarkerId } = await branched.json() as { branchMarkerId: string };

	// Another request changes the conversation before the edit resend arrives.
	await chat(id, "并发地继续对话");
	const stable = await messages(id);
	expect(stable).toHaveLength(2);

	const stale = await post("/api/chat", {
		sessionId: id,
		prompt: "过期分支的修改",
		branchMarkerId,
	});
	expect(stale.status).toBe(409);
	expect(await stale.json()).toMatchObject({ error: "stale_branch", code: "stale_branch" });
	expect((await messages(id)).map((message) => message.entryId)).toEqual(stable.map((message) => message.entryId));
}, 90_000);

it("rejects a stale branch marker on the streaming path used by the editor", async () => {
	const id = await createSession();
	await chat(id, "第一问");
	await chat(id, "第二问");
	const before = await messages(id);

	const branched = await post(`/api/sessions/${encodeURIComponent(id)}/branch-before-message`, {
		entryId: before[0]!.entryId,
	});
	const { branchMarkerId } = await branched.json() as { branchMarkerId: string };
	await chat(id, "并发地继续对话");
	const stable = await messages(id);

	const stream = await request("/api/chat/stream", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			sessionId: id,
			clientRequestId: `stale-branch-${Date.now()}`,
			prompt: "过期分支的流式修改",
			branchMarkerId,
		}),
	});
	expect(stream.status).toBe(200);
	const text = await stream.text();
	expect(text).toContain("stale_branch");
	expect((await messages(id)).map((message) => message.entryId)).toEqual(stable.map((message) => message.entryId));
}, 90_000);
