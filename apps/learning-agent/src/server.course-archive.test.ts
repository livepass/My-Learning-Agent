import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * E4.7-R1b/R1c end-to-end: a real server, real session files and real course
 * state. The archive centre depends on two independent states (a session's own
 * flag and its parent course), and only an end-to-end run can prove that
 *
 * - a course archive never rewrites the session flags;
 * - daily visibility is derived from both;
 * - a child session cannot be restored while its parent course is archived;
 * - restoring a course lands on `paused` and keeps plans/tasks/sessions;
 * - the derived state survives a restart.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

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
interface PlanBody { plan: { plan_id: string }; tasks: Array<{ task_id: string }> }
interface StartBody { session: { session_id: string } }
interface SessionRow {
	id: string;
	archived: boolean;
	daily_visible: boolean;
	course: { course_id: string; title: string; archived: boolean } | null;
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

async function sessionRow(sessionId: string): Promise<SessionRow> {
	const rows = await (await request("/api/sessions")).json() as SessionRow[];
	const row = rows.find((candidate) => candidate.id === sessionId);
	if (!row) throw new Error(`session ${sessionId} is missing from /api/sessions`);
	return row;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-course-archive-"));
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-course-archive-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

let course: CourseBody;
let plan: PlanBody;
let courseSession: string;

it("starts a course session that the daily list can show", async () => {
	course = await (await post("/api/courses", { title: "Python 编程" })).json() as CourseBody;
	plan = await (await post(`/api/courses/${course.course_id}/plans`, {
		title: "Python 计划",
		status: "active",
		stages: [{ title: "基础", tasks: [{ title: "阅读装饰器教材" }] }],
	})).json() as PlanBody;
	const started = await (await post(`/api/courses/${course.course_id}/learning/start`, {
		task_id: plan.tasks[0].task_id,
		request_id: "req_archive_center",
	})).json() as StartBody;
	courseSession = started.session.session_id;

	const row = await sessionRow(courseSession);
	expect(row).toMatchObject({
		archived: false,
		daily_visible: true,
		course: { course_id: course.course_id, archived: false },
	});
	expect(providerCalls).toBe(0);
});

it("archives and restores a session through the existing API", async () => {
	expect((await post(`/api/sessions/${encodeURIComponent(courseSession)}/archive`)).status).toBe(200);
	expect(await sessionRow(courseSession)).toMatchObject({ archived: true, daily_visible: false });

	expect((await post(`/api/sessions/${encodeURIComponent(courseSession)}/unarchive`)).status).toBe(200);
	expect(await sessionRow(courseSession)).toMatchObject({ archived: false, daily_visible: true });
});

it("hides a session with its archived course without rewriting its own flag", async () => {
	expect((await post(`/api/courses/${course.course_id}/archive`)).status).toBe(200);

	const row = await sessionRow(courseSession);
	expect(row).toMatchObject({
		archived: false, // the session was never manually archived
		daily_visible: false,
		course: { course_id: course.course_id, archived: true },
	});
	// The course keeps plans/tasks/sessions while archived; only writes freeze.
	const detail = await (await request(`/api/courses/${course.course_id}`)).json() as {
		counts: { plans: number; tasks: number; sessions: number };
	};
	expect(detail.counts).toMatchObject({ plans: 1, tasks: 1, sessions: 1 });
});

it("refuses to restore the child session while the course is archived", async () => {
	const refused = await post(`/api/sessions/${encodeURIComponent(courseSession)}/unarchive`);
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({ error: "course_archived" });
	expect(await sessionRow(courseSession)).toMatchObject({ archived: false, daily_visible: false });
});

it("restores the course to paused and brings unarchived sessions back", async () => {
	const restored = await post(`/api/courses/${course.course_id}/restore`);
	expect(restored.status).toBe(200);
	expect(await restored.json()).toMatchObject({ status: "paused" });

	expect(await sessionRow(courseSession)).toMatchObject({
		archived: false,
		daily_visible: true,
		course: { archived: false },
	});
	// Same id, same plan/task/session links; nothing restarted on its own.
	const detail = await (await request(`/api/courses/${course.course_id}`)).json() as {
		course: { course_id: string; status: string };
		counts: { plans: number; tasks: number; sessions: number };
		tasks: Array<{ status: string }>;
	};
	expect(detail.course).toMatchObject({ course_id: course.course_id, status: "paused" });
	expect(detail.counts).toMatchObject({ plans: 1, tasks: 1, sessions: 1 });
	expect(detail.tasks[0].status).toBe("in_progress");
});

it("keeps a manually archived session hidden after the course is restored", async () => {
	// The course is paused after restore; 继续课程 is the explicit way back.
	expect((await post(`/api/courses/${course.course_id}/resume`)).status).toBe(200);
	const second = await (await post(`/api/courses/${course.course_id}/learning/start`, {
		request_id: "req_second_free",
	})).json() as StartBody;
	expect((await post(`/api/sessions/${encodeURIComponent(second.session.session_id)}/archive`)).status).toBe(200);

	await post(`/api/courses/${course.course_id}/archive`);
	await post(`/api/courses/${course.course_id}/restore`);

	expect(await sessionRow(second.session.session_id)).toMatchObject({
		archived: true,
		daily_visible: false,
		course: { archived: false },
	});
	expect(await sessionRow(courseSession)).toMatchObject({ archived: false, daily_visible: true });
});

it("keeps the derived state and the paused course across a restart", async () => {
	await stopServer();
	await startServer();

	expect(await sessionRow(courseSession)).toMatchObject({ archived: false, daily_visible: true });
	const detail = await (await request(`/api/courses/${course.course_id}`)).json() as {
		course: { status: string };
		counts: { plans: number; tasks: number };
	};
	expect(detail.course.status).toBe("paused");
	expect(detail.counts).toMatchObject({ plans: 1, tasks: 1 });
	expect(providerCalls).toBe(0);
});

describe("E4.7-R1c — two independent archive states", () => {
	it("leaves a free conversation governed only by its own flag", async () => {
		const created = await (await post("/api/sessions", {})).json() as { id: string };
		expect(await sessionRow(created.id)).toMatchObject({
			course: null,
			archived: false,
			daily_visible: true,
		});

		expect((await post(`/api/sessions/${encodeURIComponent(created.id)}/archive`)).status).toBe(200);
		expect(await sessionRow(created.id)).toMatchObject({ archived: true, daily_visible: false });
		expect((await post(`/api/sessions/${encodeURIComponent(created.id)}/unarchive`)).status).toBe(200);
		expect(await sessionRow(created.id)).toMatchObject({ archived: false, daily_visible: true });
	});

	it("never rewrites child session flags when the course is archived", async () => {
		expect((await post(`/api/courses/${course.course_id}/archive`)).status).toBe(200);

		const archives = JSON.parse(
			await readFile(join(home, "data", "sessions", "archives.json"), "utf-8").catch(() => "{}"),
		) as Record<string, boolean>;
		// The parent's state is not smeared onto the children: the session keeps
		// its own flag (here: explicitly restored, so not `true`).
		expect(archives[courseSession]).not.toBe(true);
		expect(await sessionRow(courseSession)).toMatchObject({ archived: false, daily_visible: false });

		await post(`/api/courses/${course.course_id}/restore`);
	});

	it("refuses new learning records inside an archived course and leaves B2 untouched", async () => {
		expect((await post(`/api/courses/${course.course_id}/archive`)).status).toBe(200);
		const recordPath = join(home, "data", "learning", `${courseSession}.json`);
		const before = await readFile(recordPath, "utf-8");

		const generated = await post(
			`/api/sessions/${encodeURIComponent(courseSession)}/learning/questions/generate`,
			{},
		);
		expect(generated.status).toBe(409);
		expect(await generated.json()).toMatchObject({ error: "course_archived" });

		const answered = await post(
			`/api/sessions/${encodeURIComponent(courseSession)}/learning/attempts`,
			{ answer: "这是一次尝试" },
		);
		expect(answered.status).toBe(409);
		expect(await answered.json()).toMatchObject({ error: "course_archived" });

		// History is readable and unchanged; the model was never called.
		expect(await readFile(recordPath, "utf-8")).toBe(before);
		expect(providerCalls).toBe(0);

		await post(`/api/courses/${course.course_id}/restore`);
	});
});

describe("E4.7-R1 final — resume, archive-centre delete and history-only sessions", () => {
	it("resumes a restored course explicitly and starts nothing", async () => {
		// The previous block left the course restored to `paused`.
		const before = await (await request(`/api/courses/${course.course_id}`)).json() as {
			counts: { sessions: number };
			tasks: Array<{ task_id: string; status: string }>;
		};
		const resumed = await post(`/api/courses/${course.course_id}/resume`);
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toMatchObject({ course_id: course.course_id, status: "in_progress" });

		const after = await (await request(`/api/courses/${course.course_id}`)).json() as {
			counts: { sessions: number };
			tasks: Array<{ task_id: string; status: string }>;
		};
		expect(after.counts.sessions).toBe(before.counts.sessions);
		expect(after.tasks.map((task) => task.status)).toEqual(before.tasks.map((task) => task.status));

		// A paused course cannot reach learning/start until it is resumed.
		await request(`/api/courses/${course.course_id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "paused" }),
		});
		const refused = await post(`/api/courses/${course.course_id}/learning/start`, { request_id: "req_paused_final" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ error: "course_paused" });
		await post(`/api/courses/${course.course_id}/resume`);
	});

	it("deletes an archived course that never held learning history", async () => {
		const empty = await (await post("/api/courses", { title: "归档空课程" })).json() as CourseBody;
		await post(`/api/courses/${empty.course_id}/plans`, {
			title: "草稿计划",
			status: "draft",
			stages: [{ title: "阶段", tasks: [{ title: "任务" }] }],
		});
		await post(`/api/courses/${empty.course_id}/archive`);

		const preview = await (await request(`/api/courses/${empty.course_id}/delete-preview`)).json() as {
			deletable: boolean;
			blockers: unknown[];
		};
		expect(preview).toMatchObject({ deletable: true, blockers: [] });

		expect((await request(`/api/courses/${empty.course_id}`, { method: "DELETE" })).status).toBe(200);
		const list = await (await request("/api/courses")).json() as { courses: CourseBody[] };
		expect(list.courses.some((row) => row.course_id === empty.course_id)).toBe(false);
		expect((await request(`/api/courses/${empty.course_id}`)).status).toBe(404);
	});

	it("refuses to delete the archived course that holds this learning session", async () => {
		await post(`/api/courses/${course.course_id}/archive`);
		const preview = await (await request(`/api/courses/${course.course_id}/delete-preview`)).json() as {
			deletable: boolean;
			blockers: Array<{ code: string }>;
		};
		expect(preview.deletable).toBe(false);
		expect(preview.blockers.map((blocker) => blocker.code)).toContain("course_sessions");

		const deleted = await request(`/api/courses/${course.course_id}`, { method: "DELETE" });
		expect(deleted.status).toBe(409);
		expect((await deleted.json() as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code))
			.toContain("course_sessions");
		// The refused delete keeps the course (and its history) intact.
		expect((await request(`/api/courses/${course.course_id}`)).status).toBe(200);
		await post(`/api/courses/${course.course_id}/restore`);
	});

	it("keeps a manually archived session readable but refuses every learning write", async () => {
		const created = await (await post("/api/sessions", {})).json() as { id: string };
		expect((await post(`/api/sessions/${encodeURIComponent(created.id)}/learning`, {})).status).toBe(200);
		const recordPath = join(home, "data", "learning", `${created.id}.json`);
		const recordBefore = await readFile(recordPath, "utf-8");
		expect((await post(`/api/sessions/${encodeURIComponent(created.id)}/archive`)).status).toBe(200);

		// Opening the history is a read and must not clear the archive flag.
		expect((await request(`/api/sessions/${encodeURIComponent(created.id)}`)).status).toBe(200);
		expect(await sessionRow(created.id)).toMatchObject({ archived: true, daily_visible: false });

		const chat = await post("/api/chat", { prompt: "继续讲一下", sessionId: created.id });
		expect(chat.status).toBe(409);
		expect(await chat.json()).toMatchObject({ error: "session_archived" });
		const stream = await post("/api/chat/stream", {
			prompt: "继续讲一下",
			sessionId: created.id,
			clientRequestId: "req_archived_stream",
		});
		expect(stream.status).toBe(409);
		expect(await stream.json()).toMatchObject({ error: "session_archived" });

		const generate = await post(`/api/sessions/${encodeURIComponent(created.id)}/learning/questions/generate`, {});
		expect(generate.status).toBe(409);
		expect(await generate.json()).toMatchObject({ error: "session_archived" });
		const answer = await post(`/api/sessions/${encodeURIComponent(created.id)}/learning/attempts`, { answer: "x" });
		expect(answer.status).toBe(409);
		expect(await answer.json()).toMatchObject({ error: "session_archived" });
		const reinit = await post(`/api/sessions/${encodeURIComponent(created.id)}/learning`, {});
		expect(reinit.status).toBe(409);
		const pause = await post(`/api/sessions/${encodeURIComponent(created.id)}/learning/pause`, { revision: 1 });
		expect(pause.status).toBe(409);

		expect(await readFile(recordPath, "utf-8")).toBe(recordBefore);
		expect(providerCalls).toBe(0);

		// Restoring the session is the only way back to a writable conversation.
		expect((await post(`/api/sessions/${encodeURIComponent(created.id)}/unarchive`)).status).toBe(200);
		expect(await sessionRow(created.id)).toMatchObject({ archived: false, daily_visible: true });
	});
});

describe("E4.7-R2a — unreadable B2 is a hard refusal", () => {
	it("returns 503 for both preview and delete when a bound learning record is corrupt", async () => {
		const target = await (await post("/api/courses", { title: "R2a B2 损坏课程" })).json() as CourseBody;
		const targetPlan = await (await post(`/api/courses/${target.course_id}/plans`, {
			title: "计划",
			status: "active",
			stages: [{ title: "阶段", tasks: [{ title: "任务" }] }],
		})).json() as PlanBody;
		const started = await (await post(`/api/courses/${target.course_id}/learning/start`, {
			task_id: targetPlan.tasks[0].task_id,
			request_id: "req_r2a_b2_corrupt",
		})).json() as StartBody;
		const recordPath = join(home, "data", "learning", `${started.session.session_id}.json`);
		// The server must not treat "cannot read" as "no evidence".
		await writeFile(recordPath, "{ this is not valid json", "utf-8");

		const preview = await request(`/api/courses/${target.course_id}/delete-preview`);
		expect(preview.status).toBe(503);
		expect(await preview.json()).toMatchObject({ error: "course_io" });

		const deleted = await request(`/api/courses/${target.course_id}`, { method: "DELETE" });
		expect(deleted.status).toBe(503);
		expect(await deleted.json()).toMatchObject({ error: "course_io" });

		// Nothing was removed; the course is still readable.
		expect((await request(`/api/courses/${target.course_id}`)).status).toBe(200);
	});
});
