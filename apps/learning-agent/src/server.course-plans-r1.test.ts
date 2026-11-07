import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDefaultProfile, type LearnerProfile } from "./memory/learner/types.js";

/**
 * E4.3-R1 end-to-end regressions: replay before the model call, single-flight,
 * draft id uniqueness, cross-plan moves, bound tasks and source/goal scope.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

type ProviderMode = "plan" | "error" | "invalid";
let providerMode: ProviderMode = "plan";
let providerCalls = 0;
let providerDelayMs = 0;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(120_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
	request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
	request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function sseChunk(content: string, finish: string | null): string {
	return JSON.stringify({
		id: "fixture", object: "chat.completion.chunk", created: 0, model: "dummy",
		choices: [{ index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: finish }],
	});
}

function planReply(prompt: string): unknown {
	const unitIds = [...prompt.matchAll(/\[(u\d{2})\]/g)].map((match) => match[1]);
	return {
		title: "R1 计划",
		description: "R1 回归计划",
		stages: [{
			title: "基础",
			tasks: [
				{ title: "任务一", concept: "知识点一", minutes: 20, ...(unitIds[0] ? { unit_id: unitIds[0] } : {}) },
				{ title: "任务二", concept: "知识点二", minutes: 30, ...(unitIds[0] ? { unit_id: unitIds[0] } : {}) },
			],
		}],
		assumptions: [],
		uncertainties: [],
	};
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

interface CourseBody { course_id: string; title: string }
interface TaskBody { task_id: string; title: string; order: number; plan_id: string | null; status: string }
interface PlanBody { plan_id: string; revision: number; status: string }
interface PlanDetail { plan: PlanBody; stages: Array<{ stage_id: string; title: string }>; tasks: TaskBody[] }

const PYTHON_MATERIAL = "# Python 教材\n\n## 第三章 装饰器\n\n装饰器是接收函数并返回函数的高阶函数。\n";

async function upload(courseId: string, fileName: string, text: string) {
	return post(`/api/courses/${courseId}/sources/upload`, {
		fileName,
		mimeType: "text/markdown",
		title: fileName.replace(/\.md$/, ""),
		dataBase64: Buffer.from(text, "utf-8").toString("base64"),
	});
}

async function stateRevision(): Promise<number> {
	const state = JSON.parse(await readFile(join(home, "data", "courses", "state.json"), "utf-8")) as { revision: number };
	return state.revision;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-course-r1-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			providerCalls += 1;
			const respond = () => {
				if (providerMode === "error") {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "fixture down" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				if (providerMode === "invalid") {
					res.write(`data: ${sseChunk("这不是 JSON", null)}\n\n`);
					res.write(`data: ${sseChunk("", "stop")}\n\n`);
					res.end("data: [DONE]\n\n");
					return;
				}
				const json = JSON.stringify(planReply(body));
				res.write(`data: ${sseChunk(json.slice(0, 80), null)}\n\n`);
				res.write(`data: ${sseChunk(json.slice(80), null)}\n\n`);
				res.write(`data: ${sseChunk("", "stop")}\n\n`);
				res.end("data: [DONE]\n\n");
			};
			if (providerDelayMs > 0) setTimeout(respond, providerDelayMs);
			else respond();
		});
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
	const profile: LearnerProfile = createDefaultProfile("default");
	profile.goals = [{
		goal_id: "goal_python", title: "学会装饰器", type: "skill", priority: 1,
		status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-11-01T00:00:00.000Z",
	}];
	await writeFile(join(home, "data", "learner", "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
	await startServer();
}, 240_000);

afterAll(async () => {
	await stopServer();
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((yes) => provider.close(() => yes()));
	}
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-course-r1-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

let python: CourseBody;
let pythonSourceId: string;
let basePlan: PlanDetail;

it("sets up a course, goal and material", async () => {
	python = await (await post("/api/courses", { title: "Python 编程" })).json() as CourseBody;
	expect((await post(`/api/courses/${python.course_id}/goals`, { goal_id: "goal_python" })).status).toBe(201);
	const uploaded = await upload(python.course_id, "python.md", PYTHON_MATERIAL);
	expect(uploaded.status).toBe(201);
	pythonSourceId = (await uploaded.json() as { source_id: string }).source_id;
});

it("generates a baseline draft", async () => {
	providerMode = "plan";
	providerCalls = 0;
	const response = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_base",
		daily_minutes: 45,
	});
	expect(response.status).toBe(201);
	basePlan = await response.json() as PlanDetail;
	expect(basePlan.tasks).toHaveLength(2);
	expect(providerCalls).toBe(1);
});

it("replays a request without calling the model and without a version bump", async () => {
	const beforeRevision = await stateRevision();
	providerMode = "error";
	providerCalls = 0;
	const replay = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_base",
		daily_minutes: 45,
	});
	expect(replay.status).toBe(200);
	const body = await replay.json() as PlanDetail & { duplicate: boolean; matched: string };
	expect(body.duplicate).toBe(true);
	expect(body.matched).toBe("request_id");
	expect(body.plan.plan_id).toBe(basePlan.plan.plan_id);
	expect(body.tasks.map((task) => task.task_id)).toEqual(basePlan.tasks.map((task) => task.task_id));
	expect(providerCalls).toBe(0);
	expect(await stateRevision()).toBe(beforeRevision);
});

it("rejects the same request id with a different intent before the model", async () => {
	providerMode = "error";
	providerCalls = 0;
	const conflict = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_base",
		daily_minutes: 45,
		foundation: "另一种基础",
	});
	expect(conflict.status).toBe(409);
	expect(await conflict.json()).toMatchObject({ error: "request_conflict" });
	expect(providerCalls).toBe(0);
});

it("single-flights concurrent identical requests", async () => {
	providerMode = "plan";
	providerCalls = 0;
	providerDelayMs = 600;
	const payload = { request_id: "req_concurrent_a", daily_minutes: 45, foundation: "并发测试" };
	const second = { ...payload, request_id: "req_concurrent_b" };
	const [first, concurrent] = await Promise.all([
		post(`/api/courses/${python.course_id}/plans/generate`, payload),
		post(`/api/courses/${python.course_id}/plans/generate`, second),
	]);
	providerDelayMs = 0;
	expect([200, 201]).toContain(first.status);
	expect([200, 201]).toContain(concurrent.status);
	const firstBody = await first.json() as PlanDetail;
	const concurrentBody = await concurrent.json() as PlanDetail;
	expect(providerCalls).toBe(1);
	expect(concurrentBody.plan.plan_id).toBe(firstBody.plan.plan_id);
});

it("rejects duplicate task ids in one draft payload without writing", async () => {
	const created = await post(`/api/courses/${python.course_id}/plans`, {
		title: "ID 测试",
		status: "draft",
		stages: [{ title: "基础", tasks: [{ title: "A" }, { title: "B" }] }],
	});
	const body = await created.json() as PlanDetail;
	const response = await put(`/api/courses/${python.course_id}/plans/${body.plan.plan_id}/draft`, {
		expected_revision: 1,
		stages: [{
			stage_id: body.stages[0].stage_id,
			title: "基础",
			tasks: [
				{ task_id: body.tasks[0].task_id, title: "A" },
				{ task_id: body.tasks[0].task_id, title: "重复" },
			],
		}],
	});
	expect(response.status).toBe(400);
	const detail = await (await request(`/api/courses/${python.course_id}/plans/${body.plan.plan_id}`)).json() as PlanDetail;
	expect(detail.plan.revision).toBe(1);
	expect(detail.tasks.map((task) => task.title)).toEqual(["A", "B"]);
});

it("moves a task to another plan and bumps both revisions", async () => {
	const target = await (await post(`/api/courses/${python.course_id}/plans`, {
		title: "目标计划",
		status: "draft",
		stages: [{ title: "目标", tasks: [{ title: "已有任务" }] }],
	})).json() as PlanDetail;
	const sourceRevision = basePlan.plan.revision;
	const response = await patch(`/api/courses/${python.course_id}/tasks/${basePlan.tasks[1].task_id}`, {
		plan_id: target.plan.plan_id,
		expected_revision: sourceRevision,
	});
	expect(response.status).toBe(200);
	const moved = await response.json() as TaskBody;
	expect(moved).toMatchObject({ plan_id: target.plan.plan_id, order: 1 });
	const sourceDetail = await (await request(`/api/courses/${python.course_id}/plans/${basePlan.plan.plan_id}`)).json() as PlanDetail;
	const targetDetail = await (await request(`/api/courses/${python.course_id}/plans/${target.plan.plan_id}`)).json() as PlanDetail;
	expect(sourceDetail.tasks.map((task) => [task.title, task.order])).toEqual([[basePlan.tasks[0].title, 0]]);
	expect(targetDetail.tasks.map((task) => [task.title, task.order])).toEqual([["已有任务", 0], [basePlan.tasks[1].title, 1]]);
	expect(sourceDetail.plan.revision).toBe(sourceRevision + 1);
	expect(targetDetail.plan.revision).toBe(target.plan.revision + 1);
});

it("refuses to delete a task bound to a learning session", async () => {
	const created = await post("/api/sessions", {});
	const { id } = await created.json() as { id: string };
	const bound = await post(`/api/courses/${python.course_id}/sessions`, {
		session_id: id,
		task_id: basePlan.tasks[0].task_id,
	});
	expect(bound.status).toBe(201);
	const deleted = await request(`/api/courses/${python.course_id}/tasks/${basePlan.tasks[0].task_id}`, { method: "DELETE" });
	expect(deleted.status).toBe(409);
	const detail = await (await request(`/api/courses/${python.course_id}/plans/${basePlan.plan.plan_id}`)).json() as PlanDetail;
	expect(detail.tasks.some((task) => task.task_id === basePlan.tasks[0].task_id)).toBe(true);
	const sessions = await (await request(`/api/courses/${python.course_id}/sessions`)).json() as {
		sessions: Array<{ session_id: string; task_id: string | null }>;
	};
	expect(sessions.sessions.find((binding) => binding.session_id === id)?.task_id).toBe(basePlan.tasks[0].task_id);
});

it("rejects cross-course goals and sources and client-made citations", async () => {
	const other = await (await post("/api/courses", { title: "无来源课程" })).json() as CourseBody;
	const badGoal = await post(`/api/courses/${other.course_id}/plans`, {
		title: "错绑目标",
		goal_id: "goal_python",
		stages: [{ title: "阶段", tasks: [{ title: "A" }] }],
	});
	expect(badGoal.status).toBe(409);

	const badSource = await post(`/api/courses/${other.course_id}/tasks`, {
		title: "错绑来源",
		source_ids: [pythonSourceId],
	});
	expect(badSource.status).toBe(409);

	const fakeCitation = await post(`/api/courses/${python.course_id}/tasks`, {
		title: "伪造引用",
		source_ids: [pythonSourceId],
		source_refs: [{ source_id: pythonSourceId, page_path: "wiki/passages/fake/p0001.md" }],
	});
	expect(fakeCitation.status).toBe(400);

	const valid = await post(`/api/courses/${python.course_id}/tasks`, {
		title: "可信来源",
		source_ids: [pythonSourceId],
	});
	expect(valid.status).toBe(201);
});

it("regenerates after material changes instead of reusing the old fingerprint", async () => {
	const manifestPath = join(home, "data", "l2", "manifest.jsonl");
	const lines = (await readFile(manifestPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	const entry = lines.find((item) => item.id === pythonSourceId)!;
	entry.contentHash = "changed-content-hash";
	entry.updatedAt = "2026-11-07T12:00:00.000Z";
	await writeFile(manifestPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");

	providerMode = "plan";
	providerCalls = 0;
	// Same request id is still an intent replay even though material changed.
	const replayAfterChange = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_base",
		daily_minutes: 45,
	});
	expect(replayAfterChange.status).toBe(200);
	expect((await replayAfterChange.json() as PlanDetail).plan.plan_id).toBe(basePlan.plan.plan_id);
	expect(providerCalls).toBe(0);

	const regenerated = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_after_material_change",
		daily_minutes: 45,
	});
	expect(regenerated.status).toBe(201);
	const body = await regenerated.json() as PlanDetail & { duplicate: boolean };
	expect(body.duplicate).toBe(false);
	expect(body.plan.plan_id).not.toBe(basePlan.plan.plan_id);
	expect(providerCalls).toBe(1);
});

it("replays a successful request after every source is unbound, without a model call", async () => {
	const before = await (await request(`/api/courses/${python.course_id}/plans`)).json() as { plans: unknown[] };
	const bound = await (await request(`/api/courses/${python.course_id}/sources`)).json() as {
		sources: Array<{ source_id: string }>;
	};
	expect(bound.sources.length).toBeGreaterThan(0);
	for (const source of bound.sources) {
		const detached = await request(`/api/courses/${python.course_id}/sources/${source.source_id}`, { method: "DELETE" });
		expect(detached.status).toBe(200);
	}

	providerMode = "error";
	providerCalls = 0;
	// The material that produced the plan is gone, but the request itself is
	// still a replay: same plan, no model call, no new plan record.
	const replay = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_base",
		daily_minutes: 45,
	});
	expect(replay.status).toBe(200);
	const body = await replay.json() as PlanDetail & { duplicate: boolean; matched: string };
	expect(body.matched).toBe("request_id");
	expect(body.plan.plan_id).toBe(basePlan.plan.plan_id);
	expect(providerCalls).toBe(0);
	const after = await (await request(`/api/courses/${python.course_id}/plans`)).json() as { plans: unknown[] };
	expect(after.plans.length).toBe(before.plans.length);

	// A genuinely new request with no material now fails closed before the
	// model, instead of producing a plan that pretends to cite material.
	const fresh = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_no_material",
		daily_minutes: 45,
	});
	expect(fresh.status).toBe(409);
	expect(await fresh.json()).toMatchObject({ error: "no_course_material" });
	expect(providerCalls).toBe(0);
});
