import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetaStore } from "../shared/session-meta-store.js";
import { LearningRecordStore, type LearningRecordError } from "./record-store.js";
import {
	evaluateAttempt,
	finalizeAttempt,
	saveAnswer,
	type AnswerServiceDeps,
} from "./answer-service.js";
import { buildEvidenceFromAssessment } from "./evidence-adapter.js";
import { loadEvents, mutateProfile, recordEventAndUpdateProfile } from "../memory/learner/profile-store.js";
import { PROJECTION_RULE_VERSION } from "../memory/learner/projection.js";
import type { LearningModelIdentity, LearningQuestion, LearningSessionRecord } from "../memory/learner/types.js";

/**
 * C3 crash-window recovery against the REAL stores.
 *
 * These tests deliberately avoid mocking L1 or B2: the point is that the two
 * stores agree after a crash, and a mock cannot prove that. Only the model call
 * is faked (it is the one thing that cannot be replayed deterministically).
 *
 * Policy this suite pins down: there is **no cross-store transaction**. B2
 * (attempt progress) and L1 (evidence ledger + profile projection) commit
 * independently; recovery is driven by idempotent re-execution — the L1 dedupe
 * key (`learner + session + attempt`) and B2's stage guards — never by a claim
 * of atomicity.
 */

const MODEL: LearningModelIdentity = {
	provider_id: "fixture",
	model_id: "dummy",
	model_version: null,
	version_source: "unavailable",
};

const QUESTION: LearningQuestion = {
	question_id: "q1",
	question_version: "1",
	concept_id: "concept_closure",
	prompt: "解释闭包为什么持有外层变量。",
	kind: "free_recall",
	rubric_version: "c1-v1",
	rubric: [{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 1 }],
	hints: [],
	reference_answer: "闭包捕获变量绑定。",
};

const assessmentReply = {
	result: "correct",
	feedback: "准确。",
	criteria: [{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" }],
};

let dataDir: string;
let learnerDir: string;
let meta: SessionMetaStore;
let store: LearningRecordStore;

function deps(overrides: Partial<AnswerServiceDeps> = {}): AnswerServiceDeps {
	return {
		learningRecordStore: store,
		learnerDataDir: learnerDir,
		complete: async () => ({ status: "ok", text: JSON.stringify(assessmentReply), model: MODEL }),
		processRunId: "process-1",
		maxEvaluationAttempts: 3,
		sessionExists: () => true,
		now: () => new Date("2026-11-03T04:00:00.000Z"),
		...overrides,
	};
}

/** Drive a fresh session to the `evaluated` stage using the real stores. */
async function setupEvaluated(sessionId = "s1.jsonl", attemptId = "attempt_1"): Promise<LearningSessionRecord> {
	await store.create(sessionId);
	await store.commitQuestion(sessionId, {
		requestId: `req_${sessionId}`,
		fingerprint: "fp",
		expectedRevision: 1,
		question: QUESTION,
		sessionExists: () => true,
	});
	const saved = await saveAnswer(deps(), sessionId, {
		attempt_id: attemptId,
		question_id: "q1",
		question_version: "1",
		expected_revision: 2,
		answer: "闭包捕获变量绑定，外层变量因此仍可达。",
	});
	if (!saved.ok) throw new Error(`saveAnswer failed: ${saved.message}`);
	const evaluated = await evaluateAttempt(deps(), sessionId, attemptId, saved.record.checkpoint.revision);
	if (!evaluated.ok) throw new Error(`evaluateAttempt failed: ${evaluated.message}`);
	return evaluated.record;
}

/** Count formal evidence events for one attempt in the authoritative L1 ledger. */
async function evidenceCount(attemptId: string): Promise<number> {
	const events = await loadEvents(learnerDir);
	return events.filter((event) => event.evidence?.learning_attempt?.attempt_id === attemptId).length;
}

/** Read the raw cursor without letting `loadProfile` repair it first. */
async function rawCursor(): Promise<{ applied_seq: number; rule_version: number }> {
	const raw = JSON.parse(await readFile(join(learnerDir, "profile.json"), "utf-8"));
	return raw.projection;
}

function attemptOf(record: LearningSessionRecord, attemptId = "attempt_1") {
	const attempt = record.attempts.find((candidate) => candidate.attempt_id === attemptId);
	if (!attempt) throw new Error("attempt missing");
	return attempt;
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "inno-c3-recovery-b2-"));
	learnerDir = await mkdtemp(join(tmpdir(), "inno-c3-recovery-l1-"));
	meta = new SessionMetaStore({ dataDir });
	store = new LearningRecordStore({ dataDir, metaStore: meta, now: () => new Date("2026-11-03T04:00:00.000Z") });
});

