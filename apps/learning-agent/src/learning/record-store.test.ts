import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionMetaStore } from "../shared/session-meta-store.js";
import { LearningRecordStore } from "./record-store.js";
import type { LearningSessionRecord } from "../memory/learner/types.js";

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

function seedRecord(sessionId: string, record: LearningSessionRecord): Promise<void> {
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
});
