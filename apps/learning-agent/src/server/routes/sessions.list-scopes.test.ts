import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionsRoutes, type SessionsRouteContext } from "./sessions.js";
import { getCurrentSessionId } from "../../agent/pi-runner.js";

vi.mock("../../agent/pi-runner.js", () => ({
	getSession: vi.fn(),
	getCurrentSessionId: vi.fn(() => ""),
	applyWorkspaceCwd: vi.fn(),
	branchSessionBeforeUserMessage: vi.fn(),
	createNewSession: vi.fn(),
	SessionEditError: class extends Error {},
	switchSessionFile: vi.fn(),
	deleteSessionFileInQueue: vi.fn(),
	createNewSessionInQueueSlot: vi.fn(),
}));

/**
 * E4.8f — `/api/sessions` must not disguise an unreadable course store.
 *
 * The list's `course` / `daily_visible` fields are derived from one course-state
 * read. When that read failed the route used to fall back to an empty map,
 * which made every conversation look unclassified and made archived courses
 * vanish — the archive centre would then group them wrongly instead of showing
 * an error. These cases pin the two behaviours: fail loudly on an unreadable
 * store, and keep the existing derivation when it is readable.
 */

let dataDir: string;
let sessionDir: string;

function responseFixture() {
	return Object.assign(new EventEmitter(), {
		destroyed: false,
		writableFinished: false,
		writableEnded: false,
		statusCode: 0,
		setHeader: vi.fn(),
		writeHead(code: number) { this.statusCode = code; return this; },
		end: vi.fn(),
	});
}

function bodyOf(res: ReturnType<typeof responseFixture>): Record<string, unknown> {
	const payload = res.end.mock.calls.at(-1)?.[0];
	return typeof payload === "string" ? JSON.parse(payload) as Record<string, unknown> : {};
}

function context(courseStore: SessionsRouteContext["courseStore"]): SessionsRouteContext {
	return {
		dataDir,
		paths: {} as never,
		workspaceRegistry: { getWorkspace: vi.fn(), bindSession: vi.fn(() => true) } as never,
		parseSessionFile: (filePath: string) => ({
			summary: {
				id: basename(filePath),
				name: basename(filePath),
				createdAt: "2026-11-01T00:00:00.000Z",
				updatedAt: "2026-11-02T00:00:00.000Z",
				messageCount: 2,
				preview: "hello",
				channels: ["web"],
				origin: "web",
			},
			messages: [],
		}),
		sessionRevision: () => "0:0",
		readSessionChannelMetadata: () => ({}),
		sessionChannelMetadataPath: () => join(sessionDir, "channels.json"),
		sessionMetaStore: {
			get: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			readAll: vi.fn(async () => ({})),
		} as never,
		learningRecordStore: { dir: join(dataDir, "learning"), remove: vi.fn(async () => undefined) } as never,
		l2DataDir: join(dataDir, "l2"),
		l2Enabled: false,
		searchL2: null,
		completeModel: vi.fn(),
		checkModelReady: vi.fn(async () => false),
		currentModel: () => null,
		readSessionQuestionMetadata: () => ({}),
		writeSessionQuestionMetadata: vi.fn(),
		recordCurrentSessionChannel: vi.fn(),
		generateSessionTopic: vi.fn(),
		releaseQueueFromQuestionBlockedTurn: vi.fn(),
		sessionFileFromId: (_dir: string, id: string) => join(sessionDir, id),
		runQueueOpWithTimeout: vi.fn(),
		courseStore,
	} as unknown as SessionsRouteContext;
}

async function list(ctx: SessionsRouteContext) {
	const res = responseFixture();
	const handled = await handleSessionsRoutes(
		{} as IncomingMessage,
		res as unknown as ServerResponse,
		"GET",
		"/api/sessions",
		ctx,
	);
	return { handled, status: res.statusCode, body: bodyOf(res) };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getCurrentSessionId).mockReturnValue("");
	dataDir = mkdtempSync(join(tmpdir(), "sessions-list-scopes-"));
	sessionDir = join(dataDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "s1.jsonl"), "");
});

afterEach(() => {
	if (dirname(dataDir) === resolve(tmpdir()) && basename(dataDir).startsWith("sessions-list-scopes-")) {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

describe("GET /api/sessions — course scopes", () => {
	it("returns a retryable 503 instead of an incomplete list when the course store is unreadable", async () => {
		const ctx = context({
			sessionCourseScopes: vi.fn(async () => {
				throw new Error("course state corrupt");
			}),
			removeSessionBinding: vi.fn(async () => undefined),
		} as never);

		const res = await list(ctx);

		expect(res.handled).toBe(true);
		expect(res.status).toBe(503);
		expect(res.body).toMatchObject({ error: "course_scopes_unavailable", retryable: true });
		// No sessions payload at all: a partial list would be grouped wrongly.
		expect(res.body).not.toHaveProperty("sessions");
		expect(Array.isArray(res.body)).toBe(false);
	});

	it("keeps the existing derivation when the course store is readable", async () => {
		const ctx = context({
			sessionCourseScopes: vi.fn(async () => new Map([
				["s1.jsonl", { course_id: "course_a", title: "Python 编程", status: "archived", archived: true, task_id: null }],
			])),
			removeSessionBinding: vi.fn(async () => undefined),
		} as never);

		const res = await list(ctx);

		expect(res.status).toBe(200);
		const rows = res.body as unknown as Array<{
			id: string;
			course: { course_id: string; archived: boolean } | null;
			daily_visible: boolean;
		}>;
		const row = rows.find((item) => item.id === "s1.jsonl");
		expect(row?.course).toMatchObject({ course_id: "course_a", archived: true });
		expect(row?.daily_visible).toBe(false);
	});
});
