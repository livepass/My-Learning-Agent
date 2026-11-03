import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { recommendNextLearningActions } from "./learning/recommendations.js";
import type { LearnerProfile } from "./memory/learner/types.js";

/**
 * End-to-end C4-B: recommendations computed from a real L1 profile produced by
 * the real C2/C3 flow. A local deterministic provider is the only fake.
 *
 * The API must be a pure read: no new evidence, no checkpoint revision, no
 * model call, and the same profile at the same instant must yield the same list.
 */

let home: string;
let port: number;
let child: ChildProcess;
let provider: Server;
let providerCalls = 0;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown) =>
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
		if (child.exitCode !== null) throw new Error("C4-B server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* Startup is deliberately lazy. */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("C4-B server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
	child.kill();
	await exited;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-c4b-http-"));
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			providerCalls += 1;
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-c4b-http-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

type Snapshot = {
	as_of: string;
	generated_at: string;
	profile_version: number;
	projection?: { applied_seq: number; rule_version: number };
	recommendations: Array<{
		concept_id: string;
		concept_name?: string;
		name_available: boolean;
		action: string;
		reason_code: string;
		reason: string;
		evidence_basis: { evidence_count: number; provenance_limited: boolean };
	}>;
	status: string;
	empty_reason?: string;
	limit: number;
};

async function recommendations(limit?: number): Promise<Snapshot> {
	const response = await request(`/api/learner/recommendations${limit === undefined ? "" : `?limit=${limit}`}`);
	expect(response.status).toBe(200);
	return response.json() as Promise<Snapshot>;
}

async function profile(): Promise<LearnerProfile> {
	const response = await request("/api/learner/profile");
	expect(response.status).toBe(200);
	return response.json() as Promise<LearnerProfile>;
}

async function evidenceCount(): Promise<number> {
	const text = await readFile(join(home, "data", "learner", "events.jsonl"), "utf-8").catch(() => "");
	return text.split("\n").filter((line) => line.trim()).reduce((count, line) => {
		try {
			return (JSON.parse(line) as { evidence?: unknown }).evidence ? count + 1 : count;
		} catch {
			return count;
		}
	}, 0);
}

async function learningRevision(sessionId: string): Promise<number> {
	const response = await request(`/api/sessions/${sessionId}/learning`);
	expect(response.status).toBe(200);
	const body = await response.json() as { checkpoint: { revision: number } };
	return body.checkpoint.revision;
}

/** Assert the API is a faithful projection of the pure rules for this profile. */
async function expectMatchesRules(snapshot: Snapshot): Promise<void> {
	const current = await profile();
	const expected = recommendNextLearningActions(current, new Date(snapshot.as_of), { limit: 3 });
	expect(snapshot.recommendations).toEqual(expected);
}

/** Generate, answer, score and record one question; returns its concept id. */
async function completeOneQuestion(sessionId: string, requestId: string, conceptId?: string, afterAttemptId?: string): Promise<string> {
	const generated = await post(`/api/sessions/${sessionId}/learning/questions/generate`, {
		concept: "Python 闭包", request_id: requestId, expected_revision: await learningRevision(sessionId),
		allow_model_fallback: true, ...(conceptId ? { concept_id: conceptId } : {}),
		...(afterAttemptId ? { after_attempt_id: afterAttemptId } : {}),
	});
	const generatedBody = await generated.json() as Record<string, unknown>;
	expect(generated.status, JSON.stringify(generatedBody)).toBe(200);
	const body = generatedBody as unknown as {
		question: { question_id: string; concept_id: string };
		checkpoint: { revision: number };
	};
	const saved = await post(`/api/sessions/${sessionId}/learning/attempts`, {
		attempt_id: `a_${requestId}`,
		question_id: body.question.question_id,
		question_version: "1",
		expected_revision: body.checkpoint.revision,
		answer: "闭包捕获变量绑定，外层变量因此仍可达。",
	});
	expect(saved.status).toBe(200);
	const savedBody = await saved.json() as { checkpoint: { revision: number } };
	const evaluated = await post(`/api/sessions/${sessionId}/learning/attempts/a_${requestId}/evaluate`, {
		revision: savedBody.checkpoint.revision,
	});
	expect(evaluated.status).toBe(200);
	const evalBody = await evaluated.json() as { checkpoint: { revision: number } };
	const finalized = await post(`/api/sessions/${sessionId}/learning/attempts/a_${requestId}/finalize`, {
		revision: evalBody.checkpoint.revision,
	});
	expect(finalized.status).toBe(200);
	return body.question.concept_id;
}

it("recommends from the latest real L1 evidence without writing anything", async () => {
	const created = await post("/api/sessions", {});
	const { id } = await created.json() as { id: string };
	await post(`/api/sessions/${id}/learning`, {});

	// 1. No evidence yet: an explicit empty state, never fabricated advice.
	const empty = await recommendations();
	expect(empty.status).toBe("empty");
	expect(empty.empty_reason).toBe("no_knowledge_evidence");
	expect(empty.recommendations).toEqual([]);

	// 2. Complete question A through the real C2/C3 flow.
	const conceptId = await completeOneQuestion(id, "req_a");
	const afterA = await recommendations();
	expect(afterA.status).toBe("ok");
	expect(afterA.recommendations).toHaveLength(1);
	expect(afterA.recommendations[0].concept_id).toBe(conceptId);
	expect(afterA.recommendations[0].evidence_basis.evidence_count).toBeGreaterThanOrEqual(1);
	expect(afterA.profile_version).toBeGreaterThan(0);
	await expectMatchesRules(afterA);

	// 3. Reading is pure: no model call, no new evidence, no checkpoint change.
	const callsBefore = providerCalls;
	const evidenceBefore = await evidenceCount();
	const revisionBefore = await learningRevision(id);
	const secondRead = await recommendations();
	expect(secondRead.recommendations).toEqual(afterA.recommendations);
	expect(providerCalls).toBe(callsBefore);
	expect(await evidenceCount()).toBe(evidenceBefore);
	expect(await learningRevision(id)).toBe(revisionBefore);

	// 4. A second round on the same concept updates the basis, not the ledger.
	await completeOneQuestion(id, "req_b", conceptId, "a_req_a");
	const afterB = await recommendations();
	expect(afterB.status).toBe("ok");
	expect(afterB.recommendations).toHaveLength(1);
	expect(afterB.recommendations[0].concept_id).toBe(conceptId);
	expect(afterB.recommendations[0].evidence_basis.evidence_count).toBeGreaterThanOrEqual(2);
	await expectMatchesRules(afterB);
	expect(await evidenceCount()).toBe(evidenceBefore + 1);

	// 5. Restart: the same profile yields the same advice (only as_of changes).
	const callsAfterB = providerCalls;
	await stopServer();
	await startServer();
	const afterRestart = await recommendations();
	expect(afterRestart.recommendations).toEqual(afterB.recommendations);
	await expectMatchesRules(afterRestart);
	expect(providerCalls).toBe(callsAfterB);

	// 6. Limit is server-side and validated.
	const limited = await recommendations(1);
	expect(limited.recommendations).toHaveLength(1);
	expect(limited.limit).toBe(1);
	const invalid = await request("/api/learner/recommendations?limit=0");
	expect(invalid.status).toBe(400);

	// 7. Privacy: no answers, rubrics, reference answers or profile prose.
	const serialized = JSON.stringify(afterRestart);
	expect(serialized).not.toContain("闭包捕获的是变量绑定");
	expect(serialized).not.toContain("weight");
	expect(serialized).not.toContain("reference_answer");
	expect(serialized).not.toContain("闭包捕获变量绑定，外层变量因此仍可达");

	// 8. A damaged L1 profile is an explicit error, never a default list.
	await writeFile(join(home, "data", "learner", "profile.json"), "{not-json");
	const broken = await request("/api/learner/recommendations");
	expect(broken.status).toBe(503);
	const brokenBody = await broken.json() as Record<string, unknown>;
	expect(typeof brokenBody.error).toBe("string");
	expect(brokenBody.recommendations).toBeUndefined();
}, 300_000);
