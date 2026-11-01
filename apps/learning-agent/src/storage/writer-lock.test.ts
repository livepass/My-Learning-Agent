import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests use real files, fsync and child processes; the default 5s ceiling
// is too tight when the whole suite runs in parallel on a busy machine.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
import { createLearningEvidenceEvent } from "../memory/learner/evidence.js";
import { loadProfile, recordEventAndUpdateProfile, saveProfile } from "../memory/learner/profile-store.js";
import { acquireWriterLock, WRITER_LOCK_FILE } from "./writer-lock.js";

type Worker = ChildProcessByStdio<null, Readable, Readable>;

const fixture = fileURLToPath(new URL("../memory/learner/__fixtures__/l1-worker.ts", import.meta.url));
let dir: string;
const children: Worker[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-writer-lock-"));
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (!child.killed) child.kill("SIGKILL");
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	await rm(dir, { recursive: true, force: true });
});

function startWorker(args: string[]): Worker {
	const child = spawn(process.execPath, ["--import", "tsx", fixture, ...args], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

function waitForLine(child: Worker, needle: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), 30_000);
		child.stdout.on("data", (chunk) => {
			buffer += String(chunk);
			if (buffer.includes(needle)) {
				clearTimeout(timer);
				resolve(buffer.toString());
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`worker exited early (${code})`));
		});
	});
}

function waitForExit(child: Worker): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function runWorker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = startWorker(args);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

function event(key: string) {
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

describe("single writer process (S2-G5)", () => {
	it("refuses a second process, including an alias of the data directory", async () => {
		const child = startWorker(["hold", dir]);
		await waitForLine(child, "READY owner");

		const snapshot = async () => {
			const names = (await readdir(dir)).filter((name) => name !== WRITER_LOCK_FILE).sort();
			const files: Record<string, string> = {};
			for (const name of names) {
				try {
					files[name] = await readFile(join(dir, name), "utf-8");
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EISDIR") continue;
					throw err;
				}
			}
			return files;
		};
		const before = await snapshot();

		// A second process may read, but must not modify business files.
		await mkdir(join(dir, "alias"), { recursive: true });
		await expect(
			recordEventAndUpdateProfile(join(dir, "alias", ".."), event("blocked")),
		).rejects.toMatchObject({ code: "STORE_WRITE_DISABLED" });

		expect(await snapshot()).toEqual(before);

		child.kill("SIGKILL");
		await waitForExit(child);
	});

	it("takes over after the owning process is killed", async () => {
		const child = startWorker(["hold", dir]);
		await waitForLine(child, "READY owner");
		const lockBefore = JSON.parse(await readFile(join(dir, WRITER_LOCK_FILE), "utf-8"));
		expect(lockBefore.pid).toBe(child.pid);

		await expect(
			recordEventAndUpdateProfile(dir, event("after-kill")),
		).rejects.toMatchObject({ code: "STORE_WRITE_DISABLED" });

		child.kill("SIGKILL");
		await waitForExit(child);

		const result = await recordEventAndUpdateProfile(dir, event("after-kill"));
		expect(result.status).toBe("recorded");
		const lockAfter = JSON.parse(await readFile(join(dir, WRITER_LOCK_FILE), "utf-8"));
		expect(lockAfter.pid).not.toBe(lockBefore.pid);
	});

	it("stops writing after the lock is removed underneath the owner", async () => {
		await recordEventAndUpdateProfile(dir, event("before-loss"));
		const profile = await loadProfile(dir);
		const bytes = await readFile(join(dir, "profile.json"), "utf-8");

		await rm(join(dir, WRITER_LOCK_FILE), { force: true });

		await expect(saveProfile(dir, { ...profile, profile_summary: "不该写入" })).rejects.toMatchObject({
			code: "STORE_UNAVAILABLE",
		});
		expect(await readFile(join(dir, "profile.json"), "utf-8")).toBe(bytes);
	});
});

describe("unreadable lock", () => {
	it("fails closed instead of stealing a lock it cannot parse", async () => {
		await writeFile(join(dir, WRITER_LOCK_FILE), "not-a-lock", "utf-8");
		await expect(recordEventAndUpdateProfile(dir, event("garbage-lock"))).rejects.toMatchObject({
			code: "STORE_UNAVAILABLE",
		});
		expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
		// The unreadable file is preserved for the operator.
		expect(await readFile(join(dir, WRITER_LOCK_FILE), "utf-8")).toBe("not-a-lock");
	});
});

describe("same-process acquisition and release (S2-G5)", () => {
	it("returns one token for concurrent acquisitions and keeps double release harmless", async () => {
		const [first, second, third] = await Promise.all([
			acquireWriterLock(dir),
			acquireWriterLock(dir),
			acquireWriterLock(dir),
		]);
		expect(new Set([first.token, second.token, third.token]).size).toBe(1);
		await Promise.all([first.assertOwned(), second.assertOwned(), third.assertOwned()]);

		await first.release();
		await first.release(); // idempotent: must not decrement another handle
		await second.assertOwned();
		await second.release();
		await third.assertOwned();
		await third.release();

		expect(existsSync(join(dir, WRITER_LOCK_FILE))).toBe(false);
	});

	it("orders the last release against a concurrent acquire", async () => {
		const handle = await acquireWriterLock(dir);
		const [, next] = await Promise.all([handle.release(), acquireWriterLock(dir)]);
		await next.assertOwned();
		await next.release();
		expect(existsSync(join(dir, WRITER_LOCK_FILE))).toBe(false);
	});
});

describe("cross-process stale reclaim (S2-G5)", () => {
	it("lets only one concurrent reclaimer commit the record", async () => {
		// A lock left behind by a process that no longer exists.
		await writeFile(join(dir, WRITER_LOCK_FILE), JSON.stringify({
			schema_version: 1,
			token: "stale-token",
			pid: 999_999,
			host: hostname(),
			created_at: new Date(Date.now() - 60_000).toISOString(),
			process_started_at: new Date(Date.now() - 120_000).toISOString(),
			data_dir: dir,
		}, null, 2) + "\n", "utf-8");

		const [left, right] = await Promise.all([
			runWorker(["record", dir, "reclaim-1"]),
			runWorker(["record", dir, "reclaim-1"]),
		]);
		const succeeded = [left, right].filter((result) => result.code === 0);
		expect(succeeded.length).toBeGreaterThanOrEqual(1);
		expect(succeeded.some((result) => result.stdout.includes("DONE recorded 1") || result.stdout.includes("DONE duplicate 1"))).toBe(true);

		const lines = (await readFile(join(dir, "events.jsonl"), "utf-8"))
			.split("\n")
			.filter((line) => line.trim());
		expect(lines).toHaveLength(1);
		const manifest = JSON.parse(await readFile(join(dir, "events.manifest.json"), "utf-8"));
		expect(manifest.next_seq).toBe(2);
	});
});