afterEach(async () => {
	await store.close();
	await meta.close();
	await rm(dataDir, { recursive: true, force: true });
	await rm(learnerDir, { recursive: true, force: true });
});

describe("crash windows across B2 and L1", () => {
	it("window A: nothing recorded yet — writes one event, projects it, advances", async () => {
		const record = await setupEvaluated();
		const res = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", record.checkpoint.revision);
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.attempt.progress.stage).toBe("completed");
		expect(res.checkpoint.step).toBe("feedback");
		expect(await evidenceCount("attempt_1")).toBe(1);

		// The cursor really covers the event it claims to have projected.
		const cursor = await rawCursor();
		expect(cursor.rule_version).toBe(PROJECTION_RULE_VERSION);
		expect(cursor.applied_seq).toBeGreaterThanOrEqual(1);
	});

	it("window A2: the ledger holds the event but the projection never covered it — replay repairs the cursor", async () => {
		const record = await setupEvaluated();
		const attempt = attemptOf(record);
		// The append landed; the process died before the projection folded it in.
		const event = buildEvidenceFromAssessment(attempt, "default", new Date("2026-11-03T04:00:00.000Z"));
		const written = await recordEventAndUpdateProfile(learnerDir, event);
		await mutateProfile(learnerDir, (profile) => {
			profile.projection = { applied_seq: written.event.seq - 1, rule_version: PROJECTION_RULE_VERSION };
		});
		expect((await rawCursor()).applied_seq).toBe(written.event.seq - 1);
		// B2 has not moved: this is still the plain "evaluated" path, so the fix
		// has to come from the L1 duplicate branch, not from the inspection.
		expect(attemptOf((await store.get("s1.jsonl"))!).progress.stage).toBe("evaluated");

		const res = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", record.checkpoint.revision);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.replayed).toBe(true);
		expect(res.event.event_id).toBe(written.event.event_id);
		expect(await evidenceCount("attempt_1")).toBe(1);
		expect((await rawCursor()).applied_seq).toBeGreaterThanOrEqual(written.event.seq);
		expect(res.attempt.progress.stage).toBe("completed");
	});

	it("window B/C: L1 already holds the event but B2 is still evaluated — dedupes, never double-writes", async () => {
		const record = await setupEvaluated();
		// Simulate the process dying right after the L1 append, before B2 moved:
		// write the event with the same provenance the finalizer would build.
		const attempt = attemptOf(record);
		const event = buildEvidenceFromAssessment(attempt, "default", new Date("2026-11-03T04:00:00.000Z"));
		const written = await recordEventAndUpdateProfile(learnerDir, event);
		expect(await evidenceCount("attempt_1")).toBe(1);
		// B2 is untouched: still `evaluated`.
		expect(attemptOf((await store.get("s1.jsonl"))!)).toBeDefined();
		expect(attemptOf((await store.get("s1.jsonl"))!).progress.stage).toBe("evaluated");

		const res = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", record.checkpoint.revision);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.replayed).toBe(true);
		// Still exactly one formal evidence event, same event id.
		expect(await evidenceCount("attempt_1")).toBe(1);
		expect(res.event.event_id).toBe(written.event.event_id);
		expect(res.attempt.progress.stage).toBe("completed");
	});

	it("window D: B2 at evidence_recorded with a lagging L1 cursor is repaired by the L1 owner", async () => {
		const record = await setupEvaluated();
		const attempt = attemptOf(record);
		const event = buildEvidenceFromAssessment(attempt, "default", new Date("2026-11-03T04:00:00.000Z"));
		const written = await recordEventAndUpdateProfile(learnerDir, event);
		// Persist the evidence identity into B2 (this is what `evidence_recorded`).
		const afterEv = await store.recordEvidence("s1.jsonl", "attempt_1", {
			expectedRevision: record.checkpoint.revision,
			event: written.event,
		});
		// Now simulate "the projection never folded the event in": cursor = seq - 1.
		await mutateProfile(learnerDir, (profile) => {
			profile.projection = { applied_seq: written.event.seq - 1, rule_version: PROJECTION_RULE_VERSION };
		});
		expect((await rawCursor()).applied_seq).toBe(written.event.seq - 1);

		const res = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", afterEv.checkpoint.revision);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// The owner recovery closed the gap; the claim is now truthful.
		expect(res.attempt.progress.stage).toBe("completed");
		expect(res.checkpoint.step).toBe("feedback");
		expect((await rawCursor()).applied_seq).toBeGreaterThanOrEqual(written.event.seq);
	});

	it("window E: B2 at profile_projected with the checkpoint not yet advanced — completes it", async () => {
		const record = await setupEvaluated();
		const attempt = attemptOf(record);
		const event = buildEvidenceFromAssessment(attempt, "default", new Date("2026-11-03T04:00:00.000Z"));
		const written = await recordEventAndUpdateProfile(learnerDir, event);
		const afterEv = await store.recordEvidence("s1.jsonl", "attempt_1", {
			expectedRevision: record.checkpoint.revision,
			event: written.event,
		});
		const afterProj = await store.recordProfileProjected("s1.jsonl", "attempt_1", {
			expectedRevision: afterEv.checkpoint.revision,
			profileVersion: written.profile.version,
		});
		expect(afterProj.checkpoint.step).toBe("awaiting_answer");

		const res = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", afterProj.checkpoint.revision);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.attempt.progress.stage).toBe("completed");
		expect(res.checkpoint.step).toBe("feedback");
		expect(await evidenceCount("attempt_1")).toBe(1);
	});

	it("window F: a completed attempt replays without another L1 write", async () => {
		const record = await setupEvaluated();
		const first = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", record.checkpoint.revision);
		expect(first.ok).toBe(true);

		const replay = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", 0);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.replayed).toBe(true);
		expect(await evidenceCount("attempt_1")).toBe(1);
	});

	it("a process that died mid-evidence recovers on restart without duplicating mastery", async () => {
		const record = await setupEvaluated();
		const attempt = attemptOf(record);
		const event = buildEvidenceFromAssessment(attempt, "default", new Date("2026-11-03T04:00:00.000Z"));
		await recordEventAndUpdateProfile(learnerDir, event);

		// "Restart": a brand-new B2 store instance over the same data dir.
		await store.close();
		const restartedMeta = new SessionMetaStore({ dataDir });
		const restarted = new LearningRecordStore({ dataDir, metaStore: restartedMeta });
		try {
			const before = await loadEvents(learnerDir);
			const res = await finalizeAttempt(
				deps({ learningRecordStore: restarted, processRunId: "process-2" }),
				"s1.jsonl",
				"attempt_1",
				record.checkpoint.revision,
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.replayed).toBe(true);
			const after = await loadEvents(learnerDir);
			// No second evidence event, so no duplicated mastery delta.
			expect(after.length).toBe(before.length);
			expect(await evidenceCount("attempt_1")).toBe(1);
		} finally {
			await restarted.close();
			await restartedMeta.close();
			// Reopen so afterEach can close without failing.
			meta = new SessionMetaStore({ dataDir });
			store = new LearningRecordStore({ dataDir, metaStore: meta });
		}
	});
});

