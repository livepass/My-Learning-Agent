import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectReplacementSession } from "./session-replacement.js";
import type { SessionSummary } from "./session-model.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-replacement-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function summary(id: string, messageCount: number, updatedAt: string): { summary: SessionSummary } {
	return {
		summary: {
			id, name: id, createdAt: updatedAt, updatedAt, messageCount,
			preview: "", channels: ["web"], origin: "web",
		},
	};
}

describe("selectReplacementSession", () => {
	it("picks the newest visible, unarchived conversation", () => {
		mkdirSync(join(dir, "nested"), { recursive: true });
		for (const file of ["a.jsonl", "b.jsonl", "c.jsonl", "blank.jsonl", "archived.jsonl"]) {
			writeFileSync(join(dir, file), "");
		}
		const summaries: Record<string, ReturnType<typeof summary>> = {
			"a.jsonl": summary("a.jsonl", 4, "2026-11-04T00:00:00.000Z"),
			"b.jsonl": summary("b.jsonl", 2, "2026-11-02T00:00:00.000Z"),
			"c.jsonl": summary("c.jsonl", 1, "2026-11-03T00:00:00.000Z"),
			"blank.jsonl": summary("blank.jsonl", 0, "2026-11-05T00:00:00.000Z"),
			"archived.jsonl": summary("archived.jsonl", 9, "2026-11-06T00:00:00.000Z"),
		};
		const selected = selectReplacementSession({
			sessionsDir: dir,
			excludeId: "a.jsonl",
			archiveMetadata: { "archived.jsonl": true },
			parseSessionFile: (path) => summaries[basename(path)] ?? null,
			isBlocked: () => false,
		});
		expect(selected?.id).toBe("c.jsonl");
	});

	it("returns null when every candidate is blank, archived or blocked", () => {
		for (const file of ["a.jsonl", "blank.jsonl", "archived.jsonl", "blocked.jsonl"]) {
			writeFileSync(join(dir, file), "");
		}
		const summaries = {
			"a.jsonl": summary("a.jsonl", 4, "2026-11-04T00:00:00.000Z"),
			"blank.jsonl": summary("blank.jsonl", 0, "2026-11-05T00:00:00.000Z"),
			"archived.jsonl": summary("archived.jsonl", 9, "2026-11-06T00:00:00.000Z"),
			"blocked.jsonl": summary("blocked.jsonl", 9, "2026-11-06T00:00:00.000Z"),
		};
		expect(selectReplacementSession({
			sessionsDir: dir,
			excludeId: "a.jsonl",
			archiveMetadata: { "archived.jsonl": true },
			parseSessionFile: (path) => summaries[basename(path) as keyof typeof summaries] ?? null,
			isBlocked: (id) => id === "blocked.jsonl",
		})).toBeNull();
	});

	it("returns null for a missing sessions directory", () => {
		expect(selectReplacementSession({
			sessionsDir: join(dir, "missing"),
			excludeId: "a.jsonl",
			archiveMetadata: {},
			parseSessionFile: () => null,
			isBlocked: () => false,
		})).toBeNull();
	});
});

describe("E4.7-R2a — archived-course candidates", () => {
	it("skips a conversation whose parent course is archived", () => {
		for (const file of ["a.jsonl", "b.jsonl", "c.jsonl"]) writeFileSync(join(dir, file), "");
		const summaries: Record<string, ReturnType<typeof summary>> = {
			"a.jsonl": summary("a.jsonl", 4, "2026-11-04T00:00:00.000Z"),
			// Newest candidate, but its course is archived: hidden from daily study.
			"b.jsonl": summary("b.jsonl", 4, "2026-11-06T00:00:00.000Z"),
			"c.jsonl": summary("c.jsonl", 3, "2026-11-05T00:00:00.000Z"),
		};
		const selected = selectReplacementSession({
			sessionsDir: dir,
			excludeId: "a.jsonl",
			archiveMetadata: {},
			parseSessionFile: (path) => summaries[basename(path)] ?? null,
			isBlocked: () => false,
			isExcluded: (id) => id === "b.jsonl",
		});
		expect(selected?.id).toBe("c.jsonl");
	});

	it("returns null when every candidate is excluded", () => {
		for (const file of ["a.jsonl", "b.jsonl"]) writeFileSync(join(dir, file), "");
		const summaries = {
			"a.jsonl": summary("a.jsonl", 4, "2026-11-04T00:00:00.000Z"),
			"b.jsonl": summary("b.jsonl", 4, "2026-11-06T00:00:00.000Z"),
		};
		expect(selectReplacementSession({
			sessionsDir: dir,
			excludeId: "a.jsonl",
			archiveMetadata: {},
			parseSessionFile: (path) => summaries[basename(path) as keyof typeof summaries] ?? null,
			isBlocked: () => false,
			isExcluded: () => true,
		})).toBeNull();
	});
});
