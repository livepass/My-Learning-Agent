import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { recommendNextLearningActions } from "./learning/recommendations.js";
import type { LearnerProfile } from "./memory/learner/types.js";

/**
 * End-to-end C4-C: due review → review question → C2 score → C3 evidence → L1
 * re-read → restart/replay. Real server, real B2/L1 files, deterministic local
 * provider. The only synthetic part is the due date, moved into the past in the
 * fixture so a freshly recorded concept is actually due.
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
		if (child.exitCode !== null) throw new Error("C4-C server exited before readiness");
		try {
			if ((await request("/health")).ok) return;
		} catch { /* Startup is deliberately lazy. */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("C4-C server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
	child.kill();
	await exited;
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-c4c-http-"));
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
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-c4c-http-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 20_000);

type LearningView = {
	checkpoint: {
		revision: number;
		step: string;
		question?: { question_id: string; question_version: string };
		last_completed_attempt_id?: string;
	};
	questions: Array<{ question_id: string; concept_id: string; kind: string }>;
	attempts?: Array<{ attempt_id: string; stage: string; answer: string }>;
};

type RecommendationSnapshot = {
	as_of: string;
	concept_id?: string;
	recommendations: Array<{
		concept_id: string;
		action: string;
		reason_code: string;
		also_matches: string[];
		evidence_basis: { review_due_at?: string; evidence_count: number };
	}>;
};

async function learning(id: string): Promise<LearningView> {
	const response = await request(`/api/sessions/${id}/learning`);
	expect(response.status).toBe(200);
	return response.json() as Promise<LearningView>;
}

async function profile(): Promise<LearnerProfile> {
	const response = await request("/api/learner/profile");
	expect(response.status).toBe(200);
	return response.json() as Promise<LearnerProfile>;
}

async function recommendations(conceptId: string): Promise<RecommendationSnapshot> {
	const response = await request(`/api/learner/recommendations?concept_id=${encodeURIComponent(conceptId)}`);
	expect(response.status).toBe(200);
	return response.json() as Promise<RecommendationSnapshot>;
}

