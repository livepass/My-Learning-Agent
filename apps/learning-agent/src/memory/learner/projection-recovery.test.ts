import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests use real files, fsync and child processes; the default 5s ceiling
// is too tight when the whole suite runs in parallel on a busy machine.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
import { loadEvents, loadProfile, mutateProfile, rebuildLearnerProjection, recordEventAndUpdateProfile } from "./profile-store.js";
import { createLearningEvidenceEvent } from "./evidence.js";
import { createDefaultProfile } from "./types.js";

const fixture = fileURLToPath(new URL("./__fixtures__/l1-worker.ts", import.meta.url));
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-l1-recovery-"));
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

function evidence(key: string) {
	return createLearningEvidenceEvent("learner", {
		concept_id: "math.fraction",
		kind: "application",
		result: "correct",
		evaluator: "teacher",
		evaluator_confidence: 1,
		session_id: "s1",
		dedupe_key: key,
	});
}

describe("cross-process idempotency (S2-G1)", () => {
	it("does not record or score the same answer twice after a real restart", async () => {
		const first = await runWorker(["record", dir, "restart-1"]);
		expect(first.code, first.stderr).toBe(0);
		expect(first.stdout).toContain("DONE recorded 1");

		const second = await runWorker(["record", dir, "restart-1"]);
		expect(second.code, second.stderr).toBe(0);
		expect(second.stdout).toContain("DONE duplicate 1");

		const events = await loadEvents(dir);
		expect(events).toHaveLength(1);
		const profile = await loadProfile(dir);
		expect(profile.projection?.applied_seq).toBe(1);
		expect(profile.knowledge_states[0].retrieval_count).toBe(1);
		expect(profile.knowledge_states[0].evidence_ids).toContain(events[0].evidence?.evidence_id);
	});
});

describe("projection recovery (S2-G2)", () => {
	it("projects an event that was committed before the profile, without a resubmission", async () => {
		const worker = await runWorker(["crash-after-event", dir, "crash-1"]);
		expect(worker.code, worker.stderr).toBe(0);
		expect(worker.stdout).toContain("CRASHED 1");

		const profile = await loadProfile(dir);
		const events = await loadEvents(dir);
		expect(events).toHaveLength(1);
		expect(profile.projection?.applied_seq).toBe(1);
		expect(profile.knowledge_states[0].evidence_ids).toContain(events[0].event_id);
	});

	it("survives two interrupted writes and still applies each event once", async () => {
		const firstCrash = await runWorker(["crash-after-event", dir, "crash-a"]);
		expect(firstCrash.code, firstCrash.stderr).toBe(0);
		const secondCrash = await runWorker(["crash-after-event", dir, "crash-b"]);
		expect(secondCrash.code, secondCrash.stderr).toBe(0);

		const profile = await loadProfile(dir);
		const events = await loadEvents(dir);
		expect(events.map((event) => event.seq)).toEqual([1, 2]);
		expect(profile.projection?.applied_seq).toBe(2);
		expect(profile.knowledge_states[0].evidence_ids).toEqual(
			expect.arrayContaining(events.map((event) => event.event_id)),
		);

		// A third open must be a no-op: no duplicated evidence, no new version.
		const again = await loadProfile(dir);
		expect(again.projection?.applied_seq).toBe(2);
		expect(again.version).toBe(profile.version);
	});

	it("keeps manual fields while repairing the projection", async () => {
		const seeded = createDefaultProfile();
		seeded.goals.push({
			goal_id: "goal_manual",
			title: "手动目标",
			type: "skill",
			priority: 0.7,
			status: "paused",
			success_criteria: ["能独立完成"],
			source: "user_declared",
			updated_at: "2026-10-01T00:00:00.000Z",
		});
		seeded.profile_summary = "用户手写的摘要";
		await writeFile(join(dir, "profile.json"), JSON.stringify(seeded, null, 2) + "\n", "utf-8");

		const manualCrash = await runWorker(["crash-after-event", dir, "crash-manual"]);
		expect(manualCrash.code, manualCrash.stderr).toBe(0);

		const profile = await loadProfile(dir);
		expect(profile.profile_summary).toBe("用户手写的摘要");
		expect(profile.goals[0]).toMatchObject({ goal_id: "goal_manual", status: "paused" });
		expect(profile.projection?.applied_seq).toBe(1);
	});

	it("replays a profile write that never landed exactly once", async () => {
		await recordEventAndUpdateProfile(dir, evidence("lost-1"));
		const snapshot = await readFile(join(dir, "profile.json"), "utf-8");

		await recordEventAndUpdateProfile(dir, evidence("lost-2"));
		const expected = await loadProfile(dir);
		expect(expected.projection?.applied_seq).toBe(2);

		// Simulate the atomic replace never happening: the file still holds the
		// state from before event 2, including the older cursor.
		await writeFile(join(dir, "profile.json"), snapshot, "utf-8");

		const recovered = await loadProfile(dir);
		expect(recovered.projection?.applied_seq).toBe(2);
		expect(recovered.knowledge_states[0].mastery).toBe(expected.knowledge_states[0].mastery);
		expect(recovered.knowledge_states[0].evidence_ids).toEqual(expected.knowledge_states[0].evidence_ids);
		expect(recovered.version).toBeGreaterThan(1);
	});

	it("refuses a cursor that is ahead of the ledger instead of inventing history", async () => {
		await recordEventAndUpdateProfile(dir, evidence("ahead-1"));
		await mutateProfile(dir, (profile) => {
			profile.projection = { applied_seq: 99, rule_version: 1 };
			return true;
		});

		await expect(loadProfile(dir)).rejects.toMatchObject({ code: "PROJECTION_CONFLICT" });
	});

	it("projects an event committed after the empty profile was initialised", async () => {
		const worker = await runWorker(["crash-after-event", dir, "missing-1"]);
		expect(worker.code, worker.stderr).toBe(0);

		// Bootstrap now persists an explicit empty profile, so the crash leaves a
		// real profile with a stale cursor instead of no file at all.
		await expect(readFile(join(dir, "profile.json"), "utf-8")).resolves.toContain("\"projection\"");

		const profile = await loadProfile(dir);
		expect(profile.knowledge_states).toHaveLength(1);
		expect(profile.projection?.applied_seq).toBe(1);

		const rebuild = await rebuildLearnerProjection(dir);
		expect(rebuild.changed).toBe(false);
	});
});
