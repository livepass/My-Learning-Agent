import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionMetaStore } from "../shared/session-meta-store.js";
import { LearningRecordStore } from "./record-store.js";
import type { LearningAttempt, LearningSessionRecord } from "../memory/learner/types.js";

let dir: string;
const stores: LearningRecordStore[] = [];
const metaStores: SessionMetaStore[] = [];

function openStore(): LearningRecordStore {
	const meta = new SessionMetaStore({ dataDir: dir });
	metaStores.push(meta);
	const store = new LearningRecordStore({ dataDir: dir, metaStore: meta });
	stores.push(store);
	return store;
}

async function rawRecord(sessionId: string): Promise<string> {
	return readFile(join(dir, "learning", `${sessionId}.json`), "utf-8");
}

async function rawMeta(): Promise<unknown> {
	return JSON.parse(await readFile(join(dir, "sessions", "meta.json"), "utf-8"));
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-learning-record-"));
});

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const meta of metaStores.splice(0)) await meta.close();
	await rm(dir, { recursive: true, force: true });
});

function seedRecord(sessionId: string, record: unknown): Promise<void> {
	return (async () => {
		await mkdir(join(dir, "learning"), { recursive: true });
		await writeFile(join(dir, "learning", `${sessionId}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");
	})();
}

const baseRecord = (revision = 3): LearningSessionRecord => ({
	schema_version: 1,
	checkpoint: {
		schema_version: 1, session_id: "s1", revision, status: "active", step: "awaiting_answer",
		exposure_sequence: 0, updated_at: "2026-11-02T00:00:00.000Z",
	},
	questions: [],
	exposures: [],
	attempts: [],
});

describe("LearningRecordStore", () => {
	it("creates a new record and writes the projection after the authoritative file", async () => {
		const store = openStore();
		const record = await store.create("s1");
		expect(record.checkpoint.revision).toBe(1);
		expect(record.checkpoint.step).toBe("conversation");
		expect(record.checkpoint.status).toBe("active");

		// Authority persisted first (projection refresh is a follow-up write).
		const meta = await rawMeta();
		expect((meta as Record<string, { learning: unknown }>)["s1"].learning).toMatchObject({
			revision: 1, status: "active", step: "conversation",
		});
	});

	it("rejects a stale revision without touching the authoritative file", async () => {
		const store = openStore();
		await store.create("s1");
		await store.update("s1", 1, (r) => { r.checkpoint.step = "awaiting_answer"; });
		const before = await rawRecord("s1");

		await expect(store.update("s1", 0, (r) => { r.checkpoint.step = "feedback"; }))
			.rejects.toMatchObject({ code: "RECORD_CONFLICT", currentRevision: 2 });
		expect(await rawRecord("s1")).toBe(before);
	});

	it("survives a process restart and continues the revision sequence", async () => {
		const first = openStore();
		await first.create("s1");
		await first.update("s1", 1, (r) => { r.checkpoint.step = "awaiting_answer"; });
		await first.close();

		const restarted = openStore();
		const record = await restarted.get("s1");
		expect(record?.checkpoint.revision).toBe(2);
		expect(record?.checkpoint.step).toBe("awaiting_answer");

		const next = await restarted.update("s1", 2, (r) => { r.checkpoint.step = "feedback"; });
		expect(next.checkpoint.revision).toBe(3);
	});

	it("rebuilds a stale projection from the authoritative record on restart", async () => {
		const first = openStore();
		await first.create("s1");
		// Simulate a crash between authority write and projection write: the
		// authoritative record exists but the meta projection is missing/stale.
		await first.update("s1", 1, (r) => { r.checkpoint.step = "awaiting_answer"; });
		// Manually clear the projection to simulate the crash window.
		const meta = new SessionMetaStore({ dataDir: dir });
		await meta.setLearningProjection("s1", null);
		await first.close();

		const restarted = openStore();
		await restarted.refreshProjection("s1");
		const restored = (await rawMeta()) as Record<string, { learning: { revision: number; step: string } }>;
		expect(restored["s1"].learning).toMatchObject({ revision: 2, step: "awaiting_answer" });
	});

	it("serializes concurrent updates without losing the winning revision", async () => {
		const store = openStore();
		await store.create("s1");
		const tasks = Array.from({ length: 10 }, (_, i) =>
			store.update("s1", undefined, (r) => { (r.checkpoint as { tag?: number }).tag = i; }));
		await Promise.all(tasks);
		const record = await store.get("s1");
		expect(record?.checkpoint.revision).toBe(11); // 1 create + 10 updates
	});

	it("pauses and resumes without a stale write clobbering the transition", async () => {
		const store = openStore();
		await store.create("s1");
		const paused = await store.pause("s1", 1);
		expect(paused.checkpoint.status).toBe("paused");

		await expect(store.resume("s1", 1)).rejects.toMatchObject({ code: "RECORD_CONFLICT" });
		const resumed = await store.resume("s1", 2);
		expect(resumed.checkpoint.status).toBe("active");
	});

	it("removes the authoritative record and its projection", async () => {
		const store = openStore();
		await store.create("s1");
		expect(await store.get("s1")).toBeDefined();
		expect(await store.remove("s1")).toBe(true);
		expect(await store.get("s1")).toBeUndefined();
		const meta = await rawMeta();
		expect((meta as Record<string, { learning?: unknown }>)["s1"].learning).toBeUndefined();
		// Idempotent removal.
		expect(await store.remove("s1")).toBe(false);
	});

	it("does not expose private answer, rubric or hints in the public view", async () => {
		const store = openStore();
		await store.create("s1");
		await store.update("s1", 1, (r) => {
			r.questions.push({
				question_id: "q1", question_version: "1", concept_id: "c1", goal_id: "g1",
				prompt: "什么是闭包？", kind: "free_recall", rubric_version: "rubric-1",
				rubric: [{ criterion_id: "c", description: "答案", weight: 1 }],
				hints: ["提示：作用域"], reference_answer: "闭包是函数+词法作用域",
			});
		});
		const view = await store.publicView("s1");
		expect(view?.questions[0]).toMatchObject({ question_id: "q1", prompt: "什么是闭包？" });
		expect(view?.questions[0]).not.toHaveProperty("rubric");
		expect(view?.questions[0]).not.toHaveProperty("hints");
		expect(view?.questions[0]).not.toHaveProperty("reference_answer");
	});

	it("reads historical records without migrating them", async () => {
		await seedRecord("s1", baseRecord(5));
		const store = openStore();
		const record = await store.get("s1");
		expect(record?.checkpoint.revision).toBe(5);
		expect(record?.checkpoint.step).toBe("awaiting_answer");
	});

	it("refuses to write after close and drains in-flight writes", async () => {
		const store = openStore();
		await store.create("s1");
		const pending = store.update("s1", 1, (r) => { r.checkpoint.step = "awaiting_answer"; });
		await store.close();
		await pending;
		await expect(store.update("s1", 2, (r) => { r.checkpoint.step = "feedback"; }))
			.rejects.toMatchObject({ code: "RECORD_CLOSED" });
	});

	it("refuses to write while another process owns the data directory", async () => {
		// A second process must be refused; an in-process acquire would share the
		// lock (refcounted), so hold it from a child worker instead.
		const { spawn } = await import("node:child_process");
		const { fileURLToPath } = await import("node:url");
		const worker = fileURLToPath(new URL("../shared/__fixtures__/meta-lock-worker.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", worker, dir], { stdio: ["pipe", "pipe", "pipe"] });
		await new Promise<void>((resolve, reject) => {
			let buffer = "";
			const timer = setTimeout(() => reject(new Error("worker lock timeout")), 30_000);
			child.stdout.on("data", (chunk) => {
				buffer += String(chunk);
				if (buffer.includes("LOCKED")) { clearTimeout(timer); resolve(); }
			});
			child.on("exit", () => { clearTimeout(timer); reject(new Error("worker exited early")); });
		});

		const store = openStore();
		await expect(store.create("s1")).rejects.toMatchObject({ code: "RECORD_WRITER_LOCK" });

		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await store.create("s1"); // stale lock reclaimed, then write succeeds
	});

	it("create is idempotent: an existing record is returned unchanged", async () => {
		const store = openStore();
		const first = await store.create("s1", { goalId: "goal-a" });
		expect(first.checkpoint.revision).toBe(1);
		expect(first.checkpoint.goal_id).toBe("goal-a");
		const firstUpdatedAt = first.checkpoint.updated_at;

		// Re-creating with a different goalId must not mutate or bump anything.
		const again = await store.create("s1", { goalId: "goal-b" });
		expect(again.checkpoint.revision).toBe(1);
		expect(again.checkpoint.goal_id).toBe("goal-a");
		expect(again.checkpoint.updated_at).toBe(firstUpdatedAt);
	});

	it("concurrent create calls yield exactly one record", async () => {
		const store = openStore();
		await Promise.all([
			store.create("s1", { goalId: "a" }),
			store.create("s1", { goalId: "b" }),
			store.create("s1", { goalId: "c" }),
		]);
		const record = await store.get("s1");
		expect(record?.checkpoint.revision).toBe(1);
		// Exactly one goal wins; the others observe the winner's record.
		expect(["a", "b", "c"]).toContain(record?.checkpoint.goal_id);
	});

	it("rejects a corrupt record instead of re-initialising or overwriting", async () => {
		const store = openStore();
		await store.create("s1");
		// Corrupt the authoritative record: schema_version mismatch.
		await seedRecord("s1", { ...baseRecord(2), schema_version: 99 });
		await expect(store.get("s1")).rejects.toMatchObject({ code: "RECORD_CORRUPT" });
		// The corrupt file is not silently overwritten by a later create.
		await expect(store.create("s1")).rejects.toMatchObject({ code: "RECORD_CORRUPT" });
	});

	it("rejects a record whose session_id does not match its file", async () => {
		const store = openStore();
		await seedRecord("s1", { ...baseRecord(2), checkpoint: { ...baseRecord(2).checkpoint, session_id: "other" } });
		await expect(store.get("s1")).rejects.toMatchObject({ code: "RECORD_CORRUPT" });
	});

	it("rejects a checkpoint referencing an unsaved question or attempt", async () => {
		const store = openStore();
		await seedRecord("s1", {
			...baseRecord(2),
			checkpoint: { ...baseRecord(2).checkpoint, question: { question_id: "ghost", question_version: "1" } },
		});
		await expect(store.get("s1")).rejects.toMatchObject({ code: "RECORD_CORRUPT" });

		await seedRecord("s1", {
			...baseRecord(2),
			checkpoint: { ...baseRecord(2).checkpoint, pending_attempt_id: "ghost-attempt" },
		});
		await expect(store.get("s1")).rejects.toMatchObject({ code: "RECORD_CORRUPT" });
	});

	it("recoverState returns a public state without private material and derives a recovery action", async () => {
		const store = openStore();
		await store.create("s1");
		await store.update("s1", 1, (r) => {
			r.questions.push({
				question_id: "q1", question_version: "1", concept_id: "c1", goal_id: "g1",
				prompt: "什么是闭包？", kind: "free_recall", rubric_version: "rubric-1",
				rubric: [{ criterion_id: "c", description: "答案", weight: 1 }],
				hints: ["提示"], reference_answer: "闭包是函数+词法作用域",
			});
			r.checkpoint.question = { question_id: "q1", question_version: "1" };
			r.checkpoint.step = "awaiting_answer";
			r.attempts.push({
				session_id: "s1", attempt_id: "a1", question_id: "q1", question_version: "1",
				answer: "私有答案", accepted_at: "2026-11-02T00:00:00.000Z", accepted_revision: 2,
				question: r.questions[0], hints: { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
				evaluation_attempts: 0, progress: { stage: "answer_saved" },
			});
			r.checkpoint.pending_attempt_id = "a1";
		});
		const state = await store.recoverState("s1", { processRunId: "p", maxEvaluationAttempts: 3 });
		expect(state?.checkpoint.revision).toBe(2);
		expect(state?.pending_action).toBe("evaluate");
		// The learner's own answer is recoverable (P1-1); the private scoring
		// material (reference answer, rubric, hints, model reply) never leaks.
		expect(state?.attempts?.[0].answer).toBe("私有答案");
		const serialized = JSON.stringify(state);
		expect(serialized).not.toContain("reference_answer");
		expect(serialized).not.toContain("闭包是函数+词法作用域");
		expect(serialized).not.toContain("rubric");
		expect(serialized).not.toContain("提示");
	});

	it("survives a projection failure: the authoritative write still commits", async () => {
		// A meta store whose projection write always fails must not abort the
		// authoritative record write (projection is rebuildable, authority is not).
		const failingMeta = {
			get: async () => undefined,
			setLearningProjection: async () => { throw new Error("projection down"); },
		} as unknown as SessionMetaStore;
		const store = new LearningRecordStore({ dataDir: dir, metaStore: failingMeta });
		stores.push(store);
		const record = await store.create("s1");
		expect(record.checkpoint.revision).toBe(1);
		// Authority persisted despite the projection failure.
		const raw = await rawRecord("s1");
		expect(JSON.parse(raw).checkpoint.revision).toBe(1);
	});

	it("rejects a concurrent write that starts after close begins", async () => {
		const store = openStore();
		await store.create("s1");
		// Kick off close (it drains the queue) and race a write against it.
		const closing = store.close();
		await expect(store.update("s1", 1, (r) => { r.checkpoint.step = "feedback"; }))
			.rejects.toMatchObject({ code: "RECORD_CLOSED" });
		await closing;
	});

	it("pause/resume: missing record is not-found, never an implicit create", async () => {
		const store = openStore();
		await expect(store.pause("ghost", 1)).rejects.toMatchObject({ code: "RECORD_NOT_FOUND" });
		await expect(store.resume("ghost", 1)).rejects.toMatchObject({ code: "RECORD_NOT_FOUND" });
		// No record file was created as a side effect.
		expect(await store.get("ghost")).toBeUndefined();
	});

	it("pause/resume are idempotent and never bump the revision twice", async () => {
		const store = openStore();
		await store.create("s1");
		const paused = await store.pause("s1", 1);
		expect(paused.checkpoint.status).toBe("paused");
		expect(paused.checkpoint.revision).toBe(2);
		// Pausing again: same revision, no extra write.
		const again = await store.pause("s1", 2);
		expect(again.checkpoint.status).toBe("paused");
		expect(again.checkpoint.revision).toBe(2);

		const resumed = await store.resume("s1", 2);
		expect(resumed.checkpoint.status).toBe("active");
		expect(resumed.checkpoint.revision).toBe(3);
		// Resuming an already-active record: no bump.
		const againResumed = await store.resume("s1", 3);
		expect(againResumed.checkpoint.revision).toBe(3);
	});

	it("pause/resume reject a stale revision and cannot revive a completed checkpoint", async () => {
		const store = openStore();
		await store.create("s1");
		await store.pause("s1", 1);
		// Stale revision still conflicts.
		await expect(store.resume("s1", 1)).rejects.toMatchObject({ code: "RECORD_CONFLICT", currentRevision: 2 });

		// Force a completed checkpoint and prove it cannot be resumed or paused.
		await seedRecord("s1", {
			...baseRecord(4),
			checkpoint: { ...baseRecord(4).checkpoint, status: "completed", step: "feedback" },
		});
		await expect(store.resume("s1", 4)).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" });
		await expect(store.pause("s1", 4)).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" });
	});

	it("a stale snapshot never rolls the projection back over a newer checkpoint", async () => {
		const store = openStore();
		await store.create("s1");
		// Simulate the crash window: authority exists, projection missing.
		await metaStores[metaStores.length - 1].setLearningProjection("s1", null);
		// A newer checkpoint lands before the recovery read.
		await store.update("s1", 1, (r) => { r.checkpoint.step = "awaiting_answer"; });

		const state = await store.recoverState("s1", { processRunId: "p", maxEvaluationAttempts: 3 });
		expect(state?.checkpoint.revision).toBe(2);
		// The projection reflects the newest revision, never the pre-update one.
		const meta = (await rawMeta()) as Record<string, { learning?: { revision: number; step: string } }>;
		expect(meta["s1"].learning).toMatchObject({ revision: 2, step: "awaiting_answer" });
	});

	it("repair does not write when the projection already matches", async () => {
		const store = openStore();
		await store.create("s1");
		const before = await rawMeta();
		await store.recoverState("s1", { processRunId: "p", maxEvaluationAttempts: 3 });
		// A consistent projection must not be rewritten (no timestamp/rev churn).
		expect(await rawMeta()).toEqual(before);
	});

	it("public checkpoint carries the current question ref without private material", async () => {
		const store = openStore();
		await store.create("s1");
		await store.update("s1", 1, (r) => {
			r.questions.push({
				question_id: "q1", question_version: "2", concept_id: "c1", goal_id: "g1",
				prompt: "什么是闭包？", kind: "free_recall", rubric_version: "rubric-1",
				rubric: [{ criterion_id: "c", description: "答案", weight: 1 }],
				hints: ["提示一"], reference_answer: "闭包是函数+词法作用域",
			});
			r.checkpoint.question = { question_id: "q1", question_version: "2" };
			r.checkpoint.step = "awaiting_answer";
		});
		const state = await store.recoverState("s1", { processRunId: "p", maxEvaluationAttempts: 3 });
		expect(state?.checkpoint.question).toEqual({ question_id: "q1", question_version: "2" });
		const raw = JSON.stringify(state);
		expect(raw).not.toContain("reference_answer");
		expect(raw).not.toContain("闭包是函数+词法作用域");
		expect(raw).not.toContain("提示一");
	});

	it("concurrent create and remove of the same session converge without resurrection", async () => {
		const store = openStore();
		// Deterministic interleaving: the queue runs create (no-op, already
		// exists) then remove, so the final state is "deleted".
		await store.create("s1");
		const creating = store.create("s1");
		const removing = store.remove("s1");
		await Promise.all([creating, removing]);
		expect(await store.get("s1")).toBeUndefined();
		expect((await rawMeta() as Record<string, { learning?: unknown }>)["s1"]?.learning).toBeUndefined();
	});

	it("create refuses a session that a concurrent delete already removed", async () => {
		const store = openStore();
		// The existence probe is evaluated inside the write boundary.
		await expect(store.create("gone", { sessionExists: () => false }))
			.rejects.toMatchObject({ code: "RECORD_NOT_FOUND" });
		expect(await store.get("gone")).toBeUndefined();
	});
});

describe("commitQuestion", () => {
	const question = (id: string) => ({
		question_id: id,
		question_version: "1",
		concept_id: "concept_closure",
		prompt: "解释闭包为什么会持有外层变量。",
		kind: "free_recall" as const,
		rubric_version: "c1-v1",
		rubric: [{ criterion_id: "c1", description: "指出捕获的是变量", weight: 1 }],
		hints: ["想想变量存在哪里"],
		reference_answer: "捕获的是变量绑定。",
		generation: { request_id: "req_1", fingerprint: "fp_1" },
		knowledge: {
			kind: "model_knowledge" as const,
			ground: "no_source_requested" as const,
			bound_at: "2026-11-02T00:00:00.000Z",
			model: { provider_id: "fixture", model_id: "dummy", model_version: null, version_source: "unavailable" as const },
		},
	});

	it("appends one question, advances the checkpoint once, and projects it", async () => {
		const store = openStore();
		await store.create("s1.jsonl");
		const result = await store.commitQuestion("s1.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 1,
			question: question("q1"), sessionExists: () => true,
		});

		expect(result.created).toBe(true);
		expect(result.record.questions).toHaveLength(1);
		expect(result.record.checkpoint.revision).toBe(2);
		expect(result.record.checkpoint.step).toBe("awaiting_answer");
		expect(result.record.checkpoint.question).toEqual({ question_id: "q1", question_version: "1" });
		expect(result.record.checkpoint.status).toBe("active");
		expect(result.record.exposures).toHaveLength(0);
		expect(result.record.attempts).toHaveLength(0);

		const meta = await rawMeta() as Record<string, { learning?: { revision: number; step: string } }>;
		expect(meta["s1.jsonl"].learning?.revision).toBe(2);
		expect(meta["s1.jsonl"].learning?.step).toBe("awaiting_answer");
	});

	it("returns the same question for a retried request even with a stale revision", async () => {
		const store = openStore();
		await store.create("s1.jsonl");
		await store.commitQuestion("s1.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 1,
			question: question("q1"), sessionExists: () => true,
		});
		const before = await rawRecord("s1.jsonl");

		const retry = await store.commitQuestion("s1.jsonl", {
			// A retry after a lost response still carries revision 1.
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 1,
			question: question("q_other"), sessionExists: () => true,
		});

		expect(retry.created).toBe(false);
		expect(retry.question.question_id).toBe("q1");
		expect(retry.record.checkpoint.revision).toBe(2);
		expect(await rawRecord("s1.jsonl")).toBe(before);
	});

	it("rejects the same request id with a different payload", async () => {
		const store = openStore();
		await store.create("s1.jsonl");
		await store.commitQuestion("s1.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 1,
			question: question("q1"), sessionExists: () => true,
		});

		await expect(store.commitQuestion("s1.jsonl", {
			requestId: "req_1", fingerprint: "fp_2", expectedRevision: 2,
			question: question("q2"), sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_CONFLICT" });

		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(1);
	});

	it("rejects a stale revision for a different request without writing", async () => {
		const store = openStore();
		await store.create("s1.jsonl");
		const before = await rawRecord("s1.jsonl");

		await expect(store.commitQuestion("s1.jsonl", {
			requestId: "req_2", fingerprint: "fp_2", expectedRevision: 0,
			question: question("q1"), sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_CONFLICT" });

		expect(await rawRecord("s1.jsonl")).toBe(before);
	});

	it("refuses a paused, completed or already-questioned checkpoint", async () => {
		const store = openStore();
		await store.create("s1.jsonl");
		await store.pause("s1.jsonl", 1);
		await expect(store.commitQuestion("s1.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 2,
			question: question("q1"), sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" });

		await store.resume("s1.jsonl", 2);
		await store.commitQuestion("s1.jsonl", {
			requestId: "req_9", fingerprint: "fp_9", expectedRevision: 3,
			question: question("q1"), sessionExists: () => true,
		});
		// A second, different request must not overwrite the pending question.
		await expect(store.commitQuestion("s1.jsonl", {
			requestId: "req_10", fingerprint: "fp_10", expectedRevision: 4,
			question: question("q2"), sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" });
	});

	it("never creates a missing record and respects a concurrent delete", async () => {
		const store = openStore();
		await expect(store.commitQuestion("missing.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 0,
			question: question("q1"), sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_NOT_FOUND" });

		await store.create("s2.jsonl");
		const before = await rawRecord("s2.jsonl");
		await expect(store.commitQuestion("s2.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 1,
			question: question("q1"), sessionExists: () => false,
		})).rejects.toMatchObject({ code: "RECORD_NOT_FOUND" });
		expect(await rawRecord("s2.jsonl")).toBe(before);
	});

	it("lets exactly one of two concurrent generations win", async () => {
		const store = openStore();
		await store.create("s1.jsonl");

		const results = await Promise.allSettled([
			store.commitQuestion("s1.jsonl", {
				requestId: "req_a", fingerprint: "fp_a", expectedRevision: 1,
				question: question("qa"), sessionExists: () => true,
			}),
			store.commitQuestion("s1.jsonl", {
				requestId: "req_b", fingerprint: "fp_b", expectedRevision: 1,
				question: question("qb"), sessionExists: () => true,
			}),
		]);

		expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
		const record = (await store.get("s1.jsonl"))!;
		expect(record.questions).toHaveLength(1);
		expect(record.checkpoint.revision).toBe(2);
	});

	it("still reads a schema_version 1 record written before C1", async () => {
		await seedRecord("s1.jsonl", {
			schema_version: 1,
			checkpoint: {
				schema_version: 1, session_id: "s1.jsonl", revision: 3, status: "active",
				step: "conversation", exposure_sequence: 0, updated_at: "2026-11-01T00:00:00.000Z",
			},
			questions: [{
				question_id: "legacy_q", question_version: "1", concept_id: "concept_old",
				prompt: "旧题目", kind: "free_recall", rubric_version: "r1",
				rubric: [{ criterion_id: "c1", description: "d", weight: 1 }],
				hints: [], reference_answer: "旧答案",
			}],
			exposures: [], attempts: [],
		});
		const store = openStore();
		const record = (await store.get("s1.jsonl"))!;
		expect(record.questions[0].knowledge).toBeUndefined();
		expect(record.questions[0].generation).toBeUndefined();

		// And it can still accept a new question.
		const result = await store.commitQuestion("s1.jsonl", {
			requestId: "req_new", fingerprint: "fp_new", expectedRevision: 3,
			question: question("q1"), sessionExists: () => true,
		});
		expect(result.record.checkpoint.revision).toBe(4);
	});
});

describe("commitAttempt and evaluation transitions", () => {
	const question = {
		question_id: "q1",
		question_version: "1",
		concept_id: "concept_closure",
		prompt: "解释闭包为什么会持有外层变量。",
		kind: "free_recall" as const,
		rubric_version: "c1-v1",
		rubric: [{ criterion_id: "c1", description: "指出捕获的是变量", weight: 1 }],
		hints: ["想想变量存在哪里"],
		reference_answer: "捕获的是变量绑定。",
	};

	function attempt(id = "attempt_1"): LearningAttempt {
		return {
			session_id: "s1.jsonl",
			attempt_id: id,
			question_id: "q1",
			question_version: "1",
			answer: "闭包捕获变量绑定。",
			accepted_at: "2026-11-03T00:00:00.000Z",
			accepted_revision: 2,
			question: structuredClone(question),
			hints: { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
			evaluation_attempts: 0,
			progress: { stage: "answer_saved" },
		};
	}

	async function seedAnswered(store: LearningRecordStore): Promise<void> {
		await store.create("s1.jsonl");
		await store.commitQuestion("s1.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 1,
			question, sessionExists: () => true,
		});
		await store.commitAttempt("s1.jsonl", {
			attempt: attempt(), expectedRevision: 2, sessionExists: () => true,
		});
	}

	it("commits an attempt, sets pending_attempt_id and advances once", async () => {
		const store = openStore();
		await store.create("s1.jsonl");
		await store.commitQuestion("s1.jsonl", {
			requestId: "req_1", fingerprint: "fp_1", expectedRevision: 1,
			question, sessionExists: () => true,
		});

		const result = await store.commitAttempt("s1.jsonl", {
			attempt: attempt(), expectedRevision: 2, sessionExists: () => true,
		});
		expect(result.created).toBe(true);
		expect(result.record.checkpoint.revision).toBe(3);
		expect(result.record.checkpoint.pending_attempt_id).toBe("attempt_1");
		expect(result.record.attempts).toHaveLength(1);
		expect(result.record.checkpoint.step).toBe("awaiting_answer");
	});

	it("replays an identical attempt without a second append", async () => {
		const store = openStore();
		await seedAnswered(store);
		const before = await rawRecord("s1.jsonl");

		const retry = await store.commitAttempt("s1.jsonl", {
			attempt: attempt(), expectedRevision: 2, sessionExists: () => true,
		});
		expect(retry.created).toBe(false);
		expect(retry.attempt.attempt_id).toBe("attempt_1");
		expect(await rawRecord("s1.jsonl")).toBe(before);
	});

	it("rejects a different answer under the same attempt id", async () => {
		const store = openStore();
		await seedAnswered(store);
		await expect(store.commitAttempt("s1.jsonl", {
			attempt: { ...attempt(), answer: "别的答案" }, expectedRevision: 2, sessionExists: () => true,
		})).rejects.toThrow(/不同的提交/);
	});

	it("walks answer_saved → evaluating → evaluated", async () => {
		const store = openStore();
		await seedAnswered(store);

		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating", process_run_id: "p1", evaluation_run_id: "run-1",
				model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		let record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].progress.stage).toBe("evaluating");
		expect(record.attempts[0].evaluation_attempts).toBe(1);
		expect(record.checkpoint.revision).toBe(4);

		await store.completeEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4,
			evaluationRunId: "run-1",
			progress: {
				stage: "evaluated",
				assessment: {
					session_id: "s1.jsonl", attempt_id: "attempt_1", question_id: "q1", question_version: "1",
					rubric_version: "c1-v1",
					model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
					hints: { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
					result: "correct", score: 1, feedback: "好",
					criteria: [{ criterion_id: "c1", judgment: "met", explanation: "对" }],
					assessed_at: "2026-11-03T00:00:00.000Z",
				},
			},
		});
		record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].progress.stage).toBe("evaluated");
		expect(record.checkpoint.revision).toBe(5);
	});

	it("records an evaluation failure for a retry", async () => {
		const store = openStore();
		await seedAnswered(store);
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating", process_run_id: "p1", evaluation_run_id: "run-1",
				model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		await store.failEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4,
			evaluationRunId: "run-1",
			progress: {
				stage: "evaluation_failed",
				failure: { code: "timeout", message: "超时", failed_at: "2026-11-03T00:00:00.000Z" },
			},
		});
		const record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].progress.stage).toBe("evaluation_failed");
	});

	it("rolls back an evaluation without consuming attempts when model call aborts", async () => {
		const store = openStore();
		await seedAnswered(store);
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating", process_run_id: "p1", evaluation_run_id: "run-1",
				model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		let record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(1);
		expect(record.attempts[0].progress.stage).toBe("evaluating");

		await store.rollbackEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4,
			evaluationRunId: "run-1",
			progress: { stage: "answer_saved" },
		});
		record = (await store.get("s1.jsonl"))!;
		expect(record.attempts[0].evaluation_attempts).toBe(0);
		expect(record.attempts[0].progress.stage).toBe("answer_saved");
	});

	it("rejects rollback when evaluation_run_id does not match", async () => {
		const store = openStore();
		await seedAnswered(store);
		await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating", process_run_id: "p1", evaluation_run_id: "run-live",
				model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		await expect(store.rollbackEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 4,
			evaluationRunId: "run-stale",
			progress: { stage: "answer_saved" },
		})).rejects.toThrow(/本次结果已过期/);
	});

	it("rejects rollback on an attempt that is not evaluating", async () => {
		const store = openStore();
		await seedAnswered(store);
		await expect(store.rollbackEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			evaluationRunId: "run-1",
			progress: { stage: "answer_saved" },
		})).rejects.toThrow(/没有正在进行的评估/);
	});

	it("rejects completing an evaluation that never began", async () => {
		const store = openStore();
		await seedAnswered(store);
		await expect(store.completeEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			evaluationRunId: "run-0",
			progress: { stage: "evaluated", assessment: {} as never },
		})).rejects.toThrow(/没有正在进行的评估/);
	});

	it("rejects a stale revision on the evaluation transitions", async () => {
		const store = openStore();
		await seedAnswered(store);
		await expect(store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 1,
			progress: {
				stage: "evaluating", process_run_id: "p1", evaluation_run_id: "run-1",
				model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
				started_at: "2026-11-03T00:00:00.000Z",
			},
		})).rejects.toThrow(/已被更新/);
	});

	it("executes C3 stage transitions: recordEvidence -> recordProfileProjected -> completeAttempt", async () => {
		const store = openStore();
		await seedAnswered(store);
		// Begin and complete evaluation first
		const evaluating = await store.beginEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: 3,
			progress: {
				stage: "evaluating", process_run_id: "p1", evaluation_run_id: "run-1",
				model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
				started_at: "2026-11-03T00:00:00.000Z",
			},
		});
		const evaluated = await store.completeEvaluation("s1.jsonl", "attempt_1", {
			expectedRevision: evaluating.checkpoint.revision,
			evaluationRunId: "run-1",
			progress: {
				stage: "evaluated",
				assessment: {
					session_id: "s1.jsonl",
					attempt_id: "attempt_1",
					question_id: "q1",
					question_version: "1",
					rubric_version: "r1",
					model: { provider_id: "f", model_id: "m", model_version: null, version_source: "unavailable" },
					hints: { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
					result: "correct",
					score: 1,
					feedback: "答对了",
					criteria: [{ criterion_id: "c1", judgment: "met", explanation: "好" }],
					assessed_at: "2026-11-03T00:00:00.000Z",
				},
			},
		});

		// 1. recordEvidence
		const mockEvent: any = {
			event_id: "evt_1",
			event_type: "learning_evidence",
			learner_id: "learner_1",
			timestamp: "2026-11-03T00:00:00.000Z",
			context: { session_id: "s1.jsonl", concept_ids: ["c1"] },
			payload: {},
		};
		const afterEvidence = await store.recordEvidence("s1.jsonl", "attempt_1", {
			expectedRevision: evaluated.checkpoint.revision,
			event: mockEvent,
		});
		expect(afterEvidence.attempts[0].progress.stage).toBe("evidence_recorded");
		expect(afterEvidence.checkpoint.revision).toBe(evaluated.checkpoint.revision + 1);

		// Idempotent recordEvidence
		const repeatEvidence = await store.recordEvidence("s1.jsonl", "attempt_1", {
			expectedRevision: afterEvidence.checkpoint.revision,
			event: mockEvent,
		});
		expect(repeatEvidence.checkpoint.revision).toBe(afterEvidence.checkpoint.revision);

		// 2. recordProfileProjected
		const afterProjected = await store.recordProfileProjected("s1.jsonl", "attempt_1", {
			expectedRevision: afterEvidence.checkpoint.revision,
			profileVersion: 42,
		});
		expect(afterProjected.attempts[0].progress.stage).toBe("profile_projected");
		if (afterProjected.attempts[0].progress.stage === "profile_projected") {
			expect(afterProjected.attempts[0].progress.profile_version).toBe(42);
		}
		expect(afterProjected.checkpoint.revision).toBe(afterEvidence.checkpoint.revision + 1);

		// 3. completeAttempt advances checkpoint
		const afterComplete = await store.completeAttempt("s1.jsonl", "attempt_1", {
			expectedRevision: afterProjected.checkpoint.revision,
		});
		expect(afterComplete.attempts[0].progress.stage).toBe("completed");
		expect(afterComplete.checkpoint.step).toBe("feedback");
		expect(afterComplete.checkpoint.pending_attempt_id).toBeUndefined();
		expect(afterComplete.checkpoint.last_completed_attempt_id).toBe("attempt_1");
		expect(afterComplete.checkpoint.status).toBe("active"); // Not prematurely closed
		expect(afterComplete.checkpoint.revision).toBe(afterProjected.checkpoint.revision + 1);

		// Idempotent completeAttempt
		const repeatComplete = await store.completeAttempt("s1.jsonl", "attempt_1", {
			expectedRevision: afterComplete.checkpoint.revision,
		});
		expect(repeatComplete.checkpoint.revision).toBe(afterComplete.checkpoint.revision);

		// Verify recoverState reflects completed attempt with assessment intact
		const recovered = await store.recoverState("s1.jsonl", { processRunId: "p1", maxEvaluationAttempts: 3 });
		expect(recovered?.attempts?.[0].stage).toBe("completed");
		expect(recovered?.attempts?.[0].assessment?.feedback).toBe("答对了");
	});
});

describe("commitQuestion continuation (C4)", () => {
	const savedQuestion = (id: string) => ({
		question_id: id, question_version: "1", concept_id: "concept_closure",
		prompt: "解释闭包为什么会持有外层变量。", kind: "free_recall" as const, rubric_version: "c1-v1",
		rubric: [{ criterion_id: "c1", description: "指出捕获的是变量", weight: 1 }],
		hints: [], reference_answer: "捕获的是变量绑定。",
		generation: { request_id: `req_${id}`, fingerprint: `fp_${id}` },
	});
	const nextQuestion = (id: string) => ({
		...savedQuestion(id),
		generation: { request_id: `req_${id}`, fingerprint: `fp_${id}` },
	});
	const completedAttempt = () => {
		const questionA = savedQuestion("qA");
		return {
			session_id: "s1.jsonl", attempt_id: "a1", question_id: "qA", question_version: "1",
			answer: "闭包捕获变量绑定。", accepted_at: "2026-11-03T00:00:00.000Z", accepted_revision: 2,
			question: questionA, hints: { through_sequence: 0, exposure_ids: [], hint_level: 0 as const, answer_revealed: false },
			evaluation_attempts: 1,
			progress: {
				stage: "completed" as const,
				assessment: {
					session_id: "s1.jsonl", attempt_id: "a1", question_id: "qA", question_version: "1",
					rubric_version: "c1-v1",
					model: { provider_id: "fixture", model_id: "dummy", model_version: null, version_source: "unavailable" as const },
					hints: { through_sequence: 0, exposure_ids: [], hint_level: 0 as const, answer_revealed: false },
					result: "correct" as const, score: 1, feedback: "准确。",
					criteria: [{ criterion_id: "c1", judgment: "met" as const, explanation: "提到变量绑定" }],
					assessed_at: "2026-11-03T00:00:00.000Z",
				},
				event: {
					event_id: "event_a1", learner_id: "default", timestamp: "2026-11-03T00:00:00.000Z",
					event_type: "learning_evidence", context: {}, payload: {},
				},
				profile_version: 5,
				checkpoint_advanced: true,
			},
		};
	};
	const feedbackRecord = (overrides: Record<string, unknown> = {}) => ({
		schema_version: 1,
		checkpoint: {
			schema_version: 1, session_id: "s1.jsonl", revision: 4, status: "active", step: "feedback",
			question: { question_id: "qA", question_version: "1" },
			last_completed_attempt_id: "a1", exposure_sequence: 3,
			updated_at: "2026-11-03T00:00:00.000Z", ...overrides,
		},
		questions: [savedQuestion("qA")],
		exposures: [],
		attempts: [completedAttempt()],
	});

	it("commits the next question after a completed attempt without touching history", async () => {
		await seedRecord("s1.jsonl", feedbackRecord());
		const store = openStore();
		const before = (await store.get("s1.jsonl"))!;

		const result = await store.commitQuestion("s1.jsonl", {
			requestId: "req_qB", fingerprint: "fp_qB", expectedRevision: 4,
			question: nextQuestion("qB"), afterAttemptId: "a1", sessionExists: () => true,
		});

		expect(result.created).toBe(true);
		expect(result.question.question_id).toBe("qB");
		expect(result.record.questions.map((item) => item.question_id)).toEqual(["qA", "qB"]);
		expect(result.record.checkpoint).toMatchObject({
			revision: 5, step: "awaiting_answer", question: { question_id: "qB", question_version: "1" },
			last_completed_attempt_id: "a1", status: "active", exposure_sequence: 3,
		});
		// Immutable history: the completed attempt keeps its answer, score and event.
		expect(result.record.attempts).toEqual(before.attempts);
		expect(result.record.questions[0]).toEqual(before.questions[0]);
	});

	it.each([
		["missing after_attempt_id", feedbackRecord(), undefined],
		["after_attempt_id of another attempt", feedbackRecord(), "a_other"],
		["evaluated but not completed", feedbackRecord({ last_completed_attempt_id: "a1" }), "a1"],
	] as const)("rejects %s without writing", async (label, seeded, afterAttemptId) => {
		if (label === "evaluated but not completed") {
			const record = feedbackRecord();
			record.attempts[0].progress = { ...record.attempts[0].progress, stage: "evaluated" } as unknown as typeof record.attempts[0]["progress"];
			seeded = record;
		}
		await seedRecord("s1.jsonl", seeded);
		const store = openStore();
		const before = await rawRecord("s1.jsonl");

		await expect(store.commitQuestion("s1.jsonl", {
			requestId: "req_qB", fingerprint: "fp_qB", expectedRevision: 4,
			question: nextQuestion("qB"), ...(afterAttemptId ? { afterAttemptId } : {}),
			sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" });

		expect(await rawRecord("s1.jsonl")).toBe(before);
	});

	it("rejects a question whose identity collides with history", async () => {
		await seedRecord("s1.jsonl", feedbackRecord());
		const store = openStore();

		await expect(store.commitQuestion("s1.jsonl", {
			requestId: "req_dup", fingerprint: "fp_dup", expectedRevision: 4,
			question: nextQuestion("qA"), afterAttemptId: "a1", sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_CONFLICT" });
		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(1);
	});

	it("replays a retried continuation without adding a second question", async () => {
		await seedRecord("s1.jsonl", feedbackRecord());
		const store = openStore();
		const first = await store.commitQuestion("s1.jsonl", {
			requestId: "req_qB", fingerprint: "fp_qB", expectedRevision: 4,
			question: nextQuestion("qB"), afterAttemptId: "a1", sessionExists: () => true,
		});
		const before = await rawRecord("s1.jsonl");

		const retry = await store.commitQuestion("s1.jsonl", {
			// The retry carries the stale revision from before B was committed.
			requestId: "req_qB", fingerprint: "fp_qB", expectedRevision: 4,
			question: nextQuestion("qB"), afterAttemptId: "a1", sessionExists: () => true,
		});

		expect(retry.created).toBe(false);
		expect(retry.question.question_id).toBe(first.question.question_id);
		expect(retry.record.checkpoint.revision).toBe(5);
		expect(await rawRecord("s1.jsonl")).toBe(before);
	});

	it("commits only one question when the same continuation runs twice at once", async () => {
		await seedRecord("s1.jsonl", feedbackRecord());
		const store = openStore();

		const [a, b] = await Promise.all([
			store.commitQuestion("s1.jsonl", {
				requestId: "req_qB", fingerprint: "fp_qB", expectedRevision: 4,
				question: nextQuestion("qB"), afterAttemptId: "a1", sessionExists: () => true,
			}),
			store.commitQuestion("s1.jsonl", {
				requestId: "req_qB", fingerprint: "fp_qB", expectedRevision: 4,
				question: nextQuestion("qB"), afterAttemptId: "a1", sessionExists: () => true,
			}),
		]);

		expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
		expect(a.question.question_id).toBe(b.question.question_id);
		const record = (await store.get("s1.jsonl"))!;
		expect(record.questions).toHaveLength(2);
		expect(record.checkpoint.revision).toBe(5);
	});

	it("refuses to continue while paused or when the session is completed", async () => {
		await seedRecord("s1.jsonl", feedbackRecord({ status: "paused" }));
		const store = openStore();
		await expect(store.commitQuestion("s1.jsonl", {
			requestId: "req_qB", fingerprint: "fp_qB", expectedRevision: 4,
			question: nextQuestion("qB"), afterAttemptId: "a1", sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" });

		await seedRecord("s1.jsonl", feedbackRecord({ status: "completed" }));
		const reopened = openStore();
		await expect(reopened.commitQuestion("s1.jsonl", {
			requestId: "req_qC", fingerprint: "fp_qC", expectedRevision: 4,
			question: nextQuestion("qC"), afterAttemptId: "a1", sessionExists: () => true,
		})).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" });
	});
});

describe("LearningRecordStore.withRecordLock (E1.1)", () => {
	it("serializes the decision with every writer on the same record", async () => {
		const store = openStore();
		await store.create("s1.jsonl");

		let release!: () => void;
		const gate = new Promise<void>(yes => { release = yes; });
		let entered!: () => void;
		const enteredPromise = new Promise<void>(yes => { entered = yes; });

		const holding = store.withRecordLock("s1.jsonl", async (record) => {
			entered();
			await gate;
			return record?.checkpoint.revision;
		});
		await enteredPromise;

		let secondEntered = false;
		let createResolved = false;
		const waiting = store.withRecordLock("s1.jsonl", () => { secondEntered = true; });
		const creating = store.create("s1.jsonl").then(() => { createResolved = true; });

		// Let both queued tasks reach their await points; neither may pass the
		// held slot.
		await new Promise(yes => setTimeout(yes, 10));
		expect(secondEntered).toBe(false);
		expect(createResolved).toBe(false);

		release();
		expect(await holding).toBe(1);
		await waiting;
		await creating;
		expect(secondEntered).toBe(true);
		expect(createResolved).toBe(true);
	});

	it("hands the authoritative record to the callback and supports a refusing callback", async () => {
		await seedRecord("s1.jsonl", {
			schema_version: 1,
			checkpoint: {
				schema_version: 1, session_id: "s1.jsonl", revision: 7, status: "active",
				step: "feedback", last_completed_attempt_id: "a1",
				exposure_sequence: 0, updated_at: "2026-11-05T00:00:00.000Z",
			},
			questions: [], exposures: [], attempts: [],
		});
		const store = openStore();

		const seen = await store.withRecordLock("s1.jsonl", (record) => record?.checkpoint.last_completed_attempt_id);
		expect(seen).toBe("a1");

		await expect(store.withRecordLock("s1.jsonl", () => {
			throw new Error("refused");
		})).rejects.toThrow("refused");
		// A throwing callback is a decision, not a write: the record is untouched.
		expect((await store.get("s1.jsonl"))?.checkpoint.revision).toBe(7);
	});
});