async function latestEvidence(): Promise<{ concept_id?: string; learning_attempt?: { attempt_id?: string } } | undefined> {
	const text = await readFile(join(home, "data", "learner", "events.jsonl"), "utf-8").catch(() => "");
	const events = text.split("\n").filter((line) => line.trim()).map((line) => {
		try {
			return JSON.parse(line) as { evidence?: { concept_id?: string; learning_attempt?: { attempt_id?: string } } };
		} catch {
			return {};
		}
	});
	return events.filter((event) => event.evidence).at(-1)?.evidence;
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

/** Move one concept's stored review date into the past (fixture setup only). */
async function makeDue(conceptId: string): Promise<void> {
	const path = join(home, "data", "learner", "profile.json");
	const current = JSON.parse(await readFile(path, "utf-8")) as LearnerProfile;
	const state = current.knowledge_states.find((item) => item.concept_id === conceptId);
	expect(state, "concept state must exist before editing").toBeDefined();
	state!.review_due_at = "2026-01-01T00:00:00.000Z";
	state!.state_label = "review_due";
	await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
}

it("completes a due review through the real C2/C3 path and updates L1 exactly once", async () => {
	const created = await post("/api/sessions", {});
	const { id } = await created.json() as { id: string };
	await post(`/api/sessions/${id}/learning`, {});

	// 1. Build a real evidence-backed concept through the normal flow.
	const generated = await post(`/api/sessions/${id}/learning/questions/generate`, {
		concept: "Python 闭包", request_id: "req_origin", expected_revision: 1, allow_model_fallback: true,
	});
	expect(generated.status).toBe(200);
	const originBody = await generated.json() as {
		question: { question_id: string; concept_id: string };
		checkpoint: { revision: number };
	};
	const conceptId = originBody.question.concept_id;
	const saved = await post(`/api/sessions/${id}/learning/attempts`, {
		attempt_id: "a_origin", question_id: originBody.question.question_id, question_version: "1",
		expected_revision: originBody.checkpoint.revision, answer: "闭包捕获变量绑定，外层变量仍可达。",
	});
	expect(saved.status).toBe(200);
	const savedBody = await saved.json() as { checkpoint: { revision: number } };
	const evaluated = await post(`/api/sessions/${id}/learning/attempts/a_origin/evaluate`, {
		revision: savedBody.checkpoint.revision,
	});
	expect(evaluated.status).toBe(200);
	const evaluatedBody = await evaluated.json() as { checkpoint: { revision: number } };
	const finalized = await post(`/api/sessions/${id}/learning/attempts/a_origin/finalize`, {
		revision: evaluatedBody.checkpoint.revision,
	});
	expect(finalized.status).toBe(200);
	const evidenceAfterOrigin = await evidenceCount();
	expect(evidenceAfterOrigin).toBe(1);

	// 2. Fixture: make the stored review time due, then confirm L1 sees it.
	await makeDue(conceptId);
	const dueProfile = await profile();
	const dueState = dueProfile.knowledge_states.find((item) => item.concept_id === conceptId)!;
	expect(Date.parse(dueState.review_due_at!)).toBeLessThan(Date.now());
	const dueAdvice = await recommendations(conceptId);
	expect(dueAdvice.concept_id).toBe(conceptId);
	expect(dueAdvice.recommendations[0]).toMatchObject({ action: "review", reason_code: "review_due" });

	// 3. Generate the review question in the feedback session, bound to A.
	const beforeReview = await learning(id);
	expect(beforeReview.checkpoint.step).toBe("feedback");
	const reviewPayload = {
		concept: "Python 闭包",
		concept_id: conceptId,
		kind: "free_recall",
		request_id: "req_review",
		expected_revision: beforeReview.checkpoint.revision,
		allow_model_fallback: true,
		after_attempt_id: "a_origin",
	};
	const reviewGenerated = await post(`/api/sessions/${id}/learning/questions/generate`, reviewPayload);
	expect(reviewGenerated.status).toBe(200);
	const reviewBody = await reviewGenerated.json() as {
		created: boolean;
		question: { question_id: string; concept_id: string; kind: string };
		checkpoint: { revision: number; step: string };
	};
	expect(reviewBody.created).toBe(true);
	expect(reviewBody.question.concept_id).toBe(conceptId);
	expect(reviewBody.question.kind).toBe("free_recall");
	expect(reviewBody.checkpoint).toMatchObject({ step: "awaiting_answer" });

	// 4. A second request while the review question waits is refused, not overwritten.
	const blocked = await post(`/api/sessions/${id}/learning/questions/generate`, {
		...reviewPayload, request_id: "req_other",
	});
	expect(blocked.status).toBe(409);

	// 5. Same request id replays the same question with no second commit.
	const replayQuestion = await post(`/api/sessions/${id}/learning/questions/generate`, reviewPayload);
	expect(replayQuestion.status).toBe(200);
	const replayQuestionBody = await replayQuestion.json() as { created: boolean; question: { question_id: string } };
	expect(replayQuestionBody.created).toBe(false);
	expect(replayQuestionBody.question.question_id).toBe(reviewBody.question.question_id);
	expect((await learning(id)).questions).toHaveLength(2);

	// 6. Answer, score; evidence only appears after finalize.
	const reviewSaved = await post(`/api/sessions/${id}/learning/attempts`, {
		attempt_id: "a_review", question_id: reviewBody.question.question_id, question_version: "1",
		expected_revision: reviewBody.checkpoint.revision, answer: "复习作答：闭包捕获变量绑定。",
	});
	expect(reviewSaved.status).toBe(200);
	const reviewSavedBody = await reviewSaved.json() as { checkpoint: { revision: number } };
	const reviewEvaluated = await post(`/api/sessions/${id}/learning/attempts/a_review/evaluate`, {
		revision: reviewSavedBody.checkpoint.revision,
	});
	expect(reviewEvaluated.status).toBe(200);
	const reviewEvalBody = await reviewEvaluated.json() as { checkpoint: { revision: number } };
	expect(await evidenceCount()).toBe(evidenceAfterOrigin);

	const reviewFinalized = await post(`/api/sessions/${id}/learning/attempts/a_review/finalize`, {
		revision: reviewEvalBody.checkpoint.revision,
	});
	expect(reviewFinalized.status).toBe(200);
	expect(await evidenceCount()).toBe(evidenceAfterOrigin + 1);
	// The new evidence belongs to the reviewed concept and to this attempt.
	expect(await latestEvidence()).toMatchObject({
		concept_id: conceptId,
		learning_attempt: { attempt_id: "a_review" },
	});

	// 7. L1 state and the exact recommendation are re-derived from the new evidence.
	const afterProfile = await profile();
	const afterState = afterProfile.knowledge_states.find((item) => item.concept_id === conceptId)!;
	expect(afterState.evidence_ids.length).toBeGreaterThan(dueState.evidence_ids.length);
	// One correct review does not get promoted to a claim of stable mastery.
	expect(afterState.state_label).not.toBe("stable");
	const afterAdvice = await recommendations(conceptId);
	const expectedAdvice = recommendNextLearningActions(afterProfile, new Date(afterAdvice.as_of), {
		limit: 3, conceptId,
	});
	expect(afterAdvice.recommendations).toEqual(expectedAdvice);

	// 8. Replayed finalize adds nothing.
	const callsBeforeReplay = providerCalls;
	const replayFinalize = await post(`/api/sessions/${id}/learning/attempts/a_review/finalize`, { revision: 0 });
	expect(replayFinalize.status).toBe(200);
	const replayFinalizeBody = await replayFinalize.json() as { replayed: boolean };
	expect(replayFinalizeBody.replayed).toBe(true);
	expect(await evidenceCount()).toBe(evidenceAfterOrigin + 1);
	expect(providerCalls).toBe(callsBeforeReplay);

	// 9. Restart: the review question and attempt remain, recommendation stable.
	const callsBeforeRestart = providerCalls;
	const evidenceBeforeRestart = await evidenceCount();
	await stopServer();
	await startServer();
	const restored = await learning(id);
	expect(restored.checkpoint.question?.question_id).toBe(reviewBody.question.question_id);
	expect(restored.attempts?.find((item) => item.attempt_id === "a_review")?.answer).toBe("复习作答：闭包捕获变量绑定。");
	const restartedAdvice = await recommendations(conceptId);
	expect(restartedAdvice.recommendations).toEqual(afterAdvice.recommendations);
	expect(await evidenceCount()).toBe(evidenceBeforeRestart);
	expect(providerCalls).toBe(callsBeforeRestart);
}, 300_000);
