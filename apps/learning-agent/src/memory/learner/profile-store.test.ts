import { mkdtemp, readdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests use real files, fsync and child processes; the default 5s ceiling
// is too tight when the whole suite runs in parallel on a busy machine.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
import { createLearningEvidenceEvent } from "./evidence.js";
import {
	LearnerStoreError,
	loadEvents,
	loadProfile,
	loadRecentEvents,
	recordEventAndUpdateProfile,
} from "./profile-store.js";
import { createLearningEvent } from "./types.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-profile-store-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function evidence(key: string, overrides: { result?: "correct" | "partial" | "incorrect" | "unknown"; learner?: string; session?: string } = {}) {
	return createLearningEvidenceEvent(overrides.learner ?? "learner", {
		concept_id: "physics.force_decomposition",
		kind: "application",
		result: overrides.result ?? "correct",
		evaluator: "teacher",
		evaluator_confidence: 1,
		session_id: overrides.session ?? "session-1",
		dedupe_key: key,
	});
}

/** Every event line across the active segment and all archives. */
async function ledgerLines(): Promise<string[]> {
	const files = (await readdir(dir)).filter((name) => /^events\..*\.jsonl$/.test(name) || name === "events.jsonl");
	const lines: string[] = [];
	for (const name of files) {
		const raw = await readFile(join(dir, name), "utf-8");
		lines.push(...raw.split("\n").filter((line) => line.trim()));
	}
	return lines;
}

async function recordsFor(key: string): Promise<number> {
	const lines = await ledgerLines();
	return lines
		.map((line) => JSON.parse(line) as { dedupe_key?: string })
		.filter((event) => event.dedupe_key === key).length;
}

describe("loadRecentEvents", () => {
	it("returns the last N events in order", async () => {
		const events = [];
		for (let i = 0; i < 5; i++) {
			const event = createLearningEvent("learner", "concept_explained", {}, { n: i });
			await recordEventAndUpdateProfile(dir, event);
			events.push(event);
		}
		const recent = await loadRecentEvents(dir, 3);
		expect(recent.map((e) => e.event_id)).toEqual(events.slice(-3).map((e) => e.event_id));
	});

	it("returns everything when fewer than N events exist", async () => {
		const events = [];
		for (let i = 0; i < 2; i++) {
			const event = createLearningEvent("learner", "concept_explained", {}, { n: i });
			await recordEventAndUpdateProfile(dir, event);
			events.push(event);
		}
		expect((await loadRecentEvents(dir, 8)).map((e) => e.event_id)).toEqual(events.map((e) => e.event_id));
	});

	it("returns [] when no events have been recorded", async () => {
		expect(await loadRecentEvents(dir, 8)).toEqual([]);
	});

	it("still sees the tail after the active segment is rotated", async () => {
		const keys: string[] = [];
		for (let i = 0; i < 5; i++) {
			const key = `tail-${i}`;
			keys.push(key);
			await recordEventAndUpdateProfile(dir, evidence(key), { maxBytes: 600 });
		}
		const recent = await loadRecentEvents(dir, 3);
		expect(recent.map((event) => event.dedupe_key)).toEqual(keys.slice(-3));
	});
});

describe("durable deduplication (S2-G1)", () => {
	it("records a retried write once", async () => {
		const first = await recordEventAndUpdateProfile(dir, evidence("attempt-1"));
		const second = await recordEventAndUpdateProfile(dir, evidence("attempt-1"));

		expect(first.status).toBe("recorded");
		expect(second.status).toBe("duplicate");
		expect(second.event.event_id).toBe(first.event.event_id);
		expect(second.event.seq).toBe(first.event.seq);
		expect(await recordsFor("attempt-1")).toBe(1);
	});

	it("serializes concurrent duplicate writes inside one process", async () => {
		const results = await Promise.all([
			recordEventAndUpdateProfile(dir, evidence("attempt-c")),
			recordEventAndUpdateProfile(dir, evidence("attempt-c")),
			recordEventAndUpdateProfile(dir, evidence("attempt-c")),
		]);
		expect(results.filter((result) => result.status === "recorded")).toHaveLength(1);
		expect(await recordsFor("attempt-c")).toBe(1);
		expect(await ledgerLines()).toHaveLength(1);
	});

	it("keeps the key valid across two real rotations", async () => {
		await recordEventAndUpdateProfile(dir, evidence("attempt-rot"), { maxBytes: 500 });
		for (let i = 0; i < 8; i++) {
			await recordEventAndUpdateProfile(dir, evidence(`filler-${i}`), { maxBytes: 500 });
		}
		const archives = (await readdir(dir)).filter((name) => /^events\.\d+-\d+\.jsonl$/.test(name));
		expect(archives.length).toBeGreaterThanOrEqual(2);

		const duplicate = await recordEventAndUpdateProfile(dir, evidence("attempt-rot"), { maxBytes: 500 });
		expect(duplicate.status).toBe("duplicate");
		expect(await recordsFor("attempt-rot")).toBe(1);
	});

	it("rebuilds from history when the cache file is deleted", async () => {
		await recordEventAndUpdateProfile(dir, evidence("attempt-idx"), { maxBytes: 500 });
		for (let i = 0; i < 4; i++) {
			await recordEventAndUpdateProfile(dir, evidence(`filler-${i}`), { maxBytes: 500 });
		}
		await rm(join(dir, "dedupe-index.json"), { force: true });

		// The in-memory index was rebuilt at ownership; deleting the cache file
		// cannot make the key reusable.
		const duplicate = await recordEventAndUpdateProfile(dir, evidence("attempt-idx"));
		expect(duplicate.status).toBe("duplicate");
		expect(await recordsFor("attempt-idx")).toBe(1);
	});

	it("rejects a different answer under the same key without overwriting the original", async () => {
		const first = await recordEventAndUpdateProfile(dir, evidence("attempt-conflict", { result: "correct" }));

		await expect(
			recordEventAndUpdateProfile(dir, evidence("attempt-conflict", { result: "incorrect" })),
		).rejects.toMatchObject({ code: "LEARNING_RECORD_CONFLICT" });

		const events = await loadEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].event_id).toBe(first.event.event_id);
		expect(events[0].evidence?.result).toBe("correct");
	});

	it("allows the same attempt id in another learner or session", async () => {
		await recordEventAndUpdateProfile(dir, evidence("shared-key", { learner: "learner-a", session: "s1" }));
		await recordEventAndUpdateProfile(dir, evidence("shared-key", { learner: "learner-b", session: "s1" }));
		await recordEventAndUpdateProfile(dir, evidence("shared-key", { learner: "learner-a", session: "s2" }));

		expect(await recordsFor("shared-key")).toBe(3);
	});

	it("scores an accepted answer once even when the same write is retried", async () => {
		const first = await recordEventAndUpdateProfile(dir, evidence("attempt-score"));
		const stateAfterFirst = first.profile.knowledge_states[0];
		expect(stateAfterFirst.evidence_ids).toContain(first.event.evidence?.evidence_id);

		await recordEventAndUpdateProfile(dir, evidence("attempt-score"));
		const afterRetry = await loadProfile(dir);

		expect(afterRetry.knowledge_states[0].mastery).toBe(stateAfterFirst.mastery);
		expect(afterRetry.knowledge_states[0].retrieval_count).toBe(1);
		expect(afterRetry.knowledge_states[0].evidence_ids).toEqual(stateAfterFirst.evidence_ids);
	});
});

