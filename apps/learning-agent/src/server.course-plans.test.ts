import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDefaultProfile, type LearnerProfile } from "./memory/learner/types.js";

/**
 * E4.3a–c end-to-end: real server, real course state, real L2 passages, real
 * HTTP model. The only synthetic parts are the provider replies and the
 * fixture goal list.
 *
 * The provider builds its reply from the unit ids actually present in the
 * prompt, which is what lets the test prove that a Python plan cites Python
 * material and a 高数 plan cites 高数 material — and that a fabricated unit id
 * is rejected before anything is stored.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

type ProviderMode = "plan" | "invalid" | "fabricate";
let providerMode: ProviderMode = "plan";

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(90_000) });
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
	const isPython = prompt.includes("Python 编程");
	const topic = isPython ? "Python 装饰器" : "高等数学导数";
	return {
		title: isPython ? "Python 装饰器学习计划" : "高等数学导数学习计划",
		description: `围绕${topic}的三周安排。`,
		stages: [
			{
				title: "基础",
				objective: `理解${topic}的基本概念`,
				tasks: [
					{
						title: `阅读${topic}教材`,
						concept: topic,
						minutes: 25,
						...(unitIds[0] ? { unit_id: unitIds[0] } : {}),
						rationale: "先建立概念",
					},
					{
						title: `${topic}练习`,
						concept: `${topic}应用`,
						minutes: 35,
						...(unitIds[1] ?? unitIds[0] ? { unit_id: unitIds[1] ?? unitIds[0] } : {}),
					},
				],
			},
		],
		assumptions: ["每天能学习 45 分钟"],
		uncertainties: ["不清楚学习者对前置知识的掌握程度"],
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
interface PlanBody {
	plan_id: string;
	course_id: string;
	title: string;
	status: string;
	origin: string;
	revision: number;
	generation?: { basis: string; units: Array<{ source_id: string; page_path: string; excerpt: string }>; material_note: string };
}
interface TaskBody {
	task_id: string;
	title: string;
	order: number;
	stage_id: string | null;
	difficulty: string;
	estimated_minutes: number | null;
	source_ids: string[];
	source_refs?: Array<{ source_id: string; page_path: string; heading_path?: string }>;
}
interface PlanDetail { plan: PlanBody; stages: Array<{ stage_id: string; title: string; order: number }>; tasks: TaskBody[] }

function markdown(title: string, heading: string, body: string): string {
	return `# ${title}\n\n## ${heading}\n\n${body}${"补充说明。".repeat(120)}\n`;
}

const PYTHON_TEXT = markdown("Python 编程教材", "第三章 装饰器", "装饰器是接收函数并返回函数的高阶函数，可以在不修改原函数的情况下增加行为。");
const MATH_TEXT = markdown("高等数学教材", "第三章 导数", "导数描述函数在某一点的瞬时变化率，链式法则用于复合函数求导。");

async function upload(courseId: string, fileName: string, text: string) {
	return post(`/api/courses/${courseId}/sources/upload`, {
		fileName,
		mimeType: "text/markdown",
		title: fileName.replace(/\.md$/, ""),
		dataBase64: Buffer.from(text, "utf-8").toString("base64"),
	});
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-course-plans-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			if (providerMode === "invalid") {
				res.write(`data: ${sseChunk("这不是 JSON", null)}\n\n`);
				res.write(`data: ${sseChunk("", "stop")}\n\n`);
				res.end("data: [DONE]\n\n");
				return;
			}
			const prompt = body;
			const reply = providerMode === "fabricate"
				? {
					title: "伪造引用",
					description: "",
					stages: [{ title: "基础", tasks: [{ title: "编造章节", concept: "虚假知识点", minutes: 20, unit_id: "u99" }] }],
					assumptions: [],
					uncertainties: [],
				}
				: planReply(prompt);
			const json = JSON.stringify(reply);
			res.write(`data: ${sseChunk(json.slice(0, 80), null)}\n\n`);
			res.write(`data: ${sseChunk(json.slice(80), null)}\n\n`);
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
	await mkdir(join(home, "data", "learner"), { recursive: true });
	await writeFile(join(home, "config", "config.json"), JSON.stringify({
		providers: { fixture: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: "fixture", models: [{ id: "dummy" }] } },
		memory: { l1Enabled: true, l2Enabled: true, l3Enabled: false },
	}));
	// Goals live in L1; the course relates to them only through an explicit binding.
	const profile: LearnerProfile = createDefaultProfile("default");
	profile.goals = [
		{
			goal_id: "goal_python", title: "能独立写 Python 装饰器", type: "skill", priority: 1,
			status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-11-01T00:00:00.000Z",
		},
		{
			goal_id: "goal_math", title: "掌握高等数学导数与链式法则", type: "exam", priority: 1,
			status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-11-01T00:00:00.000Z",
		},
	];
	await writeFile(join(home, "data", "learner", "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
	await startServer();
}, 240_000);

afterAll(async () => {
	await stopServer();
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((yes) => provider.close(() => yes()));
	}
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-course-plans-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

let python: CourseBody;
let math: CourseBody;
let pythonSourceId: string;
let mathSourceId: string;
let pythonPlan: PlanDetail;
let mathPlan: PlanDetail;

it("creates two courses and ingests their own material", async () => {
	python = await (await post("/api/courses", { title: "Python 编程" })).json() as CourseBody;
	math = await (await post("/api/courses", { title: "高等数学" })).json() as CourseBody;
	expect((await post(`/api/courses/${python.course_id}/goals`, { goal_id: "goal_python" })).status).toBe(201);
	expect((await post(`/api/courses/${math.course_id}/goals`, { goal_id: "goal_math" })).status).toBe(201);

	const pythonUpload = await upload(python.course_id, "python.md", PYTHON_TEXT);
	expect(pythonUpload.status).toBe(201);
	pythonSourceId = (await pythonUpload.json() as { source_id: string }).source_id;
	const mathUpload = await upload(math.course_id, "math.md", MATH_TEXT);
	expect(mathUpload.status).toBe(201);
	mathSourceId = (await mathUpload.json() as { source_id: string }).source_id;
	expect((await put(`/api/courses/${python.course_id}/settings`, { daily_minutes: 45 })).status).toBe(200);
});

it("generates a Python draft grounded only in Python material", async () => {
	const response = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_python_1",
		daily_minutes: 45,
		target_date: "2026-12-31",
		foundation: "会写函数，没系统学过装饰器",
	});
	expect(response.status).toBe(201);
	pythonPlan = await response.json() as PlanDetail;
	expect(pythonPlan.plan).toMatchObject({ status: "draft", origin: "agent_suggested", revision: 1 });
	expect(pythonPlan.plan.generation?.basis).toBe("course_material");
	expect(pythonPlan.plan.generation?.units.length).toBeGreaterThan(0);
	expect(pythonPlan.plan.generation?.units.every((unit) => unit.source_id === pythonSourceId)).toBe(true);
	expect(pythonPlan.plan.generation?.material_note).toContain("未全部发送给模型");
	expect(pythonPlan.tasks.every((task) => task.source_ids.every((id) => id === pythonSourceId))).toBe(true);
	expect(pythonPlan.tasks.some((task) => task.source_refs?.[0]?.heading_path?.includes("装饰器"))).toBe(true);
	expect(pythonPlan.tasks.map((task) => task.order)).toEqual([0, 1]);
	expect(pythonPlan.plan.title).toContain("Python");
});

it("generates a 高等数学 draft without leaking Python material", async () => {
	providerMode = "plan";
	const response = await post(`/api/courses/${math.course_id}/plans/generate`, {
		request_id: "req_math_1",
	});
	expect(response.status).toBe(201);
	mathPlan = await response.json() as PlanDetail;
	expect(mathPlan.plan.title).toContain("高等数学");
	expect(mathPlan.plan.generation?.units.every((unit) => unit.source_id === mathSourceId)).toBe(true);
	expect(mathPlan.tasks.every((task) => !task.source_ids.includes(pythonSourceId))).toBe(true);
	expect(mathPlan.tasks.some((task) => task.source_refs?.[0]?.heading_path?.includes("导数"))).toBe(true);
});

it("keeps a generated plan in draft and refuses a status-patch bypass", async () => {
	const escalated = await patch(`/api/courses/${python.course_id}/plans/${pythonPlan.plan.plan_id}`, { status: "active" });
	expect(escalated.status).toBe(409);
	expect(await escalated.json()).toMatchObject({ error: "course_conflict" });
	const detail = await (await request(`/api/courses/${python.course_id}/plans/${pythonPlan.plan.plan_id}`)).json() as PlanDetail;
	expect(detail.plan.status).toBe("draft");
});

it("edits a draft and never overwrites that edit on a repeated generate", async () => {
	const edited = await put(`/api/courses/${python.course_id}/plans/${pythonPlan.plan.plan_id}/draft`, {
		expected_revision: 1,
		title: "我自己改过的 Python 计划",
		stages: [{
			stage_id: pythonPlan.stages[0].stage_id,
			title: "基础（我改的）",
			tasks: [
				{ task_id: pythonPlan.tasks[0].task_id, title: "先读装饰器" },
				{ title: "我加的任务", estimated_minutes: 15, difficulty: "basic" },
			],
		}],
	});
	expect(edited.status).toBe(200);
	const editedBody = await edited.json() as PlanDetail;
	expect(editedBody.plan).toMatchObject({ title: "我自己改过的 Python 计划", revision: 2 });
	expect(editedBody.tasks.map((task) => task.title)).toEqual(["先读装饰器", "我加的任务"]);

	// Same request id and same fingerprint both return the edited draft.
	const sameRequest = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_python_1",
		daily_minutes: 45,
		target_date: "2026-12-31",
		foundation: "会写函数，没系统学过装饰器",
	});
	expect(sameRequest.status).toBe(200);
	const sameBody = await sameRequest.json() as PlanDetail & { duplicate: boolean };
	expect(sameBody.duplicate).toBe(true);
	expect(sameBody.plan.plan_id).toBe(pythonPlan.plan.plan_id);
	expect(sameBody.plan.title).toBe("我自己改过的 Python 计划");
	expect(sameBody.tasks.map((task) => task.title)).toEqual(["先读装饰器", "我加的任务"]);

	const repeatFingerprint = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_python_retry",
		daily_minutes: 45,
		target_date: "2026-12-31",
		foundation: "会写函数，没系统学过装饰器",
	});
	expect(repeatFingerprint.status).toBe(200);
	expect((await repeatFingerprint.json() as { plan: PlanBody }).plan.plan_id).toBe(pythonPlan.plan.plan_id);
	const plans = await (await request(`/api/courses/${python.course_id}/plans`)).json() as { plans: PlanBody[] };
	expect(plans.plans).toHaveLength(1);
});

it("leaves no partial plan when the model returns an invalid plan", async () => {
	const before = await (await request(`/api/courses/${math.course_id}/plans`)).json() as { plans: PlanBody[] };
	providerMode = "invalid";
	const failed = await post(`/api/courses/${math.course_id}/plans/generate`, { request_id: "req_invalid", force: true });
	expect(failed.status).toBe(422);
	expect(await failed.json()).toMatchObject({ error: "invalid_output" });
	providerMode = "fabricate";
	const fabricated = await post(`/api/courses/${math.course_id}/plans/generate`, { request_id: "req_fabricated", force: true });
	expect(fabricated.status).toBe(422);
	expect(await fabricated.json()).toMatchObject({ error: "invalid_output" });
	providerMode = "plan";
	const after = await (await request(`/api/courses/${math.course_id}/plans`)).json() as { plans: PlanBody[] };
	expect(after.plans.map((plan) => plan.plan_id)).toEqual(before.plans.map((plan) => plan.plan_id));
});

it("states the basis explicitly when a course has no material", async () => {
	const empty = await (await post("/api/courses", { title: "空课程" })).json() as CourseBody;
	const refused = await post(`/api/courses/${empty.course_id}/plans/generate`, { request_id: "req_empty_1" });
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({ error: "no_course_material" });

	const general = await post(`/api/courses/${empty.course_id}/plans/generate`, {
		request_id: "req_empty_2",
		basis: "model_knowledge",
	});
	expect(general.status).toBe(201);
	const body = await general.json() as PlanDetail;
	expect(body.plan.generation?.basis).toBe("model_knowledge");
	expect(body.plan.generation?.units).toEqual([]);
	expect(body.plan.generation?.material_note).toContain("未使用课程教材");
	expect(body.tasks.every((task) => task.source_ids.length === 0 && !task.source_refs)).toBe(true);
});

it("creates a manual plan atomically and lets the learner edit its tasks", async () => {
	const created = await post(`/api/courses/${python.course_id}/plans`, {
		title: "手动计划",
		status: "draft",
		stages: [{ title: "第一阶段", tasks: [{ title: "手写闭包" }, { title: "手写装饰器", estimated_minutes: 30 }] }],
	});
	expect(created.status).toBe(201);
	const body = await created.json() as PlanDetail;
	expect(body.tasks.map((task) => task.order)).toEqual([0, 1]);
	expect(body.tasks[1]).toMatchObject({ estimated_minutes: 30, difficulty: "standard", status: "pending" });

	const reordered = await post(`/api/courses/${python.course_id}/plans/${body.plan.plan_id}/tasks/reorder`, {
		expected_revision: 1,
		task_ids: [body.tasks[1].task_id, body.tasks[0].task_id],
	});
	expect(reordered.status).toBe(200);
	const reorderedBody = await reordered.json() as { tasks: TaskBody[] };
	expect(reorderedBody.tasks.map((task) => task.title)).toEqual(["手写装饰器", "手写闭包"]);

	const added = await post(`/api/courses/${python.course_id}/tasks`, {
		title: "自己补的练习",
		plan_id: body.plan.plan_id,
		estimated_minutes: 10,
		difficulty: "basic",
	});
	expect(added.status).toBe(201);
	const addedBody = await added.json() as TaskBody;
	expect(addedBody.order).toBe(2);
	const deleted = await request(`/api/courses/${python.course_id}/tasks/${addedBody.task_id}`, { method: "DELETE" });
	expect(deleted.status).toBe(200);
});

it("confirms a draft, protects the active plan and keeps it across a restart", async () => {
	const confirmed = await post(`/api/courses/${python.course_id}/plans/${pythonPlan.plan.plan_id}/confirm`, {
		expected_revision: 2,
	});
	expect(confirmed.status).toBe(200);
	const confirmedBody = await confirmed.json() as { plan: PlanBody; alreadyActive: boolean };
	expect(confirmedBody.plan.status).toBe("active");
	expect(confirmedBody.alreadyActive).toBe(false);

	// A new generation must not delete or overwrite the confirmed plan.
	const newDraft = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_python_2",
		force: true,
	});
	expect(newDraft.status).toBe(201);
	const newDraftBody = await newDraft.json() as PlanDetail;
	expect(newDraftBody.plan.plan_id).not.toBe(pythonPlan.plan.plan_id);
	expect(newDraftBody.plan.status).toBe("draft");
	const active = await (await request(`/api/courses/${python.course_id}/plans/${pythonPlan.plan.plan_id}`)).json() as PlanDetail;
	expect(active.plan.status).toBe("active");
	expect(active.tasks).toHaveLength(2);

	// A second draft cannot silently replace it.
	const blocked = await post(`/api/courses/${python.course_id}/plans/${newDraftBody.plan.plan_id}/confirm`, {
		expected_revision: 1,
	});
	expect(blocked.status).toBe(409);

	await stopServer();
	await startServer();
	const restored = await (await request(`/api/courses/${python.course_id}/plans/${pythonPlan.plan.plan_id}`)).json() as PlanDetail;
	expect(restored.plan).toMatchObject({ status: "active", revision: 3, title: "我自己改过的 Python 计划" });
	expect(restored.stages[0].title).toBe("基础（我改的）");
	expect(restored.tasks.map((task) => [task.title, task.order])).toEqual([["先读装饰器", 0], ["我加的任务", 1]]);
	const mathRestored = await (await request(`/api/courses/${math.course_id}/plans/${mathPlan.plan.plan_id}`)).json() as PlanDetail;
	expect(mathRestored.plan.status).toBe("draft");
	expect(mathRestored.tasks.every((task) => task.source_ids.every((id) => id === mathSourceId))).toBe(true);
});

it("still reads a legacy course task that has none of the new fields", async () => {
	const legacy = await (await post("/api/courses", { title: "旧课程" })).json() as CourseBody;
	const task = await (await post(`/api/courses/${legacy.course_id}/tasks`, { title: "旧任务" })).json() as TaskBody;
	expect(task).toMatchObject({ order: 0, difficulty: "standard", estimated_minutes: null, stage_id: null });
	const tasks = await (await request(`/api/courses/${legacy.course_id}/tasks`)).json() as { tasks: TaskBody[] };
	expect(tasks.tasks.map((entry) => entry.title)).toEqual(["旧任务"]);
});

it("still supports a manual plan when the model endpoint is unreachable", async () => {
	await stopServer();
	const current = JSON.parse(await readFile(join(home, "config", "config.json"), "utf-8")) as Record<string, unknown>;
	await writeFile(join(home, "config", "config.json"), JSON.stringify({
		...current,
		providers: { fixture: { baseUrl: "http://127.0.0.1:9", apiKey: "fixture", models: [{ id: "dummy" }] } },
	}), "utf-8");
	await startServer();
	const failed = await post(`/api/courses/${python.course_id}/plans/generate`, {
		request_id: "req_disconnected",
		basis: "model_knowledge",
	});
	expect([502, 503]).toContain(failed.status);
	const manual = await post(`/api/courses/${math.course_id}/plans`, {
		title: "断网也能用的手写计划",
		stages: [{ title: "基础", tasks: [{ title: "读导数定义" }] }],
	});
	expect(manual.status).toBe(201);
	expect((await manual.json() as { plan: PlanBody }).plan.title).toBe("断网也能用的手写计划");
});
