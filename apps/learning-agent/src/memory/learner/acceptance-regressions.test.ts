import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadEvents,
	loadProfile,
	mutateProfile,
	rebuildLearnerProjection,
	recoverMissingProfile,
	recordEventAndUpdateProfile,
} from "./profile-store.js";
import { createEvidenceCorrectionEvent, createLearningEvidenceEvent } from "./evidence.js";
import { nextManualStamp } from "./projection.js";
import type { LearningEvent } from "./types.js";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const fixture = fileURLToPath(new URL("./__fixtures__/l1-worker.ts", import.meta.url));
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-l1-acceptance-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function runWorker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", fixture, ...args], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`worker timed out: ${args.join(" ")}`));
		}, 30_000);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

function evidence(key: string, overrides: { result?: "correct" | "incorrect" | "partial" | "unknown"; concept?: string; at?: Date; session?: string } = {}) {
	return createLearningEvidenceEvent("learner", {
		concept_id: overrides.concept ?? "math.fraction",
		kind: "application",
		result: overrides.result ?? "correct",
		evaluator: "teacher",
		evaluator_confidence: 1,
		session_id: overrides.session ?? "s1",
		dedupe_key: key,
	}, overrides.at ?? new Date());
}

const ATTEMPT_MODEL = {
	provider_id: "provider",
	model_id: "model",
	model_version: null,
	version_source: "unavailable" as const,
};

/** Formal evidence carrying the approved attempt tuple. */
function formalEvent(attemptId: string, result: "correct" | "incorrect", options: {
	key?: string;
	session?: string;
	contextSession?: string;
	learner?: string;
} = {}): LearningEvent {
	const learner = options.learner ?? "learner";
	const session = options.session ?? "session-1";
	const event = createLearningEvidenceEvent(learner, {
		concept_id: "math.fraction",
		kind: "application",
		result,
		evaluator: "rubric",
		evaluator_confidence: 1,
		session_id: session,
		dedupe_key: options.key,
	});
	event.context.session_id = options.contextSession ?? session;
	event.evidence!.session_id = session;
	event.evidence!.learner_id = learner;
	event.evidence!.learning_attempt = {
		question_id: "q-1",
		question_version: "1",
		session_id: session,
		attempt_id: attemptId,
		rubric_version: "r-1",
		model: ATTEMPT_MODEL,
		hints: { through_sequence: 0, exposure_ids: [], hint_level: 0, answer_revealed: false },
	};
	return event;
}

describe("formal attempt identity (G1)", () => {
	it("cannot be renamed by a different caller key", async () => {
		const first = await recordEventAndUpdateProfile(dir, formalEvent("attempt-1", "correct", { key: "caller-a" }));
		expect(first.status).toBe("recorded");

		const second = await recordEventAndUpdateProfile(dir, formalEvent("attempt-1", "correct", { key: "caller-b" }));
		expect(second.status).toBe("duplicate");
		expect(second.event.event_id).toBe(first.event.event_id);
		expect(await loadEvents(dir)).toHaveLength(1);
	});

	it("rejects contradictory learner or session fields", async () => {
		await expect(
			recordEventAndUpdateProfile(dir, formalEvent("attempt-2", "correct", { contextSession: "other-session" })),
		).rejects.toMatchObject({ code: "ATTEMPT_IDENTITY_MISMATCH" });

		const mismatchedLearner = formalEvent("attempt-3", "correct");
		mismatchedLearner.evidence!.learner_id = "other-learner";
		await expect(
			recordEventAndUpdateProfile(dir, mismatchedLearner),
		).rejects.toMatchObject({ code: "ATTEMPT_IDENTITY_MISMATCH" });

		expect(await loadEvents(dir)).toHaveLength(0);
	});

	it("treats the same attempt with different content as a conflict", async () => {
		await recordEventAndUpdateProfile(dir, formalEvent("attempt-4", "correct"));
		await expect(
			recordEventAndUpdateProfile(dir, formalEvent("attempt-4", "incorrect")),
		).rejects.toMatchObject({ code: "LEARNING_RECORD_CONFLICT" });
		expect(await loadEvents(dir)).toHaveLength(1);
	});

	it("still honours session scoping for non-formal events", async () => {
		await recordEventAndUpdateProfile(dir, evidence("shared", { session: "s1" }));
		await recordEventAndUpdateProfile(dir, evidence("shared", { session: "s2" }));
		expect(await loadEvents(dir)).toHaveLength(2);
	});
});

