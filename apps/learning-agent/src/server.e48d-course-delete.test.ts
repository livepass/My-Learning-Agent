import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * E4.8d — deleting an archived course.
 *
 * The business rule changed: an archived course may be permanently deleted even
 * when it holds conversations, started tasks, B2 evidence and L1 mastery. These
 * five end-to-end cases are the acceptance list, run against a real server,
 * real session files, a real B2 record store and a real L1 profile:
 *
 * 1. an archived empty course deletes;
 * 2. an archived course with several conversations and tasks deletes;
 * 3. formal B2/L1 history does not refuse a confirmed delete;
 * 4. deleting course A leaves course B, shared material and shared learning
 *    memory untouched;
 * 5. a cleanup failure or unreadable store never produces a fake success or an
 *    orphaned record.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body?: unknown) =>
	request(path, {
		method: "POST",
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
const patch = (path: string, body: unknown) =>
	request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (path: string) => request(path, { method: "DELETE" });

interface CourseBody { course_id: string; status: string; title: string }
interface PlanBody { plan: { plan_id: string }; tasks: Array<{ task_id: string }> }
interface StartBody { session: { session_id: string } }

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

async function createActivePlan(courseId: string, tasks: number): Promise<PlanBody> {
	const created = await post(`/api/courses/${courseId}/plans`, {
		title: "学习计划",
		status: "active",
		stages: [{ title: "阶段", tasks: Array.from({ length: tasks }, (_, index) => ({ title: `任务 ${index + 1}` })) }],
	});
	expect(created.status).toBe(201);
	return (await created.json()) as PlanBody;
}

async function startLearning(courseId: string, taskId: string | null, requestId: string): Promise<string> {
	const started = await post(`/api/courses/${courseId}/learning/start`, { task_id: taskId, request_id: requestId });
	expect([200, 201]).toContain(started.status);
	return ((await started.json()) as StartBody).session.session_id;
}

const sessionFile = (sessionId: string) => join(home, "data", "sessions", sessionId);
const recordFile = (sessionId: string) => join(home, "data", "learning", `${sessionId}.json`);
const profileFile = () => join(home, "data", "learner", "profile.json");

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-e48d-course-delete-"));
	provider = createServer((_req, res) => {
		// No model call may happen during a delete.
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-e48d-course-delete-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

describe("E4.8d — archived course delete", () => {
	it("1. deletes an archived course that never held history", async () => {
		const courseId = await createCourse("归档空课程");
		await post(`/api/courses/${courseId}/archive`);

		const preview = await (await request(`/api/courses/${courseId}/delete-preview`)).json() as {
			archived: boolean;
			deletable: boolean;
			blockers: unknown[];
		};
		expect(preview).toMatchObject({ archived: true, deletable: true, blockers: [] });

		const deleted = await del(`/api/courses/${courseId}`);
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ deleted: true, complete: true });
		expect((await request(`/api/courses/${courseId}`)).status).toBe(404);
	});

	it("2. deletes an archived course with several conversations and tasks", async () => {
		const courseId = await createCourse("多会话课程");
		const plan = await createActivePlan(courseId, 2);
		const first = await startLearning(courseId, plan.tasks[0].task_id, "req_e48d_multi_1");
		const second = await startLearning(courseId, null, "req_e48d_multi_2");
		await patch(`/api/courses/${courseId}/tasks/${plan.tasks[0].task_id}`, { status: "in_progress" });
		await post(`/api/courses/${courseId}/archive`);

		const preview = await (await request(`/api/courses/${courseId}/delete-preview`)).json() as {
			deletable: boolean;
			counts: { sessions: number; started_tasks: number };
		};
		expect(preview.deletable).toBe(true);
		expect(preview.counts).toMatchObject({ sessions: 2, started_tasks: 1 });

		const deleted = await del(`/api/courses/${courseId}`);
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ deleted: true, sessions_removed: 2, complete: true });

		for (const sessionId of [first, second]) {
			expect(existsSync(sessionFile(sessionId))).toBe(false);
			expect(existsSync(recordFile(sessionId))).toBe(false);
		}
		const rows = await (await request("/api/sessions")).json() as Array<{ id: string }>;
		expect(rows.some((row) => row.id === first || row.id === second)).toBe(false);
	});

	it("3. does not refuse a confirmed delete because of formal B2/L1 history", async () => {
		const courseId = await createCourse("有证据课程");
		const sessionId = await startLearning(courseId, null, "req_e48d_evidence");

		// A real B2 record with a finalized attempt (the store's own shape).
		const record = JSON.parse(await readFile(recordFile(sessionId), "utf-8")) as Record<string, unknown>;
		await writeFile(recordFile(sessionId), JSON.stringify({
			...record,
			attempts: [{ attempt_id: "a1", progress: { stage: "evidence_recorded" } }],
		}), "utf-8");
		// A course-scoped L1 mastery state.
		const profile = JSON.parse(await readFile(profileFile(), "utf-8")) as {
			knowledge_states: Array<Record<string, unknown>>;
		};
		profile.knowledge_states = [
			{ concept_id: "closure", concept_name: "闭包", domain: "python", course_id: courseId, mastery: 0.6 },
			{ concept_id: "limit", concept_name: "极限", domain: "math", mastery: 0.3 },
		];
		await writeFile(profileFile(), JSON.stringify(profile), "utf-8");
		await post(`/api/courses/${courseId}/archive`);

		const preview = await (await request(`/api/courses/${courseId}/delete-preview`)).json() as {
			deletable: boolean;
			blockers: unknown[];
			b2_evidence_sessions?: number;
			b2_evidence_attempts?: number;
			mastery_state_count?: number;
		};
		expect(preview.deletable).toBe(true);
		expect(preview.blockers).toEqual([]);
		expect(preview.b2_evidence_sessions).toBe(1);
		expect(preview.b2_evidence_attempts).toBe(1);
		expect(preview.mastery_state_count).toBe(1);

		expect((await del(`/api/courses/${courseId}`)).status).toBe(200);

		// The course's own evidence is gone; the unclassified state survives.
		expect(existsSync(recordFile(sessionId))).toBe(false);
		const after = JSON.parse(await readFile(profileFile(), "utf-8")) as {
			knowledge_states: Array<{ concept_id: string; course_id?: string }>;
		};
		expect(after.knowledge_states.map((state) => state.concept_id)).toEqual(["limit"]);
	});

	it("4. leaves another course, shared material and shared memory untouched", async () => {
		const target = await createCourse("待删除课程");
		const survivor = await createCourse("保留课程");
		const targetSession = await startLearning(target, null, "req_e48d_scope_a");
		const survivorSession = await startLearning(survivor, null, "req_e48d_scope_b");

		// One L2 document associated with both courses (the file is shared).
		await mkdir(join(home, "data", "l2"), { recursive: true });
		const manifestPath = join(home, "data", "l2", "manifest.jsonl");
		await writeFile(manifestPath, `${JSON.stringify({
			id: "l2src_shared01",
			title: "共享教材.pdf",
			status: "indexed",
			sourceType: "pdf",
			passageCount: 3,
			updatedAt: "2026-11-01T00:00:00.000Z",
		})}\n`, "utf-8");
		expect((await post(`/api/courses/${target}/sources`, { source_id: "l2src_shared01" })).status).toBe(201);
		expect((await post(`/api/courses/${survivor}/sources`, { source_id: "l2src_shared01" })).status).toBe(201);

		const profile = JSON.parse(await readFile(profileFile(), "utf-8")) as {
			knowledge_states: Array<Record<string, unknown>>;
		};
		profile.knowledge_states = [
			{ concept_id: "a_concept", concept_name: "A", domain: "x", course_id: target, mastery: 0.5 },
			{ concept_id: "b_concept", concept_name: "B", domain: "y", course_id: survivor, mastery: 0.5 },
			{ concept_id: "shared", concept_name: "共享", domain: "z", mastery: 0.2 },
		];
		await writeFile(profileFile(), JSON.stringify(profile), "utf-8");
		await post(`/api/courses/${target}/archive`);

		expect((await del(`/api/courses/${target}`)).status).toBe(200);

		// Course B, its conversation and its L1 state are intact.
		expect((await request(`/api/courses/${survivor}`)).status).toBe(200);
		expect(existsSync(sessionFile(survivorSession))).toBe(true);
		expect(existsSync(recordFile(survivorSession))).toBe(true);
		expect(existsSync(sessionFile(targetSession))).toBe(false);

		// The shared document stays in the manifest, still owned by course B.
		const manifest = await readFile(manifestPath, "utf-8");
		expect(manifest).toContain("l2src_shared01");
		const sources = await (await request(`/api/courses/${survivor}/sources`)).json() as {
			sources: Array<{ source_id: string }>;
		};
		expect(sources.sources.map((source) => source.source_id)).toContain("l2src_shared01");

		const after = JSON.parse(await readFile(profileFile(), "utf-8")) as {
			knowledge_states: Array<{ concept_id: string }>;
		};
		const concepts = after.knowledge_states.map((state) => state.concept_id).sort();
		expect(concepts).toEqual(["b_concept", "shared"]);
	});

	it("5. refuses with 503 and removes nothing when B2 cannot be read", async () => {
		const courseId = await createCourse("损坏证据课程");
		const sessionId = await startLearning(courseId, null, "req_e48d_corrupt");
		await post(`/api/courses/${courseId}/archive`);
		// A corrupt record must not be read as "no evidence".
		await writeFile(recordFile(sessionId), "{ this is not valid json", "utf-8");

		const preview = await request(`/api/courses/${courseId}/delete-preview`);
		expect(preview.status).toBe(503);
		expect(await preview.json()).toMatchObject({ error: "course_io" });

		const deleted = await del(`/api/courses/${courseId}`);
		expect(deleted.status).toBe(503);
		expect(await deleted.json()).toMatchObject({ error: "course_io" });

		// Nothing was removed: the course, its conversation and its record remain,
		// so a retry after fixing the data is still possible.
		expect((await request(`/api/courses/${courseId}`)).status).toBe(200);
		expect(existsSync(sessionFile(sessionId))).toBe(true);
		expect(existsSync(recordFile(sessionId))).toBe(true);
	});
});
