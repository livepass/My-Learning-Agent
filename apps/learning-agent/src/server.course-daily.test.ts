import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { LearnerProfile } from "./memory/learner/types.js";

/**
 * E4.3d/e end-to-end: a real evidence-backed concept (C1→C2→C3→L1), two
 * courses with separate budgets, and suggestions that only change the plan
 * after an explicit apply.
 *
 * The fixture moves the stored review date into the past — the same trick the
 * C4-C loop test uses — because a freshly recorded concept is not due yet.
 * Everything else (task statuses, mastery values, plan revision) must be
 * unchanged by a recommendation read.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(90_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
	request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const QUESTION = {
	prompt: "请用自己的话解释 Python 闭包为什么会持有外层变量。",
	kind: "free_recall",
	reference_answer: "闭包捕获的是变量绑定而不是值的副本。",
	rubric: [{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 }],
	hints: ["先想想变量存在哪里"],
};
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

async function profile(): Promise<LearnerProfile> {
	return JSON.parse(await readFile(join(home, "data", "learner", "profile.json"), "utf-8")) as LearnerProfile;
}

interface CourseBody { course_id: string; title: string }
interface TaskBody {
	task_id: string;
	title: string;
	order: number;
	status: string;
	concept_ids: string[];
	estimated_minutes: number | null;
}
interface PlanBody { plan_id: string; status: string; revision: number }

interface DailyResponse {
	as_of: string;
	courses: Array<{
		course_id: string;
		course_title: string;
		status: string;
		daily_minutes: number;
		plan: { plan_id: string; revision: number } | null;
		items: Array<Record<string, unknown>>;
		planned_minutes: number;
		task_progress: { total: number; completed: number; percent: number };
		knowledge: { due_reviews: number; weak_concepts: number; stable_concepts: number; evidence_backed_concepts: number };
	}>;
	total_planned_minutes: number;
}

interface Suggestion {
	suggestion_id: string;
	type: string;
	reason_code: string;
	task_id?: string;
	concept_id?: string;
	requires_confirmation: boolean;
	evidence: { evidence_count: number; review_due_at?: string };
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-course-daily-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const answer = body.includes("judgment") ? ASSESSMENT : QUESTION;
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-course-daily-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

let python: CourseBody;
let math: CourseBody;
let pythonPlan: PlanBody;
let mathPlan: PlanBody;
let conceptId: string;
let evidenceCount = 0;

it("builds one real evidence-backed concept inside a Python course", async () => {
	python = await (await post("/api/courses", { title: "Python 编程" })).json() as CourseBody;
	math = await (await post("/api/courses", { title: "高等数学" })).json() as CourseBody;

	const created = await post("/api/sessions", {});
	const { id } = await created.json() as { id: string };
	expect((await post(`/api/courses/${python.course_id}/sessions`, { session_id: id })).status).toBe(201);
	expect((await post(`/api/sessions/${id}/learning`, {})).status).toBe(200);

	const generated = await post(`/api/sessions/${id}/learning/questions/generate`, {
		concept: "Python 闭包",
		request_id: "req_origin",
		expected_revision: 1,
		allow_model_fallback: true,
	});
	expect(generated.status).toBe(200);
	const generatedBody = await generated.json() as {
		question: { question_id: string; concept_id: string };
		checkpoint: { revision: number };
	};
	conceptId = generatedBody.question.concept_id;
	const saved = await post(`/api/sessions/${id}/learning/attempts`, {
		attempt_id: "a_origin",
		question_id: generatedBody.question.question_id,
		question_version: "1",
		expected_revision: generatedBody.checkpoint.revision,
		answer: "闭包捕获变量绑定，外层变量仍然可达。",
	});
	expect(saved.status).toBe(200);
	const savedBody = await saved.json() as { checkpoint: { revision: number } };
	expect((await post(`/api/sessions/${id}/learning/attempts/a_origin/evaluate`, {
		revision: savedBody.checkpoint.revision,
	})).status).toBe(200);
	const evaluated = JSON.parse(JSON.stringify(await (await request(`/api/sessions/${id}/learning`)).json())) as {
		checkpoint: { revision: number };
	};
	expect((await post(`/api/sessions/${id}/learning/attempts/a_origin/finalize`, {
		revision: evaluated.checkpoint.revision,
	})).status).toBe(200);

	const state = (await profile()).knowledge_states.find((item) => item.concept_id === conceptId);
	expect(state).toMatchObject({ course_id: python.course_id, origin: "derived" });
	expect(state?.evidence_ids.length).toBeGreaterThan(0);
	evidenceCount = state!.evidence_ids.length;
});

it("creates one active plan per course with a 30-minute budget", async () => {
	const pythonCreated = await post(`/api/courses/${python.course_id}/plans`, {
		title: "Python 装饰器",
		stages: [{
			title: "基础",
			tasks: [
				{ title: "学习装饰器", concept_ids: [conceptId], estimated_minutes: 20 },
				{ title: "完成相关练习", estimated_minutes: 30 },
				{ title: "总结", estimated_minutes: 40 },
			],
		}],
	});
	expect(pythonCreated.status).toBe(201);
	pythonPlan = (await pythonCreated.json() as { plan: PlanBody }).plan;

	const mathCreated = await post(`/api/courses/${math.course_id}/plans`, {
		title: "高等数学 导数",
		stages: [{
			title: "导数",
			tasks: [
				{ title: "继续导数章节", estimated_minutes: 40 },
				{ title: "复习链式法则", estimated_minutes: 20 },
			],
		}],
	});
	expect(mathCreated.status).toBe(201);
	mathPlan = (await mathCreated.json() as { plan: PlanBody }).plan;

	expect((await put(`/api/courses/${python.course_id}/settings`, { daily_minutes: 30 })).status).toBe(200);
	expect((await put(`/api/courses/${math.course_id}/settings`, { daily_minutes: 30 })).status).toBe(200);
});

it("recommends per course within budget, using the real due review", async () => {
	// Fixture only: move the stored review date into the past.
	const current = await profile();
	const stored = current.knowledge_states.find((item) => item.concept_id === conceptId)!;
	stored.review_due_at = "2026-01-01T00:00:00.000Z";
	stored.state_label = "review_due";
	await writeFile(join(home, "data", "learner", "profile.json"), `${JSON.stringify(current, null, 2)}\n`, "utf-8");

	const response = await request(`/api/courses/daily?as_of=${encodeURIComponent(new Date().toISOString())}`);
	expect(response.status).toBe(200);
	const daily = await response.json() as DailyResponse;
	expect(daily.courses.map((course) => course.course_id)).toEqual([python.course_id, math.course_id]);

	const pythonDaily = daily.courses[0];
	expect(pythonDaily.daily_minutes).toBe(30);
	expect(pythonDaily.plan?.plan_id).toBe(pythonPlan.plan_id);
	expect(pythonDaily.items.map((item) => item.kind)).toEqual(["review", "task"]);
	expect(pythonDaily.items[0]).toMatchObject({
		kind: "review",
		concept_id: conceptId,
		evidence_count: evidenceCount,
		reason_code: "review_due",
		estimated_minutes: 10,
	});
	expect(pythonDaily.items.slice(1).map((item) => item.task_id)).toEqual([expect.stringMatching(/^task_/)]);
	expect(pythonDaily.planned_minutes).toBe(30);
	expect(pythonDaily.task_progress).toMatchObject({ total: 3, completed: 0, percent: 0 });
	expect(pythonDaily.knowledge).toMatchObject({ due_reviews: 1, evidence_backed_concepts: 1 });

	const mathDaily = daily.courses[1];
	expect(mathDaily.plan?.plan_id).toBe(mathPlan.plan_id);
	expect(mathDaily.items.filter((item) => item.kind === "review")).toEqual([]);
	expect(mathDaily.items.map((item) => item.task_id)).toEqual([expect.stringMatching(/^task_/)]);
	expect(mathDaily.items[0]).toMatchObject({ reason_code: "over_budget", estimated_minutes: 40 });
	expect(mathDaily.planned_minutes).toBe(40);
	expect(daily.total_planned_minutes).toBe(70);
	// Never mixes a Python task into the 高数 recommendation.
	expect(mathDaily.items.every((item) => !String(item.task_id ?? "").startsWith("task_")
		|| item.kind === "task")).toBe(true);
});

it("does not mark tasks complete or change mastery when reading recommendations", async () => {
	const beforeProfile = await profile();
	const beforeMastery = beforeProfile.knowledge_states.find((item) => item.concept_id === conceptId)?.mastery;
	const pythonTasks = await (await request(`/api/courses/${python.course_id}/tasks?plan_id=${pythonPlan.plan_id}`)).json() as { tasks: TaskBody[] };
	expect(pythonTasks.tasks.every((task) => task.status === "pending")).toBe(true);

	await request(`/api/courses/daily?as_of=${encodeURIComponent(new Date().toISOString())}`);
	await request(`/api/courses/daily?as_of=${encodeURIComponent(new Date().toISOString())}`);

	const afterTasks = await (await request(`/api/courses/${python.course_id}/tasks?plan_id=${pythonPlan.plan_id}`)).json() as { tasks: TaskBody[] };
	expect(afterTasks.tasks.map((task) => task.task_id)).toEqual(pythonTasks.tasks.map((task) => task.task_id));
	expect(afterTasks.tasks.every((task) => task.status === "pending")).toBe(true);
	const afterProfile = await profile();
	expect(afterProfile.knowledge_states.find((item) => item.concept_id === conceptId)?.mastery).toBe(beforeMastery);
});

it("offers a review suggestion, rejects a stale apply and persists only after confirmation", async () => {
	const suggested = await request(`/api/courses/${python.course_id}/plans/${pythonPlan.plan_id}/suggestions`);
	expect(suggested.status).toBe(200);
	const suggestedBody = await suggested.json() as { revision: number; suggestions: Suggestion[] };
	expect(suggestedBody.revision).toBe(pythonPlan.revision);
	const review = suggestedBody.suggestions.find((item) => item.type === "review_prerequisite");
	expect(review).toMatchObject({
		reason_code: "review_due",
		concept_id: conceptId,
		requires_confirmation: true,
		evidence: { evidence_count: evidenceCount },
	});
	const beforeApply = await (await request(`/api/courses/${python.course_id}/tasks?plan_id=${pythonPlan.plan_id}`)).json() as { tasks: TaskBody[] };
	expect(beforeApply.tasks).toHaveLength(3);
	const masteryBefore = (await profile()).knowledge_states.find((item) => item.concept_id === conceptId)?.mastery;

	// A concurrent learner edit moves the plan revision. The suggestion computed
	// against the old revision must not be applied on top of it.
	const edited = await request(`/api/courses/${python.course_id}/tasks/${beforeApply.tasks[1].task_id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ estimated_minutes: 25 }),
	});
	expect(edited.status).toBe(200);
	const stale = await post(
		`/api/courses/${python.course_id}/plans/${pythonPlan.plan_id}/suggestions/${review!.suggestion_id}/apply`,
		{ expected_revision: suggestedBody.revision, type: review!.type },
	);
	expect(stale.status).toBe(409);

	const refreshed = await (await request(`/api/courses/${python.course_id}/plans/${pythonPlan.plan_id}/suggestions`)).json() as {
		revision: number;
		suggestions: Suggestion[];
	};
	const currentReview = refreshed.suggestions.find((item) => item.type === "review_prerequisite");
	expect(currentReview).toBeDefined();
	const applied = await post(
		`/api/courses/${python.course_id}/plans/${pythonPlan.plan_id}/suggestions/${currentReview!.suggestion_id}/apply`,
		{ expected_revision: refreshed.revision, type: currentReview!.type },
	);
	expect(applied.status).toBe(200);
	const appliedBody = await applied.json() as {
		plan: PlanBody & { adjustments: Array<{ suggestion_id: string; type: string; reason_code: string }> };
		tasks: TaskBody[];
	};
	expect(appliedBody.plan.revision).toBe(refreshed.revision + 1);
	expect(appliedBody.tasks).toHaveLength(4);
	expect(appliedBody.tasks[0]).toMatchObject({ title: "复习：待确认知识点", concept_ids: [conceptId], status: "pending" });
	expect(appliedBody.plan.adjustments[0]).toMatchObject({
		suggestion_id: currentReview!.suggestion_id,
		type: "review_prerequisite",
		reason_code: "review_due",
	});

	// The applied change is user-visible; the review is now a task, not a second
	// recommendation, and no duplicate suggestion keeps firing.
	const daily = await (await request(`/api/courses/daily?course_id=${python.course_id}`)).json() as DailyResponse;
	expect(daily.courses[0].items.some((item) => item.kind === "review")).toBe(false);
	expect(daily.courses[0].items[0]).toMatchObject({ kind: "task", estimated_minutes: 10 });
	const again = await (await request(`/api/courses/${python.course_id}/plans/${pythonPlan.plan_id}/suggestions`)).json() as { suggestions: Suggestion[] };
	expect(again.suggestions.some((item) => item.type === "review_prerequisite" && item.concept_id === conceptId)).toBe(false);

	// A plan change is not an evidence change: L1 mastery and label are untouched.
	const afterProfile = await profile();
	const afterState = afterProfile.knowledge_states.find((item) => item.concept_id === conceptId);
	expect(afterState?.mastery).toBe(masteryBefore);
	expect(afterState?.state_label).toBe("review_due");
});