describe("ledger integrity (S2-G5)", () => {
	it("keeps a provably uncommitted tail out of the ledger and preserves its bytes", async () => {
		await recordEventAndUpdateProfile(dir, evidence("tail-1"));
		await appendFile(join(dir, "events.jsonl"), '{"event_id":"torn"', "utf-8");

		const events = await loadEvents(dir);
		expect(events).toHaveLength(1);

		const preserved = (await readdir(dir)).filter((name) => /^events\.torn-\d+\.bin$/.test(name));
		expect(preserved).toHaveLength(1);

		const next = await recordEventAndUpdateProfile(dir, evidence("tail-2"));
		expect(next.event.seq).toBe(2);
		expect(await ledgerLines()).toHaveLength(2);
	});

	it("stops writing when a committed ledger line is corrupt", async () => {
		await recordEventAndUpdateProfile(dir, evidence("c-1"));
		const before = await readFile(join(dir, "profile.json"), "utf-8");
		await appendFile(join(dir, "events.jsonl"), "this-is-not-json\n", "utf-8");

		await expect(loadEvents(dir)).rejects.toMatchObject({ code: "EVENT_LOG_CORRUPT" });
		await expect(recordEventAndUpdateProfile(dir, evidence("c-2"))).rejects.toMatchObject({
			code: "EVENT_LOG_CORRUPT",
		});
		expect(await readFile(join(dir, "profile.json"), "utf-8")).toBe(before);
	});

	it("refuses to continue when a sealed archive is missing", async () => {
		for (let i = 0; i < 6; i++) {
			await recordEventAndUpdateProfile(dir, evidence(`m-${i}`), { maxBytes: 500 });
		}
		const archives = (await readdir(dir)).filter((name) => /^events\.\d+-\d+\.jsonl$/.test(name));
		expect(archives.length).toBeGreaterThan(0);
		await rm(join(dir, archives[0]), { force: true });

		await expect(loadEvents(dir)).rejects.toMatchObject({ code: "EVENT_LOG_MISSING_SEGMENT" });
		await expect(recordEventAndUpdateProfile(dir, evidence("m-new"))).rejects.toMatchObject({
			code: "EVENT_LOG_MISSING_SEGMENT",
		});
	});

	it("rejects an unsupported manifest schema instead of guessing", async () => {
		await recordEventAndUpdateProfile(dir, evidence("s-1"));
		const manifestPath = join(dir, "events.manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
		manifest.schema_version = 99;
		await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");

		await expect(loadEvents(dir)).rejects.toMatchObject({ code: "EVENT_LOG_CORRUPT" });
	});

	it("stops writing and preserves the original bytes when profile.json is corrupt", async () => {
		await recordEventAndUpdateProfile(dir, evidence("p-1"));
		const profilePath = join(dir, "profile.json");
		await writeFile(profilePath, '{"learner_id": "broken"', "utf-8");

		await expect(loadProfile(dir)).rejects.toMatchObject({ code: "PROFILE_CORRUPT" });
		await expect(recordEventAndUpdateProfile(dir, evidence("p-2"))).rejects.toBeInstanceOf(LearnerStoreError);
		expect(await readFile(profilePath, "utf-8")).toBe('{"learner_id": "broken"');
		expect(await recordsFor("p-1")).toBe(1);
		expect(await recordsFor("p-2")).toBe(0);
	});
});
