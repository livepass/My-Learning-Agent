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

	it("keeps the title when the learning projection is replaced, not merged", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "标题", { generated: true });
		await store.setLearningProjection("s1.jsonl", { revision: 1, step: "answer_saved" });
		// Whole-replace: `step` is dropped because the new projection omits it.
		const replaced = await store.setLearningProjection("s1.jsonl", { revision: 2 });
		expect(replaced.topic).toBe("标题");
		expect(replaced.generated).toBe(true);
		expect(replaced.learning).toEqual({ revision: 2 });
	});

	it("preserves unknown legacy fields across a patch", async () => {
		await seedLegacy({ "s1.jsonl": { topic: "旧", updatedAt: "2026-01-01T00:00:00.000Z", pinned: true } });
		const store = openStore();
		const entry = await store.setTopic("s1.jsonl", "新");
		expect((entry as unknown as { pinned?: boolean }).pinned).toBe(true);
		expect(entry.topic).toBe("新");
	});

	it("serializes concurrent title and learning writes without dropping either field", async () => {
		const store = openStore();
		const tasks: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			tasks.push(i % 2 === 0
				? store.setTopic("s1.jsonl", `标题${i}`)
				: store.setLearningProjection("s1.jsonl", { revision: i, note: `k${i}` }));
		}
		await Promise.all(tasks);
		const entry = await store.get("s1.jsonl");
		expect(entry?.rev).toBe(20);
		// The title survives every interleaved learning write, and vice versa:
		// the last learning write (whole-replace) is intact, not merged away.
		expect(entry?.topic).toMatch(/^标题\d+$/);
		expect(entry?.learning).toMatchObject({ revision: 19, note: "k19" });
		// Two independent stores on the same file in one process share the queue.
		const second = openStore();
		const afterSecond = await second.setLearningProjection("s1.jsonl", { late: true });
		expect(afterSecond.rev).toBe(21);
		expect(afterSecond.topic).toMatch(/^标题\d+$/);
		expect(afterSecond.learning).toEqual({ late: true });
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

	it("explicit null deletes the projection while undefined leaves it untouched", async () => {
		const store = openStore();
		await store.setLearningProjection("s1.jsonl", { revision: 1, step: "answer_saved" });

		// `undefined` must not erase state.
		const afterUndefined = await store.setLearningProjection("s1.jsonl", undefined as unknown as null);
		expect(afterUndefined.learning).toEqual({ revision: 1, step: "answer_saved" });

		// A nested undefined value is dropped, not serialised, and does not clear siblings.
		const afterNested = await store.setLearningProjection("s1.jsonl", { revision: 2, step: undefined });
		expect(afterNested.learning).toEqual({ revision: 2 });

		// Only an explicit null deletes the whole projection.
		const afterNull = await store.setLearningProjection("s1.jsonl", null);
		expect(afterNull.learning).toBeUndefined();
	});

	it("whole-replace removes fields omitted from the new checkpoint", async () => {
		const store = openStore();
		await store.setLearningProjection("s1.jsonl", { revision: 1, step: "awaiting_answer", pending_attempt_id: "a1" });
		const replaced = await store.setLearningProjection("s1.jsonl", { revision: 2, step: "feedback" });
		expect(replaced.learning).toEqual({ revision: 2, step: "feedback" });
		expect(replaced.learning).not.toHaveProperty("pending_attempt_id");
	});

	it("close drains in-flight writes and then refuses new ones", async () => {
		const store = openStore();
		// Fire a write without awaiting it; close() must let it finish.
		const pending = store.setTopic("s1.jsonl", "收尾");
		await store.close();
		await pending; // the enqueued write completed before the lock was released
		const after = await store.readAll();
		expect(after["s1.jsonl"].topic).toBe("收尾");

		// A write after close is refused.
		await expect(store.setTopic("s1.jsonl", "关闭后")).rejects.toMatchObject({ code: "META_CLOSED" });
	});

	it("a write enqueued on another instance drains before close releases the lock", async () => {
		const first = openStore();
		const second = openStore();
		const pending = second.setTopic("s1.jsonl", "另一实例");
		await first.close();
		await pending;
		expect((await first.readAll())["s1.jsonl"].topic).toBe("另一实例");
	});

	it("setAutoTopic applies only when the title is still auto-generated", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "自动预览", { generated: true });
		const applied = await store.setAutoTopic("s1.jsonl", "更丰富标题", { upgraded: true, sessionExists: () => true });
		expect(applied.applied).toBe(true);
		expect(applied.entry?.topic).toBe("更丰富标题");
		expect(applied.entry?.upgraded).toBe(true);

		// After a manual rename (generated: false), auto-update no longer applies.
		await store.setTopic("s1.jsonl", "手动改的", { generated: false });
		const skipped = await store.setAutoTopic("s1.jsonl", "不该出现", { sessionExists: () => true });
		expect(skipped.applied).toBe(false);
		expect(skipped.entry?.topic).toBe("手动改的");
	});

	it("setAutoTopic creates the first auto title for a brand-new session", async () => {
		const store = openStore();
		// No meta entry exists yet: the very first auto title must persist.
		const first = await store.setAutoTopic("new.jsonl", "首次自动标题", { sessionExists: () => true });
		expect(first.applied).toBe(true);
		expect(first.entry?.topic).toBe("首次自动标题");
		expect(first.entry?.generated).toBe(true);
		expect(first.entry?.rev).toBe(1);
		const stored = (await store.readAll())["new.jsonl"];
		expect(stored.topic).toBe("首次自动标题");
	});

	it("setAutoTopic does not create an entry for a session deleted mid-generation", async () => {
		const store = openStore();
		// The session file is already gone when the late title write commits.
		const result = await store.setAutoTopic("gone.jsonl", "迟到标题", { sessionExists: () => false });
		expect(result.applied).toBe(false);
		expect(result.entry).toBeUndefined();
		expect((await store.readAll())["gone.jsonl"]).toBeUndefined();
	});

	it("setAutoTopic does not resurrect a deleted session", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "预览", { generated: true });
		await store.remove("s1.jsonl");
		// The delete flow removes the chat file first, so the probe is false here.
		const result = await store.setAutoTopic("s1.jsonl", "复活标题", { sessionExists: () => false });
		expect(result.applied).toBe(false);
		expect(result.entry).toBeUndefined();
		expect((await store.readAll())["s1.jsonl"]).toBeUndefined();
	});

	it("an unrelated learning projection write does not block a legal auto title", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "预览", { generated: true });
		// A projection write bumps the whole-entry rev; the auto title must still win.
		await store.setLearningProjection("s1.jsonl", { revision: 7, step: "awaiting_answer" });
		const applied = await store.setAutoTopic("s1.jsonl", "更丰富标题", { upgraded: true, sessionExists: () => true });
		expect(applied.applied).toBe(true);
		expect(applied.entry?.topic).toBe("更丰富标题");
		expect(applied.entry?.learning).toEqual({ revision: 7, step: "awaiting_answer" });
	});

	it("a pure projection deletion against a missing entry is a no-op", async () => {
		const store = openStore();
		// No entry exists; deleting the projection must not create an empty one.
		await store.setLearningProjection("s1.jsonl", null);
		expect((await store.readAll())["s1.jsonl"]).toBeUndefined();
	});

	it("a write started before close finishes even when close is in-flight", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "初值");
		// Start a write, then immediately close: the accepted write must complete.
		const pending = store.setTopic("s1.jsonl", "关闭前接受");
		const closed = store.close();
		await Promise.all([pending, closed]);
		expect((await store.readAll())["s1.jsonl"].topic).toBe("关闭前接受");
	});

	it("onlyIfNewerLearningRevision never lets an older projection roll back a newer one", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "标题");
		await store.setLearningProjection("s1.jsonl", { revision: 5, step: "feedback" });
		// An older snapshot (revision 3) must be dropped by the monotonic guard.
		const after = await store.setLearningProjection("s1.jsonl", { revision: 3, step: "conversation" }, { onlyIfNewerLearningRevision: true });
		expect(after.learning).toEqual({ revision: 5, step: "feedback" });
		// An equal revision is also skipped (nothing newer to write).
		const equal = await store.setLearningProjection("s1.jsonl", { revision: 5, step: "other" }, { onlyIfNewerLearningRevision: true });
		expect(equal.learning).toEqual({ revision: 5, step: "feedback" });
		// A genuinely newer revision does apply.
		const newer = await store.setLearningProjection("s1.jsonl", { revision: 6, step: "feedback" }, { onlyIfNewerLearningRevision: true });
		expect(newer.learning).toEqual({ revision: 6, step: "feedback" });
	});

	it("a learning-only entry still gets its first auto title, keeping the projection", async () => {
		const store = openStore();
		// Initialising the learning record creates the entry before any title.
		await store.setLearningProjection("s1.jsonl", { revision: 1, status: "active", step: "conversation" });
		expect((await store.get("s1.jsonl"))?.topic).toBeUndefined();

		const result = await store.setAutoTopic("s1.jsonl", "首次自动标题", { sessionExists: () => true });
		expect(result.applied).toBe(true);
		expect(result.entry?.topic).toBe("首次自动标题");
		expect(result.entry?.generated).toBe(true);
		// A first title is not an upgrade.
		expect(result.entry?.upgraded).toBeUndefined();
		// The learning projection survives the title write.
		expect(result.entry?.learning).toEqual({ revision: 1, status: "active", step: "conversation" });
	});

	it("a manual title still wins over a late auto title on a learning-only entry", async () => {
		const store = openStore();
		await store.setLearningProjection("s1.jsonl", { revision: 1 });
		await store.setTopic("s1.jsonl", "用户手改的标题", { generated: false });
		const result = await store.setAutoTopic("s1.jsonl", "不该覆盖", { sessionExists: () => true });
		expect(result.applied).toBe(false);
		expect((await store.get("s1.jsonl"))?.topic).toBe("用户手改的标题");
	});

	it("an existing auto preview can be upgraded, and only once", async () => {
		const store = openStore();
		await store.setTopic("s1.jsonl", "旧预览", { generated: true });
		const upgraded = await store.setAutoTopic("s1.jsonl", "更丰富标题", { upgraded: true, sessionExists: () => true });
		expect(upgraded.applied).toBe(true);
		expect(upgraded.entry?.upgraded).toBe(true);
		// A second upgrade attempt is refused.
		const again = await store.setAutoTopic("s1.jsonl", "再升级", { upgraded: true, sessionExists: () => true });
		expect(again.applied).toBe(false);
		expect((await store.get("s1.jsonl"))?.topic).toBe("更丰富标题");
	});
});
