import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearSessionCleanup,
	readSessionCleanup,
	readSessionCleanupFile,
	writeSessionCleanup,
} from "./session-cleanup-store.js";

const roots: string[] = [];

async function makeDataDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "inno-session-cleanup-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("session cleanup marker (E4.7-R2a)", () => {
	it("persists one entry per session and keeps independent entries", async () => {
		const dataDir = await makeDataDir();
		await writeSessionCleanup(dataDir, "a.jsonl", ["traces"], "b.jsonl");
		await writeSessionCleanup(dataDir, "c.jsonl", ["attachments"]);

		expect(readSessionCleanup(dataDir, "a.jsonl")).toMatchObject({
			failures: ["traces"],
			new_active_id: "b.jsonl",
		});
		expect(readSessionCleanup(dataDir, "c.jsonl")).toMatchObject({ failures: ["attachments"] });
		expect(readSessionCleanupFile(dataDir)["a.jsonl"]).toBeDefined();
	});

	it("removes only the finished session's marker", async () => {
		const dataDir = await makeDataDir();
		await writeSessionCleanup(dataDir, "a.jsonl", ["traces"]);
		await writeSessionCleanup(dataDir, "c.jsonl", ["attachments"]);

		await clearSessionCleanup(dataDir, "a.jsonl");

		expect(readSessionCleanup(dataDir, "a.jsonl")).toBeUndefined();
		expect(readSessionCleanup(dataDir, "c.jsonl")).toMatchObject({ failures: ["attachments"] });
		// Clearing an absent id is a no-op, not an error.
		await expect(clearSessionCleanup(dataDir, "missing.jsonl")).resolves.toBeUndefined();
	});
});