describe("concurrent finalize and deletion", () => {
	it("two concurrent finalizes produce exactly one evidence event and one mastery delta", async () => {
		const record = await setupEvaluated();
		const revision = record.checkpoint.revision;

		const [a, b] = await Promise.all([
			finalizeAttempt(deps(), "s1.jsonl", "attempt_1", revision),
			finalizeAttempt(deps(), "s1.jsonl", "attempt_1", revision),
		]);

		// Both callers must get a usable result: one does the work, the other
		// observes the completed attempt and replays it.
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.attempt.progress.stage).toBe("completed");
		expect(b.attempt.progress.stage).toBe("completed");
		expect(a.event.event_id).toBe(b.event.event_id);
		// Exactly one of the two actually performed the write.
		expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);

		// Exactly one formal evidence record, so mastery can only advance once.
		expect(await evidenceCount("attempt_1")).toBe(1);
		const events = await loadEvents(learnerDir);
		expect(events).toHaveLength(1);
		expect((await rawCursor()).applied_seq).toBe(events[0].seq);

		const finalRecord = (await store.get("s1.jsonl"))!;
		expect(finalRecord.attempts).toHaveLength(1);
		expect(finalRecord.attempts[0].progress.stage).toBe("completed");
		expect(finalRecord.checkpoint.step).toBe("feedback");
		expect(finalRecord.checkpoint.pending_attempt_id).toBeUndefined();
	});

	it("losing the race to a session delete never resurrects the learning record", async () => {
		const record = await setupEvaluated();
		const revision = record.checkpoint.revision;

		const [finalized, removed] = await Promise.all([
			finalizeAttempt(deps(), "s1.jsonl", "attempt_1", revision),
			store.remove("s1.jsonl"),
		]);

		// Either the delete landed first (finalize reports 404 and writes nothing)
		// or the finalize landed first and the delete then removed the record.
		if (!finalized.ok) {
			expect(finalized.status).toBe(404);
		}
		expect(typeof removed).toBe("boolean");
		const after = await store.get("s1.jsonl");
		// A removed record must stay removed; a surviving one must be coherent.
		if (after === undefined) {
			expect(removed).toBe(true);
		} else {
			expect(after.attempts[0].progress.stage).toBe("completed");
		}
	});
});

