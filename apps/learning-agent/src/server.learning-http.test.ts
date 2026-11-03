import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end HTTP integration for the learning-checkpoint API (B2).
 *
 * Exercises the 10 acceptance steps against a real server child process:
 * session + record creation, a trusted-layer saved question + awaiting_answer
 * checkpoint, public-state reads, process restart recovery, pause/resume,
 * stale-revision conflicts, projection repair, and deletion cleanup.
 */

// Real server child process + process restart: the default 5s is far too tight.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let home: string, port: number, child: ChildProcess, provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(45_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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

const question = {
	question_id: "q1", question_version: "1", concept_id: "concepts.closures", goal_id: "goal-1",
	prompt: "什么是闭包？", kind: "free_recall", rubric_version: "rubric-1",
	rubric: [{ criterion_id: "definition", description: "函数 + 词法作用域", weight: 1 }],
	hints: ["提示：作用域链"], reference_answer: "闭包是函数与其词法作用域的组合",
};

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-learning-e2e-"));
	provider = createServer((req, res) => {
		req.resume();
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
	await writeFile(join(home, "config", "config.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: "fixture", models: [{ id: "dummy" }] } }, memory: { l1Enabled: true, l2Enabled: false, l3Enabled: false } }));
	await startServer();
}, 90_000);

afterAll(async () => {
	await stopServer();
	if (provider) { provider.closeAllConnections(); await new Promise<void>((yes) => provider.close(() => yes())); }
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-learning-e2e-")) await rm(home, { recursive: true, force: true });
}, 15_000);

describe("learning checkpoint HTTP API", () => {
	it("creates a session, initialises its record, and reads a public state", async () => {
		const created = await post("/api/sessions", {});
		expect(created.status).toBe(201);
		const { id } = await created.json() as { id: string };

		const init = await post(`/api/sessions/${id}/learning`, {});
		expect(init.status).toBe(200);
		const initBody = await init.json() as { checkpoint: { revision: number; status: string; step: string } };
		expect(initBody.checkpoint.revision).toBe(1);
		expect(initBody.checkpoint.step).toBe("conversation");

		// Idempotent re-init.
		const again = await post(`/api/sessions/${id}/learning`, { goalId: "g" });
		expect((await again.json() as { checkpoint: { revision: number } }).checkpoint.revision).toBe(1);

		const got = await request(`/api/sessions/${id}/learning`);
		expect(got.status).toBe(200);
		const state = await got.json() as { exists: boolean; checkpoint: { revision: number } };
		expect(state.exists).toBe(true);
		expect(state.checkpoint.revision).toBe(1);
	});

	it("persists the first auto-generated title for a brand-new session", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };

		// One chat turn gives the auto-title task its >=2 messages.
		const chat = await post("/api/chat", { sessionId: id, prompt: "帮我理解闭包" });
		expect(chat.status).toBe(200);

		// The title task is fire-and-forget; poll for the observable result instead
		// of sleeping a fixed amount.
		const deadline = Date.now() + 45_000;
		let entry: { topic?: string; generated?: boolean } | undefined;
		while (Date.now() < deadline) {
			const meta = JSON.parse(await readFile(join(home, "data", "sessions", "meta.json"), "utf-8")) as Record<string, { topic?: string; generated?: boolean }>;
			entry = meta[id];
			if (entry?.topic) break;
			await new Promise((yes) => setTimeout(yes, 200));
		}
		// A brand-new session must get a persisted first title (the defect was that
		// setAutoTopic refused to create a missing entry).
		expect(entry?.topic).toBeTruthy();
		expect(entry?.generated).toBe(true);
	}, 90_000);

	it("persists the first auto title after the learning record was initialised first", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };

		// Initialise the learning record BEFORE any title exists: this creates a
		// metadata entry that only carries the `learning` projection. That must not
		// be mistaken for "the session already has a title".
		const init = await post(`/api/sessions/${id}/learning`, {});
		expect(init.status).toBe(200);

		const chat = await post("/api/chat", { sessionId: id, prompt: "讲讲闭包" });
		expect(chat.status).toBe(200);

		const deadline = Date.now() + 45_000;
		let entry: { topic?: string; generated?: boolean; learning?: { revision?: number } } | undefined;
		while (Date.now() < deadline) {
			const meta = JSON.parse(await readFile(join(home, "data", "sessions", "meta.json"), "utf-8")) as Record<string, { topic?: string; generated?: boolean; learning?: { revision?: number } }>;
			entry = meta[id];
			if (entry?.topic) break;
			await new Promise((yes) => setTimeout(yes, 200));
		}
		expect(entry?.topic).toBeTruthy();
		expect(entry?.generated).toBe(true);
		// The projection the learning record wrote first must survive the title.
		expect(entry?.learning?.revision).toBe(1);
	}, 90_000);

	it("rejects illegal session ids on DELETE without touching any other session", async () => {
		// Two real sessions with learning records, so a leak would be observable.
		const a = await post("/api/sessions", {});
		const target = (await a.json() as { id: string }).id;
		const b = await post("/api/sessions", {});
		const other = (await b.json() as { id: string }).id;
		await post(`/api/sessions/${target}/learning`, {});
		await post(`/api/sessions/${other}/learning`, {});

		const targetPath = join(home, "data", "sessions", target);
		const recordPath = join(home, "data", "learning", `${target}.json`);
		const beforeRecord = await readFile(recordPath, "utf-8");
		const beforeMeta = JSON.parse(await readFile(join(home, "data", "sessions", "meta.json"), "utf-8")) as Record<string, unknown>;
		const beforeTargetEntry = JSON.stringify(beforeMeta[target]);
		const beforeOtherEntry = JSON.stringify(beforeMeta[other]);

		const base = target.replace(/\.jsonl$/, "");
		const illegal = [
			`%2F${target}`,                    // URL-encoded "/"
			`%5C${target}`,                    // URL-encoded "\"
			`..%2F${target}`,                  // traversal
			`%252F${target}`,                  // double-encoded "/"
			`${base}.txt`,                     // wrong extension
		];

		for (const raw of illegal) {
			const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${raw}`, {
				method: "DELETE", signal: AbortSignal.timeout(30_000),
			});
			expect(response.status, `illegal id ${raw}`).toBe(400);

			// Original session untouched: chat file, learning record, meta entry.
			expect(existsSync(targetPath), `chat file after ${raw}`).toBe(true);
			expect(await readFile(recordPath, "utf-8")).toBe(beforeRecord);
			const meta = JSON.parse(await readFile(join(home, "data", "sessions", "meta.json"), "utf-8")) as Record<string, unknown>;
			expect(JSON.stringify(meta[target])).toBe(beforeTargetEntry);
			// Another session is unaffected too.
			expect(JSON.stringify(meta[other])).toBe(beforeOtherEntry);
		}

		// A valid but unknown id is still 404, and the legal delete still works.
		expect((await fetch(`http://127.0.0.1:${port}/api/sessions/does-not-exist.jsonl`, { method: "DELETE", signal: AbortSignal.timeout(30_000) })).status).toBe(404);
		const legal = await fetch(`http://127.0.0.1:${port}/api/sessions/${target}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
		expect(legal.status).toBe(200);
	}, 120_000);

	it("recovers a saved question and awaiting-answer checkpoint, exposing only public material", async () => {
		// Create a session, then write the authoritative record directly to model
		// the "trusted service layer" having saved a question + awaiting_answer
		// checkpoint + a pending answer_saved attempt.
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };
		await post(`/api/sessions/${id}/learning`, {});

		const record = {
			schema_version: 1,
			checkpoint: {
				schema_version: 1, session_id: id, revision: 2, status: "active", step: "awaiting_answer",
				question: { question_id: "q1", question_version: "1" }, pending_attempt_id: "a1",
				exposure_sequence: 0, updated_at: "2026-11-02T00:00:00.000Z",
			},
			questions: [question],
			exposures: [],
			attempts: [{
				session_id: id, attempt_id: "a1", question_id: "q1", question_version: "1",
				answer: "秘密答案", accepted_at: "2026-11-02T00:00:00.000Z", accepted_revision: 2,
				question, hints: { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
				evaluation_attempts: 0, progress: { stage: "answer_saved" },
			}],
		};
		await mkdir(join(home, "data", "learning"), { recursive: true });
		await writeFile(join(home, "data", "learning", `${id}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");

		const got = await request(`/api/sessions/${id}/learning`);
		expect(got.status).toBe(200);
		const body = await got.json() as { exists: boolean; checkpoint: { revision: number; step: string; question?: { question_id: string; question_version: string } }; questions: unknown[]; attempts?: Array<{ answer: string }>; pending_action?: string };
		expect(body.exists).toBe(true);
		expect(body.checkpoint.revision).toBe(2);
		expect(body.checkpoint.step).toBe("awaiting_answer");
		// The client must know which question is being answered.
		expect(body.checkpoint.question).toEqual({ question_id: "q1", question_version: "1" });
		expect(body.pending_action).toBe("evaluate");
		// The learner's own answer is recoverable (P1-1); the private scoring
		// material (reference answer, rubric, hints) never leaks.
		expect(body.attempts?.[0].answer).toBe("秘密答案");
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("reference_answer");
		expect(raw).not.toContain("rubric");
		expect(raw).not.toContain("hints");
		expect(raw).toContain("什么是闭包？");
	});

	it("pauses and resumes with revision conflict detection", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };
		await post(`/api/sessions/${id}/learning`, {});

		const paused = await post(`/api/sessions/${id}/learning/pause`, { revision: 1 });
		expect(paused.status).toBe(200);
		expect((await paused.json() as { checkpoint: { status: string } }).checkpoint.status).toBe("paused");

		// Stale revision (still 1, now 2) must conflict.
		const stale = await post(`/api/sessions/${id}/learning/resume`, { revision: 1 });
		expect(stale.status).toBe(409);

		const resumed = await post(`/api/sessions/${id}/learning/resume`, { revision: 2 });
		expect(resumed.status).toBe(200);
		expect((await resumed.json() as { checkpoint: { status: string } }).checkpoint.status).toBe("active");
	});

	it("returns 404 for a missing session and 400 for a bad revision", async () => {
		expect((await request("/api/sessions/missing.jsonl/learning")).status).toBe(404);
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };
		await post(`/api/sessions/${id}/learning`, {});
		expect((await post(`/api/sessions/${id}/learning/pause`, { revision: "x" })).status).toBe(400);
		expect((await post(`/api/sessions/${id}/learning/pause`, {})).status).toBe(400);
	});

	it("pause/resume without a learning record return 404 instead of creating one", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };

		// No learning record initialised yet.
		const paused = await post(`/api/sessions/${id}/learning/pause`, { revision: 1 });
		expect(paused.status).toBe(404);
		const resumed = await post(`/api/sessions/${id}/learning/resume`, { revision: 1 });
		expect(resumed.status).toBe(404);

		// Neither call may have created a record as a side effect.
		const state = await request(`/api/sessions/${id}/learning`);
		expect((await state.json() as { exists: boolean }).exists).toBe(false);
	});

	it("pause and resume are idempotent over HTTP", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };
		await post(`/api/sessions/${id}/learning`, {});

		const once = await post(`/api/sessions/${id}/learning/pause`, { revision: 1 });
		const onceBody = await once.json() as { checkpoint: { revision: number; status: string } };
		expect(onceBody.checkpoint.revision).toBe(2);

		// Repeat pause: same revision, still paused.
		const twice = await post(`/api/sessions/${id}/learning/pause`, { revision: 2 });
		const twiceBody = await twice.json() as { checkpoint: { revision: number; status: string } };
		expect(twiceBody.checkpoint.revision).toBe(2);
		expect(twiceBody.checkpoint.status).toBe("paused");

		const resumed = await post(`/api/sessions/${id}/learning/resume`, { revision: 2 });
		expect((await resumed.json() as { checkpoint: { revision: number } }).checkpoint.revision).toBe(3);
	});

	it("cleans up a session whose learning record read fails, without reporting success", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };
		await post(`/api/sessions/${id}/learning`, {});

		// Inject an IO fault: make the record path unreadable by replacing the
		// file with a directory. Cleanup must fail loudly, not report deleted:true.
		const recordPath = join(home, "data", "learning", `${id}.json`);
		await rm(recordPath, { force: true });
		await mkdir(recordPath, { recursive: true });

		const del = await request(`/api/sessions/${id}`, { method: "DELETE" });
		expect(del.status).toBe(500);
		const body = await del.json() as { error: string; deleted: boolean; retryable: boolean };
		expect(body.error).toBe("session_cleanup_failed");
		expect(body.deleted).toBe(false);
		expect(body.retryable).toBe(true);

		// Repair the fault; a retry (chat file already gone) must converge.
		await rm(recordPath, { recursive: true, force: true });
		const retry = await request(`/api/sessions/${id}`, { method: "DELETE" });
		expect(retry.status).toBe(200);
	});

	it("repairs a stale projection and survives a process restart", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };
		await post(`/api/sessions/${id}/learning`, { goalId: "goal-1" });

		// Simulate "authority written, projection not updated": overwrite the
		// authoritative record with a newer revision while meta.json still shows 1.
		await mkdir(join(home, "data", "learning"), { recursive: true });
		await writeFile(join(home, "data", "learning", `${id}.json`), JSON.stringify({
			schema_version: 1,
			checkpoint: { schema_version: 1, session_id: id, revision: 5, status: "active", step: "conversation", goal_id: "goal-1", exposure_sequence: 0, updated_at: "2026-11-02T00:00:00.000Z" },
			questions: [], exposures: [], attempts: [],
		}, null, 2) + "\n", "utf-8");

		// Restart the server to prove recovery from the authoritative record.
		await stopServer();
		await startServer();

		const got = await request(`/api/sessions/${id}/learning`);
		expect(got.status).toBe(200);
		const state = await got.json() as { exists: boolean; checkpoint: { revision: number } };
		expect(state.exists).toBe(true);
		expect(state.checkpoint.revision).toBe(5);

		// The projection was repaired in meta.json.
		const meta = JSON.parse(await readFile(join(home, "data", "sessions", "meta.json"), "utf-8")) as Record<string, { learning?: { revision: number } }>;
		expect(meta[id].learning?.revision).toBe(5);
	}, 120_000);

	it("deletes a session and clears both the record and its projection", async () => {
		const created = await post("/api/sessions", {});
		const { id } = await created.json() as { id: string };
		await post(`/api/sessions/${id}/learning`, {});

		const del = await request(`/api/sessions/${id}`, { method: "DELETE" });
		expect(del.status).toBe(200);

		// The authoritative record is gone and meta.json has no entry.
		await expect(readFile(join(home, "data", "learning", `${id}.json`), "utf-8")).rejects.toThrow();
		const meta = JSON.parse(await readFile(join(home, "data", "sessions", "meta.json"), "utf-8")) as Record<string, unknown>;
		expect(meta[id]).toBeUndefined();

		// The learning read now reports not-found (session itself is gone).
		expect((await request(`/api/sessions/${id}/learning`)).status).toBe(404);
	});
});
