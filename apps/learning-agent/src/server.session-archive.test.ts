import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * D1/D2: archive, restore and permanent delete over the real HTTP API, a real
 * B2 record, a real L1 profile and the real session files.
 *
 * What this file locks down:
 * - archive/unarchive validate the id, 404 on a missing session and are
 *   idempotent; no metadata is written for an imaginary session;
 * - an archived session with zero messages is still listed (its restore entry
 *   would otherwise disappear);
 * - archiving and restoring never touch chat/B2/L1 bytes, and a restart proves
 *   the question, attempt and evidence are still there;
 * - permanent delete removes the session and its B2 record, removes the archive
 *   entry, and leaves L1 evidence untouched;
 * - re-archiving a deleted session is a 404 instead of a ghost entry.
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown = {}) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
	child = spawn(process.execPath, [
		"--import", "tsx", resolve("apps/learning-agent/src/server.ts"),
		"--home", home,
		"--config-dir", join(home, "config"),
		"--data-dir", join(home, "data"),
		"--workspace", join(home, "workspace"),
		"--skills-dir", join(home, "skills"),
		"--port", String(port),
	], { cwd: process.cwd(), stdio: "ignore" });
	const deadline = Date.now() + 80_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("archive server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* Startup is deliberately lazy. */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("archive server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
	child.kill();
	await exited;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-archive-http-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const answer = JSON.stringify(body.includes("judgment") ? ASSESSMENT : QUESTION);
			res.write(`data: ${sseChunk(answer.slice(0, 60), null)}\n\n`);
			res.write(`data: ${sseChunk(answer.slice(60), null)}\n\n`);
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
		memory: { l1Enabled: true, l2Enabled: false, l3Enabled: false },
	}));
	await startServer();
}, 120_000);

