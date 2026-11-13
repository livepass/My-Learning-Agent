import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * E4.8 end-to-end: the workbench's contract with the server.
 *
 * A real server proves the two rules the page depends on:
 *
 * 1. one course can hold several independent free learning conversations, and a
 *    retried `request_id` returns the one it already created instead of a twin;
 * 2. a Web conversation that belongs to no course cannot start chatting — the
 *    restriction is a server refusal, not a disabled button — while a paused,
 *    archived or completed course cannot open a new one at all.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;
let providerCalls = 0;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body?: unknown) =>
	request(path, {
		method: "POST",
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});

interface CourseBody { course_id: string; status: string; title: string }
interface StartBody {
	request_id: string;
	session: { session_id: string; created: boolean; resumed: boolean };
	course: { course_id: string; status: string };
	task: unknown;
}
interface SessionRow {
	id: string;
	course: { course_id: string; title: string; status?: string; archived: boolean; task_id?: string | null } | null;
}

async function startServer(): Promise<void> {
	child = spawn(process.execPath, ["--import", "tsx", resolve("apps/learning-agent/src/server.ts"),
		"--home", home, "--config-dir", join(home, "config"), "--data-dir", join(home, "data"),
		"--workspace", join(home, "workspace"), "--skills-dir", join(home, "skills"), "--port", String(port)],
	{ cwd: process.cwd(), stdio: "ignore" });
	const deadline = Date.now() + 80_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("server exited before readiness");
		try { if ((await request("/health")).ok) return; } catch { /* lazy bootstrap */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (child && child.exitCode === null) {
		const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
		child.kill();
		await exited;
	}
}

async function createCourse(title: string): Promise<string> {
	const created = await post("/api/courses", { title });
	expect(created.status).toBe(201);
	return ((await created.json()) as CourseBody).course_id;
}

async function startFree(courseId: string, requestId: string): Promise<StartBody> {
	const started = await post(`/api/courses/${courseId}/learning/start`, { task_id: null, request_id: requestId });
	// 201 when this request created the conversation, 200 when it resumed one.
	expect([200, 201]).toContain(started.status);
	return await started.json() as StartBody;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-e48-workbench-"));
	provider = createServer((req, res) => {
		providerCalls += 1;
		req.resume();
		// A minimal streaming completion: the allowed turn must be a real one, so
		// refusals can be proven by "the provider was not called at all".
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "dummy", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "dummy", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((yes) => provider.listen(0, "127.0.0.1", yes));
	const providerPort = (provider.address() as { port: number }).port;
	const allocator = createServer();
	await new Promise<void>((yes) => allocator.listen(0, "127.0.0.1", yes));
	port = (allocator.address() as { port: number }).port;
	await new Promise<void>((yes) => allocator.close(() => yes()));

	await mkdir(join(home, "config"), { recursive: true });
	await mkdir(join(home, "data", "learner"), { recursive: true });
	await writeFile(join(home, "config", "config.json"), JSON.stringify({
		providers: { fixture: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: "fixture", models: [{ id: "dummy" }] } },
		memory: { l1Enabled: true, l2Enabled: true, l3Enabled: false },
	}));
	await startServer();
}, 240_000);

afterAll(async () => {
	await stopServer();
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((yes) => provider.close(() => yes()));
	}
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-e48-workbench-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

describe("E4.8 — a course owns several free conversations", () => {
	it("creates two independent conversations, both bound with no task", async () => {
		const courseId = await createCourse("Python 编程");
		const first = await startFree(courseId, "req_free_one");
		const second = await startFree(courseId, "req_free_two");

		expect(second.session.session_id).not.toBe(first.session.session_id);

		const bindings = await (await request(`/api/courses/${courseId}/sessions`)).json() as {
			sessions: Array<{ session_id: string; task_id: string | null; origin: string }>;
		};
		expect(bindings.sessions).toHaveLength(2);
		expect(bindings.sessions.map((binding) => binding.task_id)).toEqual([null, null]);
		expect(bindings.sessions.every((binding) => binding.origin === "free_question")).toBe(true);

		// The list the sidebar groups by: course + binding facts, no inference.
		const rows = await (await request("/api/sessions")).json() as SessionRow[];
		for (const id of [first.session.session_id, second.session.session_id]) {
			const row = rows.find((candidate) => candidate.id === id);
			expect(row?.course).toMatchObject({
				course_id: courseId,
				status: "in_progress",
				archived: false,
				task_id: null,
			});
		}
		expect(first.task).toBeNull();
		expect(second.task).toBeNull();
	});

	it("returns the same conversation when a create is retried with its request id", async () => {
		const courseId = await createCourse("数据结构");
		const first = await startFree(courseId, "req_free_retry");
		const retried = await startFree(courseId, "req_free_retry");

		expect(retried.session.session_id).toBe(first.session.session_id);
		expect(retried.session.created).toBe(false);
		expect(retried.session.resumed).toBe(true);

		const bindings = await (await request(`/api/courses/${courseId}/sessions`)).json() as { sessions: unknown[] };
		// A retry must not leave a second conversation behind.
		expect(bindings.sessions).toHaveLength(1);
	});
});

describe("E4.8 — a new Web conversation needs a course", () => {
	it("refuses the first turn of an unbound session, without calling the model", async () => {
		const created = await post("/api/sessions", {});
		expect(created.status).toBe(201);
		const { id } = await created.json() as { id: string };

		const chat = await post("/api/chat", { sessionId: id, prompt: "没有课程也能聊天吗？" });
		expect(chat.status).toBe(409);
		expect(await chat.json()).toMatchObject({ error: "course_required", category: "courses" });

		const stream = await post("/api/chat/stream", {
			sessionId: id,
			prompt: "流式也不行",
			clientRequestId: "req_unbound_stream",
		});
		expect(stream.status).toBe(409);
		expect(await stream.json()).toMatchObject({ error: "course_required" });

		// Nothing was written: no message, no provider call.
		const detail = await (await request(`/api/sessions/${encodeURIComponent(id)}`)).json() as { messageCount: number };
		expect(detail.messageCount).toBe(0);
		expect(providerCalls).toBe(0);
	});

	it("refuses a new conversation in a paused, archived or completed course", async () => {
		const courseId = await createCourse("状态测试课程");
		const started = await startFree(courseId, "req_status_ok");
		expect(started.session.session_id).toBeTruthy();

		await request(`/api/courses/${courseId}/archive`, { method: "POST" });
		const archived = await post(`/api/courses/${courseId}/learning/start`, {
			task_id: null,
			request_id: "req_status_archived",
		});
		expect(archived.status).toBe(409);
		expect(await archived.json()).toMatchObject({ error: "course_archived" });

		// restore → paused: history is readable, a new conversation is not.
		expect((await post(`/api/courses/${courseId}/restore`)).status).toBe(200);
		const paused = await post(`/api/courses/${courseId}/learning/start`, {
			task_id: null,
			request_id: "req_status_paused",
		});
		expect(paused.status).toBe(409);
		expect(await paused.json()).toMatchObject({ error: "course_paused" });

		expect((await post(`/api/courses/${courseId}/resume`)).status).toBe(200);
		const again = await startFree(courseId, "req_status_resumed");
		expect(again.session.session_id).not.toBe(started.session.session_id);

		const completed = await request(`/api/courses/${courseId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "completed" }),
		});
		expect(completed.status).toBe(200);
		const refused = await post(`/api/courses/${courseId}/learning/start`, {
			task_id: null,
			request_id: "req_status_completed",
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ error: "course_completed" });
	});
});

describe("E4.8a — course status gates chat writes", () => {
	const messageCount = async (sessionId: string): Promise<number> =>
		((await (await request(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as { messageCount: number }).messageCount;

	const chatBoth = async (sessionId: string) => {
		const chat = await post("/api/chat", { sessionId, prompt: "这条消息不应该写进去" });
		const stream = await post("/api/chat/stream", {
			sessionId,
			prompt: "这条流式消息也不应该写进去",
			clientRequestId: `req_${Math.random().toString(36).slice(2)}`,
		});
		return { chat, stream };
	};

	it("allows an in_progress course to continue chatting", async () => {
		const courseId = await createCourse("进行中课程");
		const { session } = await startFree(courseId, "req_status_ok_chat");
		const before = await messageCount(session.session_id);
		const calls = providerCalls;

		const chat = await post("/api/chat", { sessionId: session.session_id, prompt: "讲一下闭包" });
		expect(chat.status).toBe(200);
		expect(await messageCount(session.session_id)).toBe(before + 2);
		expect(providerCalls).toBe(calls + 1);
	});

	it("refuses paused, archived and completed courses on both endpoints, writing nothing", async () => {
		// One fresh course per status: a course cannot leave `archived` through
		// PATCH (E4.7-R1), so reusing one would test the restore rule instead.
		const cases: Array<{ status: string; expected: string; prepare: (courseId: string) => Promise<void> }> = [
			{
				status: "paused",
				expected: "course_paused",
				prepare: async (courseId) => {
					const paused = await request(`/api/courses/${courseId}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ status: "paused" }),
					});
					expect(paused.status).toBe(200);
				},
			},
			{
				status: "archived",
				expected: "course_archived",
				prepare: async (courseId) => {
					expect((await post(`/api/courses/${courseId}/archive`)).status).toBe(200);
				},
			},
			{
				status: "completed",
				expected: "course_completed",
				prepare: async (courseId) => {
					const completed = await request(`/api/courses/${courseId}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ status: "completed" }),
					});
					expect(completed.status).toBe(200);
				},
			},
		];

		let seq = 0;
		for (const testCase of cases) {
			seq += 1;
			const courseId = await createCourse(`状态写入课程 ${seq}`);
			const { session } = await startFree(courseId, `req_status_write_${seq}`);
			const sessionId = session.session_id;
			await testCase.prepare(courseId);

			const before = await messageCount(sessionId);
			const calls = providerCalls;

			const { chat, stream } = await chatBoth(sessionId);
			expect(chat.status, testCase.status).toBe(409);
			expect(await chat.json()).toMatchObject({ error: testCase.expected, category: "courses" });
			expect(stream.status, testCase.status).toBe(409);
			expect(await stream.json()).toMatchObject({ error: testCase.expected });

			// Neither endpoint appended a message or reached the model.
			expect(await messageCount(sessionId), testCase.status).toBe(before);
			expect(providerCalls, testCase.status).toBe(calls);
		}
	});

	it("fails closed with 503 when the course state cannot be read", async () => {
		const courseId = await createCourse("读取失败课程");
		const { session } = await startFree(courseId, "req_status_broken");
		const sessionId = session.session_id;
		const statePath = join(home, "data", "courses", "state.json");
		const original = await readFile(statePath, "utf-8");
		const before = await messageCount(sessionId);
		const calls = providerCalls;
		try {
			await writeFile(statePath, "{ this is not the course state", "utf-8");
			const { chat, stream } = await chatBoth(sessionId);
			expect(chat.status).toBe(503);
			expect(await chat.json()).toMatchObject({ error: "course_unavailable" });
			expect(stream.status).toBe(503);
			expect(await stream.json()).toMatchObject({ error: "course_unavailable" });
		} finally {
			await writeFile(statePath, original, "utf-8");
		}
		// The session was not rewritten, and the model was never called: a read
		// failure is not "no evidence, go ahead".
		expect(await messageCount(sessionId)).toBe(before);
		expect(providerCalls).toBe(calls);
	});
});

describe("E4.8a — unclassified Web history is read-only", () => {
	it("stays readable, cannot continue, cannot be edited and is not rebound", async () => {
		const courseId = await createCourse("未归类来源课程");
		const { session } = await startFree(courseId, "req_legacy_source");
		const sessionId = session.session_id;
		const chat = await post("/api/chat", { sessionId, prompt: "第一轮对话" });
		expect(chat.status).toBe(200);

		// Simulate a pre-E4.1 conversation: its messages exist, its binding does not.
		const statePath = join(home, "data", "courses", "state.json");
		const original = await readFile(statePath, "utf-8");
		try {
			const state = JSON.parse(original) as { session_bindings: Array<{ session_id: string }> };
			state.session_bindings = state.session_bindings.filter((binding) => binding.session_id !== sessionId);
			await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

			const row = ((await (await request("/api/sessions")).json()) as SessionRow[])
				.find((candidate) => candidate.id === sessionId);
			expect(row?.course).toBeNull();

			const before = (await (await request(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as {
				messageCount: number;
				messages: Array<{ role: string; entryId?: string }>;
			};
			const calls = providerCalls;

			// History is readable; a new turn is refused on both endpoints.
			const refused = await post("/api/chat", { sessionId, prompt: "还能继续吗" });
			expect(refused.status).toBe(409);
			expect(await refused.json()).toMatchObject({ error: "course_required" });
			const stream = await post("/api/chat/stream", {
				sessionId,
				prompt: "流式也不行",
				clientRequestId: "req_legacy_stream",
			});
			expect(stream.status).toBe(409);
			expect(await stream.json()).toMatchObject({ error: "course_required" });

			// Editing history would branch it and then resend: refused up front.
			const userEntry = before.messages.find((message) => message.role === "user" && message.entryId);
			expect(userEntry?.entryId).toBeTruthy();
			const branched = await post(`/api/sessions/${encodeURIComponent(sessionId)}/branch-before-message`, {
				entryId: userEntry!.entryId,
			});
			expect(branched.status).toBe(409);
			expect(await branched.json()).toMatchObject({ error: "course_required" });

			const after = (await (await request(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as {
				messageCount: number;
			};
			expect(after.messageCount).toBe(before.messageCount);
			expect(providerCalls).toBe(calls);

			// Reading did not invent a binding either.
			const rows = (await (await request("/api/sessions")).json()) as SessionRow[];
			expect(rows.find((candidate) => candidate.id === sessionId)?.course).toBeNull();
		} finally {
			await writeFile(statePath, original, "utf-8");
		}
	});

	it("leaves course-bound conversations of A and B working", async () => {
		const a = await createCourse("课程 A");
		const b = await createCourse("课程 B");
		const fromA = await startFree(a, "req_ab_a");
		const fromB = await startFree(b, "req_ab_b");

		const chatA = await post("/api/chat", { sessionId: fromA.session.session_id, prompt: "A 的问题" });
		const chatB = await post("/api/chat", { sessionId: fromB.session.session_id, prompt: "B 的问题" });
		expect(chatA.status).toBe(200);
		expect(chatB.status).toBe(200);
	});
});