describe("P4 checkpoint boundary", () => {
	it("refuses to mark an attempt completed when the checkpoint cannot advance", async () => {
		const record = await setupEvaluated();
		const attempt = attemptOf(record);
		const event = buildEvidenceFromAssessment(attempt, "default", new Date("2026-11-03T04:00:00.000Z"));
		const written = await recordEventAndUpdateProfile(learnerDir, event);
		await store.recordEvidence("s1.jsonl", "attempt_1", {
			expectedRevision: record.checkpoint.revision,
			event: written.event,
		});
		const afterProj = await store.recordProfileProjected("s1.jsonl", "attempt_1", {
			expectedRevision: record.checkpoint.revision + 1,
			profileVersion: written.profile.version,
		});

		// Force an inconsistent checkpoint: step is no longer awaiting_answer, so
		// `advanceCheckpointForAttempt` will refuse to advance.
		await store.update("s1.jsonl", afterProj.checkpoint.revision, (rec) => {
			rec.checkpoint.step = "feedback";
		});

		await expect(store.completeAttempt("s1.jsonl", "attempt_1", {
			expectedRevision: (await store.get("s1.jsonl"))!.checkpoint.revision,
			strict: false,
		})).rejects.toMatchObject({ code: "RECORD_STATE_INVALID" } satisfies Partial<LearningRecordError>);

		// The attempt must not claim completion.
		const after = (await store.get("s1.jsonl"))!;
		expect(after.attempts[0].progress.stage).toBe("profile_projected");
	});
});

describe("non-atomic cross-store policy", () => {
	it("a failure after the L1 append leaves B2 at evaluated, and recovery is re-execution", async () => {
		const record = await setupEvaluated();
		// Simulate the L1 append succeeding and *everything after it* failing: the
		// injected recorder writes for real, then throws so B2 never transitions.
		const failingRecord = vi.fn(async (dir: string, event: Parameters<typeof recordEventAndUpdateProfile>[1]) => {
			await recordEventAndUpdateProfile(dir, event);
			throw new Error("simulated crash after L1 append");
		});

		await expect(finalizeAttempt(
			deps({ recordEventAndUpdateProfile: failingRecord }),
			"s1.jsonl",
			"attempt_1",
			record.checkpoint.revision,
		)).rejects.toThrow(/simulated crash/);

		// L1 holds the evidence; B2 is still evaluated. This is the explicit
		// non-atomic window: the two stores disagree until recovery runs.
		expect(await evidenceCount("attempt_1")).toBe(1);
		expect(attemptOf((await store.get("s1.jsonl"))!).progress.stage).toBe("evaluated");

		// Recovery is simply running the same operation again.
		const recovered = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", record.checkpoint.revision);
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(recovered.replayed).toBe(true);
		expect(recovered.attempt.progress.stage).toBe("completed");
		expect(await evidenceCount("attempt_1")).toBe(1);
	});

	it("a failure after the B2 evidence write is repaired by the projection check", async () => {
		const record = await setupEvaluated();
		const attempt = attemptOf(record);
		const event = buildEvidenceFromAssessment(attempt, "default", new Date("2026-11-03T04:00:00.000Z"));
		// L1 append succeeds and the B2 evidence transition lands, then the process
		// dies before `recordProfileProjected`.
		const written = await recordEventAndUpdateProfile(learnerDir, event);
		const afterEv = await store.recordEvidence("s1.jsonl", "attempt_1", {
			expectedRevision: record.checkpoint.revision,
			event: written.event,
		});

		const res = await finalizeAttempt(deps(), "s1.jsonl", "attempt_1", afterEv.checkpoint.revision);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.attempt.progress.stage).toBe("completed");
		expect(await evidenceCount("attempt_1")).toBe(1);
	});
});