describe("dedupe index is never authoritative (G1)", () => {
	it("does not trust an index whose entries were emptied", async () => {
		const first = await runWorker(["record", dir, "idx-1"]);
		expect(first.code, first.stderr).toBe(0);
		const indexPath = join(dir, "dedupe-index.json");
		const index = JSON.parse(await readFile(indexPath, "utf-8"));
		await writeFile(indexPath, JSON.stringify({ ...index, entries: {}, entry_count: 0 }), "utf-8");

		// A fresh process rebuilds from the ledger; the edited cache is ignored.
		const second = await runWorker(["record", dir, "idx-1"]);
		expect(second.code, second.stderr).toBe(0);
		expect(second.stdout).toContain("DONE duplicate 1");
		expect(await loadEvents(dir)).toHaveLength(1);
	});

	it("reports a history conflict instead of keeping the first record", async () => {
		const first = formalEvent("attempt-history", "correct");
		await recordEventAndUpdateProfile(dir, first);

		// Plant a second record with the same formal identity and different
		// content, as an older buggy writer would have produced.
		const duplicate = { ...formalEvent("attempt-history", "incorrect"), event_id: "evt_duplicate" };
		await appendFile(join(dir, "events.jsonl"), `${JSON.stringify({ ...duplicate, seq: 2, schema_version: 3 })}\n`, "utf-8");

		await expect(
			recordEventAndUpdateProfile(dir, evidence("after-conflict")),
		).rejects.toMatchObject({ code: "HISTORY_IDENTITY_CONFLICT" });
	});
});

describe("projection completeness (G2)", () => {
	it("recovers the same complete state a full rebuild produces", async () => {
		const worker = await runWorker(["crash-after-event", dir, "crash-full"]);
		expect(worker.code, worker.stderr).toBe(0);

		const recovered = await loadProfile(dir);
		const before = JSON.stringify(recovered.knowledge_states[0]);

		await rebuildLearnerProjection(dir);
		const rebuilt = await loadProfile(dir);

		expect(JSON.stringify(rebuilt.knowledge_states[0])).toBe(before);
		expect(rebuilt.knowledge_states[0].retrieval_count).toBe(1);
		expect(rebuilt.knowledge_states[0].mastery).toBeGreaterThan(0.05);
	});

	it("keeps time-derived fields consistent across concepts when a later event arrives", async () => {
		await recordEventAndUpdateProfile(dir, evidence("a-1", {
			concept: "math.fraction",
			at: new Date("2026-01-01T00:00:00.000Z"),
		}));
		await recordEventAndUpdateProfile(dir, evidence("b-1", {
			concept: "math.decimal",
			at: new Date("2026-05-01T00:00:00.000Z"),
		}));

		const incremental = await loadProfile(dir);
		const incrementalA = incremental.knowledge_states.find((state) => state.concept_id === "math.fraction");
		await rebuildLearnerProjection(dir);
		const rebuilt = await loadProfile(dir);
		const rebuiltA = rebuilt.knowledge_states.find((state) => state.concept_id === "math.fraction");

		expect(JSON.stringify(rebuiltA)).toBe(JSON.stringify(incrementalA));
		// Every concept's time-derived fields must agree, not only the touched one.
		expect(JSON.stringify(rebuilt.knowledge_states)).toBe(JSON.stringify(incremental.knowledge_states));
		expect(rebuiltA?.retrievability).toBeLessThan(1);
	});
});

