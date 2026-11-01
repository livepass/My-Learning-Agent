import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetaError, SessionMetaStore } from "./session-meta-store.js";

// Real files, fsync and a child process; the default 5s ceiling is too tight
// when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type Worker = ChildProcessByStdio<Writable, Readable, Readable>;

const lockFixture = fileURLToPath(new URL("./__fixtures__/meta-lock-worker.ts", import.meta.url));
let dir: string;
const stores: SessionMetaStore[] = [];
const children: Worker[] = [];

function metaPath(): string {
	return join(dir, "sessions", "meta.json");
}

function openStore(now?: () => Date): SessionMetaStore {
	const store = new SessionMetaStore({ dataDir: dir, now });
	stores.push(store);
	return store;
}

async function seedLegacy(entries: Record<string, unknown>): Promise<void> {
	await mkdir(join(dir, "sessions"), { recursive: true });
	await writeFile(join(dir, "sessions", "meta.json"), JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

async function rawMeta(): Promise<string> {
	return readFile(metaPath(), "utf-8");
}

function startLockWorker(dataDir: string): Worker {
	const child = spawn(process.execPath, ["--import", "tsx", lockFixture, dataDir], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

function waitForLine(child: Worker, needle: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), 30_000);
		child.stdout.on("data", (chunk) => {
			buffer += String(chunk);
			if (buffer.includes(needle)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", () => {
			clearTimeout(timer);
			reject(new Error("lock worker exited early"));
		});
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-session-meta-"));
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (!child.killed) child.kill("SIGKILL");
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	for (const store of stores.splice(0)) await store.close();
	await rm(dir, { recursive: true, force: true });
});

describe("SessionMetaStore", () => {
	it("reads historical topic entries without migrating them", async () => {
		await seedLegacy({
			"s1.jsonl": { topic: "旧标题", updatedAt: "2026-01-01T00:00:00.000Z", generated: true },
		});
		const store = openStore();
		const entry = await store.get("s1.jsonl");
		expect(entry?.topic).toBe("旧标题");
		expect(entry?.generated).toBe(true);
		// Untouched on disk until a write actually happens.
		expect(JSON.parse(await rawMeta())["s1.jsonl"]).toEqual({
			topic: "旧标题",
			updatedAt: "2026-01-01T00:00:00.000Z",
			generated: true,
		});
	});

	it("keeps the learning projection when the title changes", async () => {
		const store = openStore();
		await store.setLearningProjection("s1.jsonl", { revision: 3, pending_attempt_id: "a1" });
		const afterTitle = await store.setTopic("s1.jsonl", "新标题", { generated: false });
		expect(afterTitle.topic).toBe("新标题");
		expect(afterTitle.generated).toBe(false);
		expect(afterTitle.learning).toEqual({ revision: 3, pending_attempt_id: "a1" });
	});

	it("keeps the title when the learning projection changes and merges fields", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "标题", { generated: true });
		await store.setLearningProjection("s1.jsonl", { revision: 1, step: "answer_saved" });
		const merged = await store.setLearningProjection("s1.jsonl", { revision: 2 });
		expect(merged.topic).toBe("标题");
		expect(merged.generated).toBe(true);
		expect(merged.learning).toEqual({ revision: 2, step: "answer_saved" });
	});

	it("preserves unknown legacy fields across a patch", async () => {
		await seedLegacy({ "s1.jsonl": { topic: "旧", updatedAt: "2026-01-01T00:00:00.000Z", pinned: true } });
		const store = openStore();
		const entry = await store.setTopic("s1.jsonl", "新");
		expect((entry as unknown as { pinned?: boolean }).pinned).toBe(true);
		expect(entry.topic).toBe("新");
	});

	it("serializes concurrent updates without losing a field", async () => {
		const store = openStore();
		const tasks: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			tasks.push(i % 2 === 0
				? store.setTopic("s1.jsonl", `标题${i}`)
				: store.setLearningProjection("s1.jsonl", { [`k${i}`]: i }));
		}
		await Promise.all(tasks);
		const entry = await store.get("s1.jsonl");
		expect(entry?.rev).toBe(20);
		expect(entry?.topic).toMatch(/^标题\d+$/);
		for (let i = 1; i < 20; i += 2) {
			expect(entry?.learning?.[`k${i}`]).toBe(i);
		}
		// Two independent stores on the same file in one process share the queue.
		const second = openStore();
		const afterSecond = await second.setLearningProjection("s1.jsonl", { late: true });
		expect(afterSecond.rev).toBe(21);
		expect(afterSecond.topic).toMatch(/^标题\d+$/);
	});

	it("reloads after a restart and continues the revision sequence", async () => {
		const first = openStore();
		await first.setTopic("s1.jsonl", "重启前");
		await first.setLearningProjection("s1.jsonl", { revision: 7 });
		await first.close();

		const restarted = openStore();
		const entry = await restarted.get("s1.jsonl");
		expect(entry?.topic).toBe("重启前");
		expect(entry?.learning).toEqual({ revision: 7 });
		expect(entry?.rev).toBe(2);
		const next = await restarted.setTopic("s1.jsonl", "重启后");
		expect(next.rev).toBe(3);
		expect(next.learning).toEqual({ revision: 7 });
	});

	it("rejects a stale expectedRev without touching the file", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "第一版");
		const before = await rawMeta();
		await expect(store.setTopic("s1.jsonl", "过期写入", { expectedRev: 0 })).rejects.toMatchObject({
			code: "META_CONFLICT",
			currentRev: 1,
		});
		expect(await rawMeta()).toBe(before);
	});

	it("refuses to overwrite corrupt metadata", async () => {
		await mkdir(join(dir, "sessions"), { recursive: true });
		await writeFile(metaPath(), "{ not json", "utf-8");
		const store = openStore();
		await expect(store.setTopic("s1.jsonl", "标题")).rejects.toBeInstanceOf(SessionMetaError);
		await expect(store.setTopic("s1.jsonl", "标题")).rejects.toMatchObject({ code: "META_CORRUPT" });
		expect(await rawMeta()).toBe("{ not json");
	});

	it("separates a read failure from an empty file", async () => {
		// A directory where the file should be: reading it is EISDIR, which must
		// stay distinct from "file absent" instead of degrading to an empty map.
		await mkdir(metaPath(), { recursive: true });
		const store = openStore();
		await expect(store.readAll()).rejects.toMatchObject({ code: "META_UNREADABLE" });
		await expect(store.setTopic("s1.jsonl", "标题")).rejects.toMatchObject({ code: "META_UNREADABLE" });
	});

	it("removes one entry and leaves the file untouched for an unknown id", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "一");
		await store.setTopic("s2.jsonl", "二");
		expect(await store.remove("missing.jsonl")).toBe(false);
		const before = await rawMeta();
		expect(await store.remove("missing.jsonl")).toBe(false);
		expect(await rawMeta()).toBe(before);

		expect(await store.remove("s1.jsonl")).toBe(true);
		const remaining = await store.readAll();
		expect(Object.keys(remaining)).toEqual(["s2.jsonl"]);
	});

	it("refuses to write while another process owns the data directory", async () => {
		const child = startLockWorker(dir);
		await waitForLine(child, "LOCKED");

		const store = openStore();
		await expect(store.setTopic("s1.jsonl", "并发写")).rejects.toMatchObject({ code: "META_WRITER_LOCK" });
		expect(await store.readAll()).toEqual({});

		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));

		// Stale lock of a dead process is reclaimed, then the write goes through.
		const entry = await store.setTopic("s1.jsonl", "并发写");
		expect(entry.topic).toBe("并发写");
	});
});