afterAll(async () => {
	await stopServer();
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((yes) => provider.close(() => yes()));
	}
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-archive-http-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

async function createSession(): Promise<string> {
	const created = await post("/api/sessions");
	expect(created.status).toBe(201);
	return ((await created.json()) as { id: string }).id;
}

type SessionList = Array<{ id: string; archived?: boolean; messageCount: number }>;

async function listSessions(): Promise<SessionList> {
	const response = await request("/api/sessions");
	expect(response.status).toBe(200);
	return response.json() as Promise<SessionList>;
}

async function readText(path: string): Promise<string> {
	return readFile(path, "utf-8").catch(() => "");
}

async function evidenceCount(): Promise<number> {
	const text = await readText(join(home, "data", "learner", "events.jsonl"));
	return text.split("\n").filter((line) => line.trim()).reduce((count, line) => {
		try {
			return (JSON.parse(line) as { evidence?: unknown }).evidence ? count + 1 : count;
		} catch {
			return count;
		}
	}, 0);
}

it("validates archive and unarchive ids, is idempotent and never writes a ghost entry", async () => {
	const id = await createSession();

	expect((await post(`/api/sessions/${encodeURIComponent(id)}/archive`)).status).toBe(200);
	const archived = await listSessions();
	expect(archived.find((item) => item.id === id)).toMatchObject({ archived: true });

	// Repeating the same action is a no-op, not an error.
	const again = await post(`/api/sessions/${encodeURIComponent(id)}/archive`);
	expect(again.status).toBe(200);
	expect(((await again.json()) as { archived: boolean }).archived).toBe(true);

	expect((await post(`/api/sessions/${encodeURIComponent(id)}/unarchive`)).status).toBe(200);
	expect((await post(`/api/sessions/${encodeURIComponent(id)}/unarchive`)).status).toBe(200);
	expect((await listSessions()).find((item) => item.id === id)?.archived).toBe(false);

	// A missing session is 404 and leaves no archive metadata behind.
	const missing = await post("/api/sessions/does-not-exist.jsonl/archive");
	expect(missing.status).toBe(404);
	const archives = JSON.parse(await readText(join(home, "data", "sessions", "archives.json")) || "{}");
	expect(archives["does-not-exist.jsonl"]).toBeUndefined();
	expect((await post("/api/sessions/does-not-exist.jsonl/unarchive")).status).toBe(404);

	// A path-shaped id is refused before any store is touched.
	expect((await post("/api/sessions/bad%2Fid.jsonl/archive")).status).toBe(400);
	expect((await post("/api/sessions/bad%2Fid.jsonl/unarchive")).status).toBe(400);
});

it("brings a restored zero-message session back into the daily list", async () => {
	const older = await createSession();
	const newer = await createSession();
	expect(newer).not.toBe(older);

	// The older session has no chat messages and is no longer the current one;
	// a never-archived blank session stays hidden.
	const before = await listSessions();
	expect(before.find((item) => item.id === older)).toBeUndefined();

	expect((await post(`/api/sessions/${encodeURIComponent(older)}/archive`)).status).toBe(200);
	expect((await listSessions()).find((item) => item.id === older))
		.toMatchObject({ archived: true, messageCount: 0 });

	expect((await post(`/api/sessions/${encodeURIComponent(older)}/unarchive`)).status).toBe(200);
	const restored = await listSessions();
	expect(restored.find((item) => item.id === older)).toMatchObject({ archived: false, messageCount: 0 });

	// Archive → restore is repeatable in either direction.
	expect((await post(`/api/sessions/${encodeURIComponent(older)}/archive`)).status).toBe(200);
	expect((await listSessions()).find((item) => item.id === older)).toMatchObject({ archived: true });
	expect((await post(`/api/sessions/${encodeURIComponent(older)}/unarchive`)).status).toBe(200);
	expect((await listSessions()).find((item) => item.id === older)).toMatchObject({ archived: false });

	// The explicit restore survives a restart.
	await stopServer();
	await startServer();
	expect((await listSessions()).find((item) => item.id === older)).toMatchObject({ archived: false, messageCount: 0 });

	// Deleting a restored session removes its marker too (no lingering `false`).
	const deleted = await request(`/api/sessions/${encodeURIComponent(older)}`, { method: "DELETE" });
	expect(deleted.status).toBe(200);
	expect((await listSessions()).find((item) => item.id === older)).toBeUndefined();
	const archives = JSON.parse(await readText(join(home, "data", "sessions", "archives.json")) || "{}");
	expect(Object.prototype.hasOwnProperty.call(archives, older)).toBe(false);
}, 60_000);

it("archives and restores without touching chat, B2 or L1 bytes", async () => {
	const id = await createSession();
	expect((await post(`/api/sessions/${encodeURIComponent(id)}/learning`)).status).toBe(200);

	const generated = await post(`/api/sessions/${encodeURIComponent(id)}/learning/questions/generate`, {
		concept: "Python 闭包", request_id: "req_archive", expected_revision: 1, allow_model_fallback: true,
	});
	expect(generated.status).toBe(200);
	const generatedBody = await generated.json() as {
		question: { question_id: string; question_version: string };
		checkpoint: { revision: number };
	};
	const saved = await post(`/api/sessions/${encodeURIComponent(id)}/learning/attempts`, {
		attempt_id: "a_archive",
		question_id: generatedBody.question.question_id,
		question_version: generatedBody.question.question_version,
		expected_revision: generatedBody.checkpoint.revision,
		answer: "闭包捕获变量绑定，外层变量仍然可达。",
	});
	expect(saved.status).toBe(200);
	const savedBody = await saved.json() as { checkpoint: { revision: number } };
	const evaluated = await post(`/api/sessions/${encodeURIComponent(id)}/learning/attempts/a_archive/evaluate`, {
		revision: savedBody.checkpoint.revision,
	});
	expect(evaluated.status).toBe(200);
	const evaluatedBody = await evaluated.json() as { checkpoint: { revision: number } };
	const finalized = await post(`/api/sessions/${encodeURIComponent(id)}/learning/attempts/a_archive/finalize`, {
		revision: evaluatedBody.checkpoint.revision,
	});
	expect(finalized.status).toBe(200);

	const paths = {
		chat: join(home, "data", "sessions", id),
		b2: join(home, "data", "learning", `${id}.json`),
		profile: join(home, "data", "learner", "profile.json"),
		events: join(home, "data", "learner", "events.jsonl"),
	};
	const before = {
		chat: await readText(paths.chat),
		b2: await readText(paths.b2),
		profile: await readText(paths.profile),
		events: await readText(paths.events),
	};
	expect(before.chat.length).toBeGreaterThan(0);
	expect(before.b2.length).toBeGreaterThan(0);
	expect(await evidenceCount()).toBe(1);

	expect((await post(`/api/sessions/${encodeURIComponent(id)}/archive`)).status).toBe(200);
	const archived = {
		chat: await readText(paths.chat),
		b2: await readText(paths.b2),
		profile: await readText(paths.profile),
		events: await readText(paths.events),
	};
	expect(archived).toEqual(before);

	expect((await post(`/api/sessions/${encodeURIComponent(id)}/unarchive`)).status).toBe(200);
	const restored = {
		chat: await readText(paths.chat),
		b2: await readText(paths.b2),
		profile: await readText(paths.profile),
		events: await readText(paths.events),
	};
	expect(restored).toEqual(before);

	// Restart: the archived/restored round-trip changed nothing durable.
	await stopServer();
	await startServer();
	const learning = await request(`/api/sessions/${encodeURIComponent(id)}/learning`);
	expect(learning.status).toBe(200);
	const state = await learning.json() as {
		checkpoint: { step: string; last_completed_attempt_id?: string };
		attempts?: Array<{ attempt_id: string; answer: string }>;
	};
	expect(state.checkpoint.step).toBe("feedback");
	expect(state.checkpoint.last_completed_attempt_id).toBe("a_archive");
	expect(state.attempts?.find((item) => item.attempt_id === "a_archive")?.answer)
		.toBe("闭包捕获变量绑定，外层变量仍然可达。");
	expect(await evidenceCount()).toBe(1);

	// Permanent delete: the transcript and B2 record go, L1 evidence stays.
	const keeper = await createSession();
	expect(keeper).not.toBe(id);
	expect((await post(`/api/sessions/${encodeURIComponent(id)}/archive`)).status).toBe(200);
	const deleted = await request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
	expect(deleted.status).toBe(200);
	expect(existsSync(paths.chat)).toBe(false);
	expect(existsSync(paths.b2)).toBe(false);
	expect((await request(`/api/sessions/${encodeURIComponent(id)}/learning`)).status).toBe(404);
	expect(await evidenceCount()).toBe(1);
	expect(await readText(paths.profile)).toBe(before.profile);
	const archives = JSON.parse(await readText(join(home, "data", "sessions", "archives.json")) || "{}");
	expect(archives[id]).toBeUndefined();

	// A late archive of the deleted id is a 404 and cannot resurrect the entry.
	expect((await post(`/api/sessions/${encodeURIComponent(id)}/archive`)).status).toBe(404);
	const afterLateArchive = JSON.parse(await readText(join(home, "data", "sessions", "archives.json")) || "{}");
	expect(afterLateArchive[id]).toBeUndefined();
}, 240_000);
