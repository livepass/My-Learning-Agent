import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	provider = createServer((_req, res) => {
		providerCalls += 1;
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "fixture provider must not be called" }));
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
