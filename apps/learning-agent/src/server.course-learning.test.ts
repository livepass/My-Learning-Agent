import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/**
 * E4.4a end-to-end: a real server, a real Agent runtime, real course state and
 * real session files. Two courses are used so "resume" can never be satisfied
 * by the other course's session.
 *
 * The fixture provider counts requests: starting a learning session must not
 * touch the model at all.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;
let providerCalls = 0;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
	request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface CourseBody { course_id: string; title: string }
interface TaskBody { task_id: string; title: string; status: string; plan_id: string | null }
interface PlanBody { plan: { plan_id: string }; tasks?: TaskBody[] }
interface StartBody {
	request_id: string;
	session: { session_id: string; active: boolean; created: boolean; resumed: boolean };
	course: { course_id: string; title: string };
	task: TaskBody | null;
	goal_id: string | null;
	learning: { created: boolean; checkpoint: { revision: number; status: string; step: string } | null };
	warnings: string[];
}
interface BindingBody { session_id: string; task_id: string | null; origin: string }

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

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-course-learning-"));
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
	await (await import("node:fs/promises")).writeFile(join(home, "config", "config.json"), JSON.stringify({
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-course-learning-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

let python: CourseBody;
let math: CourseBody;
let pythonTask: TaskBody;
let mathTask: TaskBody;
let pythonSession: string;

it("creates two courses with one active task each", async () => {
	python = await (await post("/api/courses", { title: "Python 编程" })).json() as CourseBody;
	math = await (await post("/api/courses", { title: "高等数学" })).json() as CourseBody;
	const pythonPlan = await (await post(`/api/courses/${python.course_id}/plans`, {
		title: "Python 计划",
		status: "active",
		stages: [{ title: "基础", tasks: [{ title: "阅读装饰器教材", estimated_minutes: 25 }] }],
	})).json() as PlanBody;
	const mathPlan = await (await post(`/api/courses/${math.course_id}/plans`, {
		title: "高数计划",
		status: "active",
		stages: [{ title: "基础", tasks: [{ title: "阅读导数教材", estimated_minutes: 25 }] }],
	})).json() as PlanBody;
	pythonTask = (await (await request(`/api/courses/${python.course_id}/tasks`)).json() as { tasks: TaskBody[] }).tasks[0];
	mathTask = (await (await request(`/api/courses/${math.course_id}/tasks`)).json() as { tasks: TaskBody[] }).tasks[0];
	expect(pythonTask.plan_id).toBe(pythonPlan.plan.plan_id);
	expect(mathTask.plan_id).toBe(mathPlan.plan.plan_id);
});

it("starts a task session, binds it and moves the task to in_progress", async () => {
	const response = await post(`/api/courses/${python.course_id}/learning/start`, {
		task_id: pythonTask.task_id,
		request_id: "req_python_1",
	});
	expect(response.status).toBe(201);
	const body = await response.json() as StartBody;
	pythonSession = body.session.session_id;
	expect(body.session).toMatchObject({ created: true, resumed: false, active: true });
	expect(body.task).toMatchObject({ task_id: pythonTask.task_id, status: "in_progress" });
	expect(body.learning.checkpoint?.status).toBe("active");

	// The conversation is real, listable and bound to the course + task.
	const detail = await request(`/api/sessions/${pythonSession}`);
	expect(detail.status).toBe(200);
	const bindings = await (await request(`/api/courses/${python.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	expect(bindings.sessions).toHaveLength(1);
	expect(bindings.sessions[0]).toMatchObject({ session_id: pythonSession, task_id: pythonTask.task_id, origin: "task" });

	// B2 exists for the session and is reachable through its own contract.
	const learning = await (await request(`/api/sessions/${pythonSession}/learning`)).json() as { exists: boolean };
	expect(learning.exists).toBe(true);
	// Nothing above needed the model.
	expect(providerCalls).toBe(0);
});

it("continues the same session on a second start", async () => {
	const response = await post(`/api/courses/${python.course_id}/learning/start`, {
		task_id: pythonTask.task_id,
		request_id: "req_python_2",
	});
	expect(response.status).toBe(200);
	const body = await response.json() as StartBody;
	expect(body.session).toMatchObject({ session_id: pythonSession, created: false, resumed: true });
	expect(body.warnings).toEqual([]);
	const bindings = await (await request(`/api/courses/${python.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	expect(bindings.sessions).toHaveLength(1);
	// A resume replays the same request id to the same session, too.
	const replay = await post(`/api/courses/${python.course_id}/learning/start`, {
		task_id: pythonTask.task_id,
		request_id: "req_python_2",
	});
	expect(((await replay.json()) as StartBody).session.session_id).toBe(pythonSession);
});

it("refuses a manual bind that would give one task a second session", async () => {
	const free = await post(`/api/courses/${python.course_id}/learning/start`, { request_id: "req_python_free" });
	expect(free.status).toBe(201);
	const freeSession = ((await free.json()) as StartBody).session.session_id;
	const rejected = await post(`/api/courses/${python.course_id}/sessions`, {
		session_id: freeSession,
		task_id: pythonTask.task_id,
	});
	expect(rejected.status).toBe(409);
	expect(await rejected.json()).toMatchObject({ error: "course_session_conflict" });
	const bindings = await (await request(`/api/courses/${python.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	expect(bindings.sessions.filter((binding) => binding.task_id === pythonTask.task_id)).toHaveLength(1);
	expect(bindings.sessions.find((binding) => binding.session_id === freeSession)?.task_id).toBeNull();
});

it("collapses two concurrent starts of one task into one session", async () => {
	const created = await post(`/api/courses/${python.course_id}/tasks`, {
		title: "并发测试任务",
		status: "pending",
	});
	expect(created.status).toBe(201);
	const taskId = ((await created.json()) as TaskBody).task_id;
	const [left, right] = await Promise.all([
		post(`/api/courses/${python.course_id}/learning/start`, { task_id: taskId, request_id: "req_concurrent_a" }),
		post(`/api/courses/${python.course_id}/learning/start`, { task_id: taskId, request_id: "req_concurrent_b" }),
	]);
	// A shared in-flight start reports the same outcome to both callers, so
	// either may carry `created: true`; what must never differ is the session.
	expect([200, 201]).toContain(left.status);
	expect([200, 201]).toContain(right.status);
	const leftBody = await left.json() as StartBody;
	const rightBody = await right.json() as StartBody;
	expect(rightBody.session.session_id).toBe(leftBody.session.session_id);
	expect(rightBody.session.resumed || leftBody.session.resumed || rightBody.session.created).toBe(true);
	const bindings = await (await request(`/api/courses/${python.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	expect(bindings.sessions.filter((binding) => binding.task_id === taskId)).toHaveLength(1);
});

it("never leaks a task or a session into the other course", async () => {
	const crossCourse = await post(`/api/courses/${math.course_id}/learning/start`, {
		task_id: pythonTask.task_id,
		request_id: "req_cross",
	});
	expect(crossCourse.status).toBe(404);
	expect(await crossCourse.json()).toMatchObject({ error: "task_not_found" });

	const mathStart = await post(`/api/courses/${math.course_id}/learning/start`, {
		task_id: mathTask.task_id,
		request_id: "req_math_1",
	});
	expect(mathStart.status).toBe(201);
	const mathBody = await mathStart.json() as StartBody;
	expect(mathBody.session.session_id).not.toBe(pythonSession);
	const mathBindings = await (await request(`/api/courses/${math.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	expect(mathBindings.sessions.map((binding) => binding.session_id)).toEqual([mathBody.session.session_id]);
});

it("opens free chat without adopting a task", async () => {
	const response = await post(`/api/courses/${math.course_id}/learning/start`, { request_id: "req_math_free" });
	expect(response.status).toBe(201);
	const body = await response.json() as StartBody;
	expect(body.task).toBeNull();
	expect(body.goal_id).toBeNull();
	const bindings = await (await request(`/api/courses/${math.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	const free = bindings.sessions.find((binding) => binding.session_id === body.session.session_id);
	expect(free).toMatchObject({ task_id: null, origin: "free_question" });
});

it("refuses a completed task", async () => {
	expect((await patch(`/api/courses/${math.course_id}/tasks/${mathTask.task_id}`, { status: "completed" })).status).toBe(200);
	const response = await post(`/api/courses/${math.course_id}/learning/start`, {
		task_id: mathTask.task_id,
		request_id: "req_math_done",
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: "task_completed" });
});

it("keeps working after a restart and resumes the same sessions", async () => {
	await stopServer();
	await startServer();
	const response = await post(`/api/courses/${python.course_id}/learning/start`, {
		task_id: pythonTask.task_id,
		request_id: "req_python_after_restart",
	});
	expect(response.status).toBe(200);
	const body = await response.json() as StartBody;
	expect(body.session.session_id).toBe(pythonSession);
	expect(body.session.resumed).toBe(true);
	// The task stayed in_progress; a restart never marks it complete.
	expect(body.task?.status).toBe("in_progress");
});

it("removes a deleted session's binding and never keeps a dangling task reference", async () => {
	// The python task session is the active one; deleting it would need a
	// replacement conversation, and every session here is still empty (the
	// fixture provider never answers), so D4 correctly refuses that delete.
	const refused = await request(`/api/sessions/${pythonSession}`, { method: "DELETE" });
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({ error: "no_replacement_session" });

	// A non-active session can be deleted without a replacement. Its course
	// binding must go with it, or the course would list a session that cannot
	// be opened.
	const mathBindings = await (await request(`/api/courses/${math.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	const freeSession = mathBindings.sessions.find((binding) => binding.task_id === null);
	expect(freeSession).toBeDefined();
	const removed = await request(`/api/sessions/${freeSession!.session_id}`, { method: "DELETE" });
	expect(removed.status).toBe(200);
	const after = await (await request(`/api/courses/${math.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	expect(after.sessions.map((binding) => binding.session_id)).not.toContain(freeSession!.session_id);
	// The task session of that course is untouched and still resumable. Reopen
	// the task first: an earlier test completed it on purpose.
	expect((await patch(`/api/courses/${math.course_id}/tasks/${mathTask.task_id}`, { status: "in_progress" })).status).toBe(200);
	const resumed = await post(`/api/courses/${math.course_id}/learning/start`, {
		task_id: mathTask.task_id,
		request_id: "req_math_after_delete",
	});
	expect(resumed.status).toBe(200);
	expect(((await resumed.json()) as StartBody).session.resumed).toBe(true);
});

it("rejects an unknown course", async () => {
	const response = await post("/api/courses/course_missing/learning/start", { request_id: "req_missing" });
	expect(response.status).toBe(404);
	expect(await response.json()).toMatchObject({ error: "course_not_found" });
});

it("reports a legacy duplicate task binding and continues the oldest session", async () => {
	const statePath = join(home, "data", "courses", "state.json");
	const state = JSON.parse(await readFile(statePath, "utf-8")) as {
		session_bindings: Array<Record<string, unknown>>;
	};
	const original = state.session_bindings.find((binding) => binding.task_id === pythonTask.task_id);
	expect(original).toBeDefined();
	state.session_bindings.push({
		...original!,
		binding_id: "binding_legacy_duplicate",
		session_id: "legacy_duplicate_session.jsonl",
		created_at: "2026-11-09T00:00:00.000Z",
	});
	await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

	const listed = await (await request(`/api/courses/${python.course_id}/sessions`)).json() as {
		sessions: BindingBody[];
		duplicate_task_bindings?: Array<{ task_id: string; session_ids: string[]; note: string }>;
	};
	expect(listed.sessions.filter((binding) => binding.task_id === pythonTask.task_id)).toHaveLength(2);
	expect(listed.duplicate_task_bindings?.[0]).toMatchObject({
		task_id: pythonTask.task_id,
		session_ids: [pythonSession, "legacy_duplicate_session.jsonl"],
	});
	expect(listed.duplicate_task_bindings?.[0].note).toContain("保留");

	// Continuing picks the oldest binding and leaves both records alone.
	const resumed = await post(`/api/courses/${python.course_id}/learning/start`, {
		task_id: pythonTask.task_id,
		request_id: "req_legacy_duplicate",
	});
	expect(resumed.status).toBe(200);
	const body = await resumed.json() as StartBody;
	expect(body.session.session_id).toBe(pythonSession);
	expect(body.warnings.join()).toContain("历史会话");
	const after = await (await request(`/api/courses/${python.course_id}/sessions`)).json() as { sessions: BindingBody[] };
	expect(after.sessions.filter((binding) => binding.task_id === pythonTask.task_id)).toHaveLength(2);

	// A new session still cannot be added on top of the duplicates.
	const free = await post(`/api/courses/${python.course_id}/learning/start`, { request_id: "req_legacy_free" });
	const freeId = ((await free.json()) as StartBody).session.session_id;
	const rejected = await post(`/api/courses/${python.course_id}/sessions`, {
		session_id: freeId,
		task_id: pythonTask.task_id,
	});
	expect(rejected.status).toBe(409);
});
