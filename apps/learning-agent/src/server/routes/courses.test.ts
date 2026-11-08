import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourseStore } from "../../courses/course-store.js";
import type { RuntimePaths } from "../../runtime.js";
import { handleCoursesRoutes, type CoursesRouteContext } from "./courses.js";

/**
 * E4.1 HTTP contract for /api/courses.
 *
 * The handler is exercised in-process against a real `CourseStore` and real
 * session/L2 files, so the tests pin what the API actually does: explicit
 * ownership only, 「未归类」 for records without a binding, idempotent retries,
 * and refusal of cross-course re-association.
 */

const roots: string[] = [];

async function makeContext(): Promise<{ ctx: CoursesRouteContext; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-courses-http-"));
	roots.push(root);
	const dataDir = join(root, "data");
	const paths: RuntimePaths = {
		codeDir: root,
		configDir: join(root, "config"),
		configPath: join(root, "config", "config.json"),
		dataDir,
		learnerDataDir: join(dataDir, "learner"),
		sessionDir: join(dataDir, "sessions"),
		l2DataDir: join(dataDir, "l2"),
		l3DataDir: join(dataDir, "l3"),
		skillsDir: join(root, "skills"),
		workspaceDir: join(root, "workspace"),
		webDistDir: join(root, "web-dist"),
	};
	await mkdir(paths.sessionDir, { recursive: true });
	await mkdir(paths.l2DataDir, { recursive: true });
	const courseStore = new CourseStore({ dataDir });
	return {
		root,
		ctx: {
			courseStore,
			paths,
			sessionExists: async (sessionId: string) => existsSync(join(paths.sessionDir, sessionId)),
		},
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Captured {
	status: number;
	body: unknown;
}

async function call(
	ctx: CoursesRouteContext,
	method: string,
	url: string,
	body?: unknown,
): Promise<Captured> {
	let status = 0;
	let payload: unknown;
	const res: Record<string, unknown> = {
		destroyed: false,
		writableEnded: false,
		writeHead: (code: number) => { status = code; return res; },
		// `json()` serializes the payload and passes it as the single argument.
		end: (value?: string) => {
			res.writableEnded = true;
			payload = value ? JSON.parse(value) : undefined;
			return res;
		},
	};
	const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]) as IncomingMessage;
	req.headers = {};
	const handled = await handleCoursesRoutes(req, res as unknown as ServerResponse, method, url, ctx);
	expect(handled, `${method} ${url} must be handled by the courses domain`).toBe(true);
	return { status, body: payload };
}

describe("course CRUD", () => {
	it("creates, lists, updates and archives a course over HTTP", async () => {
		const { ctx } = await makeContext();
		const created = await call(ctx, "POST", "/api/courses", { title: "Python 编程", description: "从语法到项目" });
		expect(created.status).toBe(201);
		const course = created.body as { course_id: string; status: string };
		expect(course.status).toBe("in_progress");

		const listed = await call(ctx, "GET", "/api/courses");
		expect(listed.status).toBe(200);
		expect((listed.body as { courses: unknown[] }).courses).toHaveLength(1);

		const patched = await call(ctx, "PATCH", `/api/courses/${course.course_id}`, { title: "Python 编程入门", status: "paused" });
		expect(patched.status).toBe(200);
		expect(patched.body).toMatchObject({ title: "Python 编程入门", status: "paused" });

		const archived = await call(ctx, "POST", `/api/courses/${course.course_id}/archive`);
		expect(archived.status).toBe(200);
		expect(archived.body).toMatchObject({ status: "archived" });

		const missing = await call(ctx, "GET", "/api/courses/course_missing");
		expect(missing.status).toBe(404);
	});

	it("rejects an invalid status and an empty title with 400", async () => {
		const { ctx } = await makeContext();
		expect((await call(ctx, "POST", "/api/courses", { title: "ok", status: "deleted" })).status).toBe(400);
		expect((await call(ctx, "POST", "/api/courses", { title: "" })).status).toBe(400);
	});
});