describe("human ownership (G3)", () => {
	async function seedGoalEvents(): Promise<void> {
		await recordEventAndUpdateProfile(dir, {
			event_id: "evt_goal_1",
			learner_id: "learner",
			timestamp: "2026-01-01T00:00:00.000Z",
			event_type: "goal_declared",
			context: { goal_id: "goal_guitar" },
			payload: { goal: "吉他" },
		});
		await recordEventAndUpdateProfile(dir, {
			event_id: "evt_goal_2",
			learner_id: "learner",
			timestamp: "2026-01-02T00:00:00.000Z",
			event_type: "goal_declared",
			context: { goal_id: "goal_guitar" },
			payload: { goal_description: "不再学习吉他", action: "archived" },
		});
	}

	it("keeps a manually reactivated goal active across a rebuild", async () => {
		await seedGoalEvents();
		expect((await loadProfile(dir)).goals[0].status).toBe("archived");

		await mutateProfile(dir, (profile) => {
			profile.goals[0].status = "active";
			profile.goals[0].manual = { ...(profile.goals[0].manual ?? {}), status: nextManualStamp(profile) };
			return true;
		});
		await rebuildLearnerProjection(dir);

		expect((await loadProfile(dir)).goals[0].status).toBe("active");
	});

	it("keeps a manually archived goal archived when an older declaration is replayed", async () => {
		await recordEventAndUpdateProfile(dir, {
			event_id: "evt_goal_3",
			learner_id: "learner",
			timestamp: "2026-01-01T00:00:00.000Z",
			event_type: "goal_declared",
			context: { goal_id: "goal_guitar" },
			payload: { goal: "吉他" },
		});
		await mutateProfile(dir, (profile) => {
			profile.goals[0].status = "archived";
			profile.goals[0].manual = { ...(profile.goals[0].manual ?? {}), status: nextManualStamp(profile) };
			return true;
		});
		await rebuildLearnerProjection(dir);

		expect((await loadProfile(dir)).goals[0].status).toBe("archived");
	});

	it("does not resurrect a deleted goal", async () => {
		await recordEventAndUpdateProfile(dir, {
			event_id: "evt_goal_4",
			learner_id: "learner",
			timestamp: "2026-01-01T00:00:00.000Z",
			event_type: "goal_declared",
			context: { goal_id: "goal_guitar" },
			payload: { goal: "吉他" },
		});
		await mutateProfile(dir, (profile) => {
			profile.goals = [];
			profile.deleted_goals = { goal_guitar: nextManualStamp(profile) };
			return true;
		});
		await rebuildLearnerProjection(dir);

		expect((await loadProfile(dir)).goals).toHaveLength(0);
	});

	it("keeps manually edited criteria and preferences over older events", async () => {
		await recordEventAndUpdateProfile(dir, {
			event_id: "evt_goal_pref",
			learner_id: "learner",
			timestamp: "2026-01-01T00:00:00.000Z",
			event_type: "goal_declared",
			context: { goal_id: "goal_guitar" },
			payload: { goal: "吉他" },
			derived_signals: { preference_candidates: ["代码优先"] },
		});
		await mutateProfile(dir, (profile) => {
			profile.goals[0].success_criteria = ["手动标准"];
			profile.goals[0].manual = {
				...(profile.goals[0].manual ?? {}),
				success_criteria: nextManualStamp(profile),
			};
			profile.preferences.explanation_style = ["example_first"];
			profile.preferences.manual = {
				...(profile.preferences.manual ?? {}),
				explanation_style: nextManualStamp(profile),
			};
			return true;
		});
		await rebuildLearnerProjection(dir);

		const profile = await loadProfile(dir);
		expect(profile.goals[0].success_criteria).toEqual(["手动标准"]);
		expect(profile.preferences.explanation_style).toEqual(["example_first"]);
		expect(profile.preferences.explanation_style).not.toContain("code_first");
	});
});

describe("missing profile (G5)", () => {
	it("fails closed instead of silently emptying human fields, then recovers explicitly", async () => {
		await mutateProfile(dir, (profile) => {
			profile.profile_summary = "手写摘要";
			profile.preferences.explanation_style = ["example_first"];
			return true;
		});
		await recordEventAndUpdateProfile(dir, evidence("missing-1"));
		const profilePath = join(dir, "profile.json");
		await rm(profilePath, { force: true });

		await expect(loadProfile(dir)).rejects.toMatchObject({ code: "PROFILE_MISSING" });
		await expect(readFile(profilePath, "utf-8")).rejects.toThrow();

		const recovered = await recoverMissingProfile(dir, {
			acceptManualLoss: true,
			reason: "acceptance test",
		});
		expect(recovered.manual_fields_lost).toBe(true);
		expect(recovered.knowledge_states).toHaveLength(1);
		const state = JSON.parse(await readFile(join(dir, "store-state.json"), "utf-8"));
		expect(state.recovery.accepted_manual_loss).toBe(true);
	});

	it("allows an explicit recovery from a process that booted against the loss", async () => {
		const first = await runWorker(["record", dir, "recover-1"]);
		expect(first.code, first.stderr).toBe(0);
		await rm(join(dir, "profile.json"), { force: true });

		const read = await runWorker(["read", dir]);
		expect(read.code).not.toBe(0);
		expect(read.stderr).toContain("WORKER-ERROR PROFILE_MISSING");

		const recovered = await runWorker(["recover", dir]);
		expect(recovered.code, recovered.stderr).toBe(0);
		expect(recovered.stdout).toContain("RECOVERED true 1");
		const state = JSON.parse(await readFile(join(dir, "store-state.json"), "utf-8"));
		expect(state.recovery.lost_fields).toContain("profile_summary");
	});

	it("refuses an inconsistent directory with history but no marker", async () => {
		const first = await runWorker(["record", dir, "inconsistent-1"]);
		expect(first.code, first.stderr).toBe(0);
		await rm(join(dir, "profile.json"), { force: true });
		await rm(join(dir, "store-state.json"), { force: true });

		// A fresh process cannot classify this as a new directory.
		const second = await runWorker(["record", dir, "inconsistent-2"]);
		expect(second.code).not.toBe(0);
		expect(second.stderr).toContain("WORKER-ERROR STORE_INCONSISTENT");
	});
});

