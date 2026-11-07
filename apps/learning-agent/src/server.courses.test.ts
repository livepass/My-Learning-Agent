import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/**
 * E4.1 end-to-end: the course API against a real server process.
 *
 * Covers what unit tests cannot: legacy records stay 「未归类」 across a real
 * restart, course state survives the process boundary, a duplicate binding is
 * idempotent over HTTP, and archiving keeps every relation readable.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let home: string;
let port: number;
let child: ChildProcess;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(45_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
	request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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

interface CourseBody {
	course_id: string;
	title: string;
	status: string;
	created_at: string;
	updated_at: string;
}

interface BindingBody {
	binding_id: string;
	course_id: string;
	session_id: string;
	task_id: string | null;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-courses-e2e-"));
	await mkdir(join(home, "config"), { recursive: true });
	await mkdir(join(home, "data", "sessions"), { recursive: true });
	// A session written before courses existed: no binding, no course.
	await writeFile(
		join(home, "data", "sessions", "legacy-session.jsonl"),
		JSON.stringify({ role: "user", content: "解释一下 Python 闭包" }) + "\n",
		"utf-8",
	);
	// One ingested document, owned by no course until an explicit binding says so.
	await mkdir(join(home, "data", "l2"), { recursive: true });
	await writeFile(join(home, "data", "l2", "manifest.jsonl"),
		JSON.stringify({ id: "l2src_shared", title: "两门课共用的教材" }) + "\n", "utf-8");
	// `loadConfig` requires at least one provider; this test never calls a model.
	await writeFile(join(home, "config", "config.json"), JSON.stringify({
		providers: { fixture: { baseUrl: "http://127.0.0.1:9", apiKey: "fixture", models: [{ id: "dummy" }] } },
		memory: { l1Enabled: true, l2Enabled: false, l3Enabled: false },
	}));
	const allocator = (await import("node:http")).createServer();
	await new Promise<void>((yes) => allocator.listen(0, "127.0.0.1", yes));
	port = (allocator.address() as { port: number }).port;
	await new Promise<void>((yes) => allocator.close(() => yes()));
	await startServer();
}, 90_000);

afterAll(async () => {
	await stopServer();
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-courses-e2e-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 15_000);

it("keeps course ownership explicit across a restart and never infers it from a title", async () => {
	// 1. No courses yet; the legacy session is unclassified, not guessed.
	const empty = await request("/api/courses");
	expect(empty.status).toBe(200);
	expect((await empty.json() as { courses: unknown[] }).courses).toEqual([]);

	const unclassified = await request("/api/courses/unclassified");
	const unclassifiedBody = await unclassified.json() as { sessions: string[]; sources: string[] };
	expect(unclassifiedBody.sessions).toEqual(["legacy-session.jsonl"]);

	// Its topic mentions Python, but the API still reports no course.
	const beforeBinding = await request("/api/courses/bindings/session/legacy-session.jsonl");
	expect(await beforeBinding.json()).toMatchObject({
		session_id: "legacy-session.jsonl", unclassified: true, binding: null, course: null,
	});

	// 2. Create the two courses the acceptance scenario uses.
	const pythonResponse = await post("/api/courses", { title: "Python 编程", description: "从语法到项目" });
	expect(pythonResponse.status).toBe(201);
	const python = await pythonResponse.json() as CourseBody;
	const mathResponse = await post("/api/courses", { title: "高等数学" });
	expect(mathResponse.status).toBe(201);
	const math = await mathResponse.json() as CourseBody;

	// 3. Bind the legacy session explicitly; a retry is idempotent.
	const bound = await post(`/api/courses/${python.course_id}/sessions`, {
		session_id: "legacy-session.jsonl", origin: "manual",
	});
	expect(bound.status).toBe(201);
	const binding = await bound.json() as BindingBody;
	const retried = await post(`/api/courses/${python.course_id}/sessions`, {
		session_id: "legacy-session.jsonl", origin: "manual",
	});
	expect(retried.status).toBe(200);
	expect((await retried.json() as BindingBody).binding_id).toBe(binding.binding_id);

	// 4. A different course cannot take the session away.
	const stolen = await post(`/api/courses/${math.course_id}/sessions`, { session_id: "legacy-session.jsonl" });
	expect(stolen.status).toBe(409);

	// 5. Plan + tasks are course-scoped; a cross-course plan is refused.
	const planResponse = await post(`/api/courses/${python.course_id}/plans`, { title: "四周入门" });
	expect(planResponse.status).toBe(201);
	const plan = await planResponse.json() as { plan_id: string };
	const taskResponse = await post(`/api/courses/${python.course_id}/tasks`, {
		title: "理解闭包", plan_id: plan.plan_id, concept_ids: ["concepts.closures"],
	});
	expect(taskResponse.status).toBe(201);
	const task = await taskResponse.json() as { task_id: string };
	const crossed = await post(`/api/courses/${math.course_id}/tasks`, { title: "错位", plan_id: plan.plan_id });
	expect(crossed.status).toBe(409);

	// 6. The suggestion path cannot skip confirmation.
	const suggested = await post(`/api/courses/${math.course_id}/plans`, { title: "AI 草案", origin: "agent_suggested", status: "active" });
	expect((await suggested.json() as { status: string }).status).toBe("draft");

	// 7. Restart: bindings and course state survive; the bound session is no
	//    longer unclassified, and nothing was reassigned.
	await stopServer();
	await startServer();

	const afterRestart = await request("/api/courses/unclassified");
	expect((await afterRestart.json() as { sessions: string[] }).sessions).toEqual([]);
	const sessionBinding = await request("/api/courses/bindings/session/legacy-session.jsonl");
	expect(await sessionBinding.json()).toMatchObject({
		unclassified: false, course: { course_id: python.course_id, title: "Python 编程" },
	});
	const detail = await request(`/api/courses/${python.course_id}`);
	const detailBody = await detail.json() as {
		course: CourseBody;
		counts: Record<string, number>;
		plans: { plan_id: string }[];
		tasks: { task_id: string; title: string }[];
		sessions: BindingBody[];
	};
	expect(detailBody.course.title).toBe("Python 编程");
	expect(detailBody.counts).toMatchObject({ plans: 1, tasks: 1, sessions: 1 });
	expect(detailBody.plans.map((entry) => entry.plan_id)).toEqual([plan.plan_id]);
	expect(detailBody.tasks.map((entry) => entry.task_id)).toEqual([task.task_id]);
	expect(detailBody.sessions.map((entry) => entry.session_id)).toEqual(["legacy-session.jsonl"]);

	// 8. Archive retains every relation; history is never deleted.
	const archived = await post(`/api/courses/${python.course_id}/archive`, {});
	expect(archived.status).toBe(200);
	expect((await archived.json() as CourseBody).status).toBe("archived");
	const archivedDetail = await request(`/api/courses/${python.course_id}`);
	const archivedBody = await archivedDetail.json() as { counts: Record<string, number>; sessions: BindingBody[] };
	expect(archivedBody.counts).toMatchObject({ plans: 1, tasks: 1, sessions: 1 });
	expect(archivedBody.sessions[0].session_id).toBe("legacy-session.jsonl");

	// 9. The state file is the single source of truth for ownership.
	const state = JSON.parse(await readFile(join(home, "data", "courses", "state.json"), "utf-8")) as {
		schema_version: number;
		courses: CourseBody[];
		session_bindings: BindingBody[];
	};
	expect(state.schema_version).toBe(1);
	expect(state.courses.map((entry) => entry.title).sort()).toEqual(["Python 编程", "高等数学"]);
	expect(state.session_bindings).toHaveLength(1);
	expect(state.session_bindings[0]).toMatchObject({ session_id: "legacy-session.jsonl", course_id: python.course_id });

	// 10. Validation over HTTP: an unsafe id and a bad status are 400s.
	expect((await patch(`/api/courses/${python.course_id}`, { status: "deleted" })).status).toBe(400);
	expect((await request("/api/courses/course_does_not_exist")).status).toBe(404);
});

it("keeps L1/L2/L3/B2 scoped to the persisted course of a session", async () => {
	// A new conversation for this scenario; the legacy one already belongs to the
	// course created by the previous test.
	const sessionId = "e41a-session.jsonl";
	await writeFile(join(home, "data", "sessions", sessionId),
		JSON.stringify({ role: "user", content: "解释装饰器" }) + "\n", "utf-8");

	// 1. One learner, two courses, two goals; one goal may serve both courses.
	const python = await (await post("/api/courses", { title: "Python 编程" })).json() as CourseBody;
	const math = await (await post("/api/courses", { title: "高等数学" })).json() as CourseBody;
	const pythonGoal = await (await post("/api/learner/profile/goals", { title: "掌握 Python 装饰器" })).json() as { goal_id: string };
	const mathGoal = await (await post("/api/learner/profile/goals", { title: "掌握极限" })).json() as { goal_id: string };
	expect((await post(`/api/courses/${python.course_id}/goals`, { goal_id: pythonGoal.goal_id })).status).toBe(201);
	expect((await post(`/api/courses/${math.course_id}/goals`, { goal_id: mathGoal.goal_id })).status).toBe(201);
	// A shared goal is an explicit second binding, not a move.
	expect((await post(`/api/courses/${math.course_id}/goals`, { goal_id: pythonGoal.goal_id })).status).toBe(201);

	// 2. Course-scoped learner view: goals are bound, preferences stay global.
	const pythonView = await (await request(`/api/courses/${python.course_id}/learner`)).json() as {
		goals: { goal_id: string }[];
		knowledge_states: { course_id?: string }[];
		preferences: Record<string, unknown>;
		unclassified: { knowledge_states: number; goals: number };
	};
	expect(pythonView.goals.map((goal) => goal.goal_id)).toEqual([pythonGoal.goal_id]);
	expect(pythonView.knowledge_states).toEqual([]);
	expect(pythonView.preferences).toBeTypeOf("object");
	expect(pythonView.unclassified.goals).toBe(0);
	const mathView = await (await request(`/api/courses/${math.course_id}/learner`)).json() as { goals: { goal_id: string }[] };
	expect(mathView.goals.map((goal) => goal.goal_id).sort()).toEqual([mathGoal.goal_id, pythonGoal.goal_id].sort());

	// 3. One L2 source may be material of both courses; detaching is a status
	//    change that leaves the other course untouched.
	expect((await post(`/api/courses/${python.course_id}/sources`, { source_id: "l2src_shared" })).status).toBe(201);
	expect((await post(`/api/courses/${math.course_id}/sources`, { source_id: "l2src_shared" })).status).toBe(201);
	expect((await request(`/api/courses/${math.course_id}/sources/l2src_shared`, { method: "DELETE" })).status).toBe(200);
	const mathSources = await (await request(`/api/courses/${math.course_id}/sources`)).json() as { sources: unknown[] };
	const pythonSources = await (await request(`/api/courses/${python.course_id}/sources`)).json() as { sources: { source_id: string }[] };
	expect(mathSources.sources).toEqual([]);
	expect(pythonSources.sources.map((source) => source.source_id)).toEqual(["l2src_shared"]);

	// 4. A course-scoped session exposes the resolved context the memory layers
	//    use: task, active sources and bound goals from one snapshot.
	const task = await (await post(`/api/courses/${python.course_id}/tasks`, { title: "装饰器练习" })).json() as { task_id: string };
	const bound = await post(`/api/courses/${python.course_id}/sessions`, {
		session_id: "e41a-session.jsonl", task_id: task.task_id, origin: "task",
	});
	expect(bound.status).toBe(201);
	const context = await (await request("/api/courses/bindings/session/e41a-session.jsonl")).json() as {
		unclassified: boolean;
		course: CourseBody;
		task: { task_id: string };
		source_ids: string[];
		goal_ids: string[];
	};
	expect(context).toMatchObject({
		unclassified: false,
		course: { course_id: python.course_id },
		task: { task_id: task.task_id },
		source_ids: ["l2src_shared"],
		goal_ids: [pythonGoal.goal_id],
	});

	// 5. B2 stays authoritative: initialising a learning record does not change
	//    the course binding, and the binding is the trace from a B2 session id
	//    back to its course.
	const learning = await post("/api/sessions/e41a-session.jsonl/learning", {});
	expect(learning.status).toBe(200);
	expect(await (await request("/api/sessions/e41a-session.jsonl/learning")).json()).toMatchObject({
		exists: true,
		checkpoint: { step: "conversation" },
	});
	const trace = await (await request("/api/courses/bindings/session/e41a-session.jsonl")).json() as {
		course: CourseBody;
	};
	expect(trace.course.course_id).toBe(python.course_id);

	// 6. Switching course context never moves an existing session: the other
	//    course still refuses to adopt it.
	expect((await post(`/api/courses/${math.course_id}/sessions`, { session_id: "e41a-session.jsonl" })).status).toBe(409);
	expect((await (await request("/api/courses/bindings/session/e41a-session.jsonl")).json() as { course: CourseBody }).course.course_id)
		.toBe(python.course_id);

	// 7. Repeated bindings stay idempotent; the state file has one row per pair.
	await post(`/api/courses/${math.course_id}/goals`, { goal_id: pythonGoal.goal_id });
	await post(`/api/courses/${python.course_id}/sources`, { source_id: "l2src_shared" });
	const state = JSON.parse(await readFile(join(home, "data", "courses", "state.json"), "utf-8")) as {
		goal_bindings: unknown[];
		source_bindings: { course_id: string; source_id: string; status: string }[];
		session_bindings: { session_id: string }[];
	};
	expect(state.session_bindings.filter((entry) => entry.session_id === "e41a-session.jsonl")).toHaveLength(1);
	expect(state.goal_bindings).toHaveLength(3);
	expect(state.source_bindings.filter((entry) => entry.source_id === "l2src_shared")).toEqual([
		expect.objectContaining({ course_id: python.course_id, status: "active" }),
		expect.objectContaining({ course_id: math.course_id, status: "detached" }),
	]);
});
