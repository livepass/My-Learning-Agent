import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests use real files, fsync and child processes; the default 5s ceiling
// is too tight when the whole suite runs in parallel on a busy machine.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
import { createEvidenceCorrectionEvent, createLearningEvidenceEvent } from "./evidence.js";
import { loadEvents, loadProfile, mutateProfile, rebuildLearnerProjection, recordEventAndUpdateProfile } from "./profile-store.js";
import type { LearningEvent } from "./types.js";
import { stableStringify } from "../../utils/stable-json.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-l1-rebuild-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function evidence(key: string, result: "correct" | "incorrect" | "partial" = "correct", conceptId = "math.fraction"): LearningEvent {
	return createLearningEvidenceEvent("learner", {
		concept_id: conceptId,
		kind: "application",
		result,
		evaluator: "teacher",
		evaluator_confidence: 1,
		session_id: "s1",
		dedupe_key: key,
	});
}

function correction(evidenceId: string, result: "correct" | "incorrect" | "partial", key: string, supersedes?: string): LearningEvent {
	return createEvidenceCorrectionEvent("learner", {
		evidence_id: evidenceId,
		corrected_result: result,
		reason: "人工复核",
		dedupe_key: key,
		supersedes,
	});
}

describe("full rebuild (S2-G3)", () => {
	it("replays two archives plus the active segment and preserves manual fields", async () => {
		await mutateProfile(dir, (profile) => {
			profile.goals.push({
				goal_id: "goal_manual",
				title: "手动目标",
				type: "skill",
				priority: 0.6,
				status: "paused",
				success_criteria: ["手动标准"],
				source: "user_declared",
				updated_at: "2026-10-01T00:00:00.000Z",
			});
			profile.preferences.explanation_style = ["example_first"];
			profile.profile_summary = "用户手写摘要";
			profile.knowledge_states.push({
				concept_id: "legacy.topic",
				concept_name: "旧值",
				domain: "legacy",
				mastery: 0.42,
				confidence: 0.5,
				stability: 0.3,
				evidence_ids: [],
				diagnosis: "旧数据，无来源",
				next_actions: [],
			});
			return true;
		});

		for (let i = 0; i < 6; i++) {
			await recordEventAndUpdateProfile(dir, evidence(`e-${i}`), { maxBytes: 500 });
		}
		await recordEventAndUpdateProfile(dir, evidence("e-final", "incorrect"), { maxBytes: 500 });
		const archives = (await readdir(dir)).filter((name) => /^events\.\d+-\d+\.jsonl$/.test(name));
		expect(archives.length).toBeGreaterThanOrEqual(2);

		const report = await rebuildLearnerProjection(dir);
		expect(report.events).toBe(7);
		expect(report.lastSeq).toBe(7);
		expect(report.corrections).toBe(0);

		const profile = await loadProfile(dir);
		expect(profile.goals[0]).toMatchObject({ goal_id: "goal_manual", status: "paused" });
		expect(profile.goals[0].success_criteria).toEqual(["手动标准"]);
		expect(profile.preferences.explanation_style).toEqual(["example_first"]);
		expect(profile.profile_summary).toBe("用户手写摘要");
		expect(profile.derived_summary).toContain("math.fraction");

		const legacy = profile.knowledge_states.find((state) => state.concept_id === "legacy.topic");
		expect(legacy?.mastery).toBe(0.42);
		expect(legacy?.provenance_unknown).toBe(true);
		expect(report.preservedLegacyStates).toBe(1);

		const derived = profile.knowledge_states.find((state) => state.concept_id === "math.fraction");
		expect(derived?.origin).toBe("derived");
		expect(derived?.retrieval_count).toBe(7);
		expect(derived?.lapse_count).toBe(1);
		expect(profile.projection?.applied_seq).toBe(7);
	});

	it("is idempotent: a second rebuild writes nothing", async () => {
		for (let i = 0; i < 3; i++) {
			await recordEventAndUpdateProfile(dir, evidence(`i-${i}`), { maxBytes: 500 });
		}
		const first = await rebuildLearnerProjection(dir);
		expect(first.changed).toBe(true);
		const afterFirst = await loadProfile(dir);
		const bytes = await readFile(join(dir, "profile.json"), "utf-8");

		const second = await rebuildLearnerProjection(dir);
		expect(second.changed).toBe(false);
		expect(await readFile(join(dir, "profile.json"), "utf-8")).toBe(bytes);
		expect(stableStringify(await loadProfile(dir))).toBe(stableStringify(afterFirst));
		expect(await loadEvents(dir)).toHaveLength(3);
	});

	it("applies a correction to the effective evidence instead of adding a second attempt", async () => {
		const recorded = await recordEventAndUpdateProfile(dir, evidence("corrected-1"));
		const evidenceId = recorded.event.evidence?.evidence_id;
		expect(evidenceId).toBeTruthy();
		await rebuildLearnerProjection(dir);
		const before = (await loadProfile(dir)).knowledge_states[0];
		expect(before.retrieval_count).toBe(1);
		expect(before.lapse_count).toBe(0);
		expect(before.last_result).toBe("correct");

		await recordEventAndUpdateProfile(dir, correction(evidenceId!, "incorrect", "correction-1"));

		const events = await loadEvents(dir);
		expect(events).toHaveLength(2);
		const after = (await loadProfile(dir)).knowledge_states[0];
		expect(after.retrieval_count).toBe(1);
		expect(after.lapse_count).toBe(1);
		expect(after.last_result).toBe("incorrect");
		// The correction rewrites the effective value of the *same* evidence; it
		// must not append a second evidence entry or a second score.
		expect(after.evidence_ids).toEqual(before.evidence_ids);
		expect(after.evidence_ids).toContain(evidenceId);
		expect(after.mastery).toBeLessThan(before.mastery);

		const report = await rebuildLearnerProjection(dir);
		expect(report.corrections).toBe(1);
		expect(stableStringify((await loadProfile(dir)).knowledge_states[0])).toBe(stableStringify(after));
	});

	it("replays a stored correction chain without double-scoring it", async () => {
		const recorded = await recordEventAndUpdateProfile(dir, evidence("chain-1"));
		const evidenceId = recorded.event.evidence!.evidence_id;
		await recordEventAndUpdateProfile(dir, correction(evidenceId, "partial", "chain-c1"));
		const once = (await loadProfile(dir)).knowledge_states[0];
		expect(once.last_result).toBe("partial");

		await rebuildLearnerProjection(dir);
		await rebuildLearnerProjection(dir);
		const twice = (await loadProfile(dir)).knowledge_states[0];
		expect(stableStringify(twice)).toBe(stableStringify(once));
		expect(twice.retrieval_count).toBe(1);
	});

	it("rejects an ambiguous second correction before it reaches the ledger", async () => {
		const recorded = await recordEventAndUpdateProfile(dir, evidence("conflict-1"));
		const evidenceId = recorded.event.evidence!.evidence_id;
		await recordEventAndUpdateProfile(dir, correction(evidenceId, "incorrect", "conflict-c1"));
		const bytes = await readFile(join(dir, "profile.json"), "utf-8");

		await expect(
			recordEventAndUpdateProfile(dir, correction(evidenceId, "partial", "conflict-c2")),
		).rejects.toMatchObject({ code: "CORRECTION_CONFLICT" });

		expect(await loadEvents(dir)).toHaveLength(2);
		expect(await readFile(join(dir, "profile.json"), "utf-8")).toBe(bytes);
	});

	it("rejects a correction that references unknown evidence", async () => {
		await recordEventAndUpdateProfile(dir, evidence("unknown-1"));
		await expect(
			recordEventAndUpdateProfile(dir, correction("evd_missing", "incorrect", "unknown-c1")),
		).rejects.toMatchObject({ code: "CORRECTION_CONFLICT" });
		expect(await loadEvents(dir)).toHaveLength(1);
	});

	it("refuses to rebuild and leaves the profile untouched when an archive is missing", async () => {
		for (let i = 0; i < 6; i++) {
			await recordEventAndUpdateProfile(dir, evidence(`gap-${i}`), { maxBytes: 500 });
		}
		const archives = (await readdir(dir)).filter((name) => /^events\.\d+-\d+\.jsonl$/.test(name));
		expect(archives.length).toBeGreaterThan(0);
		const bytes = await readFile(join(dir, "profile.json"), "utf-8");
		await rm(join(dir, archives[0]), { force: true });

		await expect(rebuildLearnerProjection(dir)).rejects.toMatchObject({ code: "EVENT_LOG_MISSING_SEGMENT" });
		expect(await readFile(join(dir, "profile.json"), "utf-8")).toBe(bytes);
	});

	it("refuses to overwrite a corrupt profile with a rebuild result", async () => {
		await recordEventAndUpdateProfile(dir, evidence("corrupt-1"));
		await writeFile(join(dir, "profile.json"), "{not json", "utf-8");

		await expect(rebuildLearnerProjection(dir)).rejects.toMatchObject({ code: "PROFILE_CORRUPT" });
		expect(await readFile(join(dir, "profile.json"), "utf-8")).toBe("{not json");
	});
});