describe("store-state interruption points (G5)", () => {
	it("resumes an interrupted first initialisation", async () => {
		const first = await runWorker(["record", dir, "init-1"]);
		expect(first.code, first.stderr).toBe(0);

		// Crash after the marker was written and the profile lost before ready.
		await rm(join(dir, "profile.json"), { force: true });
		const state = JSON.parse(await readFile(join(dir, "store-state.json"), "utf-8"));
		await writeFile(join(dir, "store-state.json"), JSON.stringify({ ...state, profile_state: "initializing" }), "utf-8");

		const resumed = await runWorker(["read", dir]);
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.stdout).toContain("READY 1 1");
		const after = JSON.parse(await readFile(join(dir, "store-state.json"), "utf-8"));
		expect(after.profile_state).toBe("ready");
	});

	it("promotes a profile written before the ready flag", async () => {
		const first = await runWorker(["record", dir, "init-2"]);
		expect(first.code, first.stderr).toBe(0);
		const state = JSON.parse(await readFile(join(dir, "store-state.json"), "utf-8"));
		await writeFile(join(dir, "store-state.json"), JSON.stringify({ ...state, profile_state: "initializing" }), "utf-8");

		const resumed = await runWorker(["read", dir]);
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.stdout).toContain("READY 1 1");
		const after = JSON.parse(await readFile(join(dir, "store-state.json"), "utf-8"));
		expect(after.profile_state).toBe("ready");
	});
});

describe("ledger integrity (G5)", () => {
	it("stops writing when the active prefix is modified without changing its size", async () => {
		await recordEventAndUpdateProfile(dir, evidence("same-size-1"));
		const path = join(dir, "events.jsonl");
		const raw = await readFile(path, "utf-8");
		await writeFile(path, "!" + raw.slice(1), "utf-8");

		await expect(
			recordEventAndUpdateProfile(dir, evidence("same-size-2")),
		).rejects.toMatchObject({ code: "EVENT_LOG_CORRUPT" });
		expect(await readFile(path, "utf-8")).toBe("!" + raw.slice(1));
	});

	it("adopts an append that committed before the manifest update", async () => {
		await recordEventAndUpdateProfile(dir, evidence("lag-1"));
		const extra = { ...evidence("lag-2"), event_id: "evt_lag_2", seq: 2, schema_version: 3 };
		await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(extra)}\n`, "utf-8");

		const events = await loadEvents(dir);
		expect(events.map((event) => event.seq)).toEqual([1, 2]);
		const profile = await loadProfile(dir);
		expect(profile.projection?.applied_seq).toBe(2);
		expect(profile.knowledge_states[0].retrieval_count).toBe(2);
	});
});

describe("correction retries (G1)", () => {
	it("treats an identical correction retry as duplicate before chain validation", async () => {
		const recorded = await recordEventAndUpdateProfile(dir, evidence("corr-base"));
		const evidenceId = recorded.event.evidence!.evidence_id;
		const first = createEvidenceCorrectionEvent("learner", {
			evidence_id: evidenceId,
			corrected_result: "incorrect",
			reason: "人工复核",
		});
		await recordEventAndUpdateProfile(dir, first);
		const retry = createEvidenceCorrectionEvent("learner", {
			evidence_id: evidenceId,
			corrected_result: "incorrect",
			reason: "人工复核",
		});
		expect(retry.correction?.correction_id).toBe(first.correction?.correction_id);

		const result = await recordEventAndUpdateProfile(dir, retry);
		expect(result.status).toBe("duplicate");
		expect(await loadEvents(dir)).toHaveLength(2);
	});

	it("rejects a different revision without an explicit supersedes", async () => {
		const recorded = await recordEventAndUpdateProfile(dir, evidence("corr-base-2"));
		const evidenceId = recorded.event.evidence!.evidence_id;
		await recordEventAndUpdateProfile(dir, createEvidenceCorrectionEvent("learner", {
			evidence_id: evidenceId,
			corrected_result: "incorrect",
			reason: "第一次复核",
		}));
		await expect(
			recordEventAndUpdateProfile(dir, createEvidenceCorrectionEvent("learner", {
				evidence_id: evidenceId,
				corrected_result: "partial",
				reason: "第二次复核",
			})),
		).rejects.toMatchObject({ code: "CORRECTION_CONFLICT" });
		expect(await loadEvents(dir)).toHaveLength(2);
	});
});