describe("explicit ownership", () => {
	it("reports sessions and sources without a binding as unclassified", async () => {
		const { ctx, root } = await makeContext();
		await writeFile(join(ctx.paths.sessionDir, "legacy.jsonl"), "", "utf-8");
		await writeFile(join(ctx.paths.sessionDir, "bound.jsonl"), "", "utf-8");
		await writeFile(join(ctx.paths.l2DataDir, "manifest.jsonl"), JSON.stringify({
			id: "l2src_shared", title: "线性代数讲义", sourceType: "markdown", rawPath: "raw/a.md",
			wikiPages: [], tags: [], contentHash: "hash", status: "indexed",
			source: { origin: "user_upload" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		}) + "\n", "utf-8");

		const course = (await call(ctx, "POST", "/api/courses", { title: "高等数学" })).body as { course_id: string };
		await call(ctx, "POST", `/api/courses/${course.course_id}/sessions`, { session_id: "bound.jsonl", origin: "free_question" });
		await call(ctx, "POST", `/api/courses/${course.course_id}/sources`, { source_id: "l2src_shared" });

		const unclassified = await call(ctx, "GET", "/api/courses/unclassified");
		expect(unclassified.body).toEqual({ sessions: ["legacy.jsonl"], sources: [] });

		const binding = await call(ctx, "GET", "/api/courses/bindings/session/legacy.jsonl");
		expect(binding.body).toMatchObject({ session_id: "legacy.jsonl", unclassified: true, binding: null, course: null });
		const bound = await call(ctx, "GET", "/api/courses/bindings/session/bound.jsonl");
		expect(bound.body).toMatchObject({ unclassified: false, course: { course_id: course.course_id } });
		void root;
	});

	it("never infers a course from a session title or content", async () => {
		const { ctx } = await makeContext();
		// A session whose topic literally names a course is still unclassified:
		// nothing in the API reads titles to decide ownership.
		await writeFile(join(ctx.paths.sessionDir, "python-tutorial.jsonl"), "{\"role\":\"user\",\"content\":\"Python 编程课程\"}\n", "utf-8");
		await call(ctx, "POST", "/api/courses", { title: "Python 编程" });
		const unclassified = await call(ctx, "GET", "/api/courses/unclassified");
		expect((unclassified.body as { sessions: string[] }).sessions).toEqual(["python-tutorial.jsonl"]);
	});
});

describe("binding rules", () => {
	it("is idempotent on retry and refuses a cross-course re-association", async () => {
		const { ctx } = await makeContext();
		await writeFile(join(ctx.paths.sessionDir, "s1.jsonl"), "", "utf-8");
		const python = (await call(ctx, "POST", "/api/courses", { title: "Python 编程" })).body as { course_id: string };
		const math = (await call(ctx, "POST", "/api/courses", { title: "高等数学" })).body as { course_id: string };

		const first = await call(ctx, "POST", `/api/courses/${python.course_id}/sessions`, { session_id: "s1.jsonl", origin: "free_question" });
		expect(first.status).toBe(201);
		const retry = await call(ctx, "POST", `/api/courses/${python.course_id}/sessions`, { session_id: "s1.jsonl", origin: "free_question" });
		expect(retry.status).toBe(200);
		expect((retry.body as { binding_id: string }).binding_id).toBe((first.body as { binding_id: string }).binding_id);

		const moved = await call(ctx, "POST", `/api/courses/${math.course_id}/sessions`, { session_id: "s1.jsonl" });
		expect(moved.status).toBe(409);
		expect((await call(ctx, "GET", `/api/courses/${python.course_id}/sessions`)).body).toMatchObject({
			sessions: [expect.objectContaining({ session_id: "s1.jsonl" })],
		});
		expect((await call(ctx, "GET", `/api/courses/${math.course_id}/sessions`)).body).toEqual({ sessions: [] });
	});

	it("refuses to bind a session that does not exist", async () => {
		const { ctx } = await makeContext();
		const course = (await call(ctx, "POST", "/api/courses", { title: "Python 编程" })).body as { course_id: string };
		const result = await call(ctx, "POST", `/api/courses/${course.course_id}/sessions`, { session_id: "ghost.jsonl" });
		expect(result.status).toBe(404);
	});

	it("offers a source already bound to another course as a candidate (E4.6a)", async () => {
		const { ctx } = await makeContext();
		const manifest = [
			{ id: "l2src_python", title: "Python 教材", sourceType: "markdown", rawPath: "raw/p.md", wikiPages: [], passagePages: ["a", "b"], tags: [], contentHash: "h1", status: "indexed", source: { origin: "user_upload" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
			{ id: "l2src_loose", title: "散落的笔记", sourceType: "markdown", rawPath: "raw/n.md", wikiPages: [], tags: [], contentHash: "h2", status: "indexed", source: { origin: "user_upload" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
			{ id: "l2src_broken", title: "坏文件", sourceType: "pdf", rawPath: "raw/b.pdf", wikiPages: [], tags: [], contentHash: "h3", status: "error", error: "解析失败", source: { origin: "user_upload" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
		];
		await writeFile(join(ctx.paths.l2DataDir, "manifest.jsonl"), manifest.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");

		const python = (await call(ctx, "POST", "/api/courses", { title: "Python 编程" })).body as { course_id: string };
		const math = (await call(ctx, "POST", "/api/courses", { title: "高等数学" })).body as { course_id: string };
		await call(ctx, "POST", `/api/courses/${python.course_id}/sources`, { source_id: "l2src_python" });

		const candidates = await call(ctx, "GET", `/api/courses/${math.course_id}/source-candidates`);
		expect(candidates.status).toBe(200);
		const rows = (candidates.body as { sources: Array<Record<string, unknown>> }).sources;
		// Unindexed/failed material is not usable material, so it is not offered.
		expect(rows.map((row) => row.source_id)).toEqual(["l2src_loose", "l2src_python"]);
		const shared = rows.find((row) => row.source_id === "l2src_python")!;
		expect(shared.bound_to_current).toBe(false);
		expect(shared.courses).toEqual([{ course_id: python.course_id, title: "Python 编程" }]);
		expect(shared.passage_count).toBe(2);

		// Attaching it leaves the first course's binding intact: one document, two courses.
		expect((await call(ctx, "POST", `/api/courses/${math.course_id}/sources`, { source_id: "l2src_python" })).status).toBe(201);
		expect((await call(ctx, "GET", `/api/courses/${python.course_id}/sources`)).body).toMatchObject({
			sources: [expect.objectContaining({ source_id: "l2src_python", status: "active" })],
		});
		expect((await call(ctx, "GET", `/api/courses/${math.course_id}/sources`)).body).toMatchObject({
			sources: [expect.objectContaining({ source_id: "l2src_python", status: "active" })],
		});
		// A source the course already owns is no longer a candidate.
		expect(((await call(ctx, "GET", `/api/courses/${math.course_id}/source-candidates`)).body as { sources: unknown[] }).sources)
			.toEqual([expect.objectContaining({ source_id: "l2src_loose" })]);
	});

	it("refuses to bind a source that is not in the L2 manifest", async () => {
		const { ctx } = await makeContext();
		const course = (await call(ctx, "POST", "/api/courses", { title: "Python 编程" })).body as { course_id: string };
		const result = await call(ctx, "POST", `/api/courses/${course.course_id}/sources`, { source_id: "l2src_missing" });
		expect(result.status).toBe(404);
	});

	it("binds goals explicitly and refuses a task from another course's plan", async () => {
		const { ctx } = await makeContext();
		const python = (await call(ctx, "POST", "/api/courses", { title: "Python 编程" })).body as { course_id: string };
		const math = (await call(ctx, "POST", "/api/courses", { title: "高等数学" })).body as { course_id: string };

		const goal = await call(ctx, "POST", `/api/courses/${python.course_id}/goals`, { goal_id: "goal_abc" });
		expect(goal.status).toBe(201);
		expect((await call(ctx, "POST", `/api/courses/${python.course_id}/goals`, { goal_id: "goal_abc" })).status).toBe(200);
		expect((await call(ctx, "DELETE", `/api/courses/${python.course_id}/goals/goal_abc`)).status).toBe(200);

		const plan = (await call(ctx, "POST", `/api/courses/${math.course_id}/plans`, { title: "数学计划" })).body as { plan_id: string };
		const crossed = await call(ctx, "POST", `/api/courses/${python.course_id}/tasks`, { title: "错位任务", plan_id: plan.plan_id });
		expect(crossed.status).toBe(409);
	});
});
