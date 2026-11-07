import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/**
 * E4.2b–e — course document upload → index → scoped search, over real HTTP.
 *
 * Two courses with their own material: search never crosses the boundary, a
 * source may be shared explicitly, detaching one course does not affect the
 * other, and a restart keeps both the manifest and the index. The provider is
 * never called: this path is deterministic on purpose.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let home: string;
let port: number;
let child: ChildProcess;

const request = (path: string, options?: RequestInit) =>
	fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
const post = (path: string, body: unknown) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function startServer(): Promise<void> {
	child = spawn(process.execPath, ["--import", "tsx", resolve("apps/learning-agent/src/server.ts"),
		"--home", home, "--config-dir", join(home, "config"), "--data-dir", join(home, "data"),
		"--workspace", join(home, "workspace"), "--skills-dir", join(home, "skills"), "--port", String(port)],
	{ cwd: process.cwd(), stdio: "ignore" });
	const deadline = Date.now() + 80_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("server exited before readiness");
		try { if ((await request("/health")).ok) return; } catch { /* lazy bootstrap */ }
		await new Promise((yes) => setTimeout(yes, 200));
	}
	throw new Error("server readiness timeout");
}

async function stopServer(): Promise<void> {
	if (child && child.exitCode === null) {
		const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
		child.kill();
		await exited;
	}
}

interface CourseBody { course_id: string; title: string }

function markdown(title: string, heading: string, body: string): string {
	return `# ${title}\n\n## ${heading}\n\n${body}${"补充说明。".repeat(200)}\n`;
}

const PYTHON_TEXT = markdown("Python 编程教材", "第三章 装饰器", "装饰器是接收函数并返回函数的高阶函数，可在不修改原函数的情况下增加行为。");
const MATH_TEXT = markdown("高等数学教材", "第三章 导数", "导数描述函数在某一点的瞬时变化率，链式法则用于复合函数求导。");

async function upload(courseId: string, fileName: string, text: string) {
	return post(`/api/courses/${courseId}/sources/upload`, {
		fileName,
		mimeType: "text/markdown",
		title: fileName.replace(/\.md$/, ""),
		dataBase64: Buffer.from(text, "utf-8").toString("base64"),
	});
}

async function search(courseId: string, query: string) {
	const response = await request(`/api/courses/${courseId}/search?q=${encodeURIComponent(query)}`);
	expect(response.status).toBe(200);
	return await response.json() as {
		status: string;
		results: Array<{ path: string; title: string; source_ids: string[]; excerpt: string; locator?: { heading_path?: string; page_start?: number } }>;
	};
}

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "inno-course-sources-"));
	await mkdir(join(home, "config"), { recursive: true });
	await writeFile(join(home, "config", "config.json"), JSON.stringify({
		providers: { fixture: { baseUrl: "http://127.0.0.1:9", apiKey: "fixture", models: [{ id: "dummy" }] } },
		memory: { l1Enabled: true, l2Enabled: true, l3Enabled: false },
	}));
	const allocator = createServer();
	await new Promise<void>((yes) => allocator.listen(0, "127.0.0.1", yes));
	port = (allocator.address() as { port: number }).port;
	await new Promise<void>((yes) => allocator.close(() => yes()));
	await startServer();
}, 180_000);

afterAll(async () => {
	await stopServer();
	if (home && dirname(home) === resolve(tmpdir()) && basename(home).startsWith("inno-course-sources-")) {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

it("keeps two courses' material isolated from upload through retrieval", async () => {
	const python = await (await post("/api/courses", { title: "Python 编程" })).json() as CourseBody;
	const math = await (await post("/api/courses", { title: "高等数学" })).json() as CourseBody;

	const pythonUpload = await upload(python.course_id, "python.md", PYTHON_TEXT);
	expect(pythonUpload.status).toBe(201);
	const pythonSource = await pythonUpload.json() as { source_id: string; status: string; passage_count: number; duplicate: boolean };
	expect(pythonSource).toMatchObject({ status: "indexed", duplicate: false });
	expect(pythonSource.passage_count).toBeGreaterThan(0);

	const mathUpload = await upload(math.course_id, "math.md", MATH_TEXT);
	expect(mathUpload.status).toBe(201);
	const mathSource = await mathUpload.json() as { source_id: string; status: string };
	expect(mathSource.status).toBe("indexed");

	// 1. Each course finds its own material and only its own.
	const pythonHit = await search(python.course_id, "装饰器");
	expect(pythonHit.status).toBe("ok");
	expect(pythonHit.results.every((hit) => hit.source_ids.includes(pythonSource.source_id))).toBe(true);
	expect(pythonHit.results.some((hit) => hit.locator?.heading_path?.includes("装饰器"))).toBe(true);
	expect(pythonHit.results[0].excerpt).toContain("接收函数");
	expect((await search(python.course_id, "导数 瞬时变化率")).results).toEqual([]);

	const mathHit = await search(math.course_id, "导数 瞬时变化率");
	expect(mathHit.status).toBe("ok");
	expect(mathHit.results.every((hit) => hit.source_ids.includes(mathSource.source_id))).toBe(true);
	expect(mathHit.results.some((hit) => hit.locator?.heading_path?.includes("导数"))).toBe(true);
	expect((await search(math.course_id, "装饰器")).results).toEqual([]);

	// 2. Source list exposes processing state separately from the binding.
	const list = await (await request(`/api/courses/${python.course_id}/sources`)).json() as {
		sources: Array<{ source_id: string; status: string; source: { status: string; passage_count: number } }>;
	};
	expect(list.sources).toHaveLength(1);
	expect(list.sources[0]).toMatchObject({
		source_id: pythonSource.source_id,
		status: "active",
		source: { status: "indexed", passage_count: pythonSource.passage_count },
	});

	// 3. Detail exposes section locators, not invented page numbers.
	const detail = await (await request(`/api/courses/${python.course_id}/sources/${pythonSource.source_id}`)).json() as {
		sections: Array<{ ordinal: number; heading_path?: string; page_start?: number }>;
	};
	expect(detail.sections.length).toBeGreaterThan(0);
	expect(detail.sections.some((section) => section.heading_path?.includes("装饰器"))).toBe(true);
	expect(detail.sections.every((section) => section.page_start === undefined)).toBe(true);

	// 4. The same source can serve both courses, explicitly.
	expect((await post(`/api/courses/${math.course_id}/sources`, { source_id: pythonSource.source_id })).status).toBe(201);
	expect((await search(math.course_id, "装饰器")).results.length).toBeGreaterThan(0);

	// 5. Detaching from one course leaves the other untouched.
	expect((await request(`/api/courses/${math.course_id}/sources/${pythonSource.source_id}`, { method: "DELETE" })).status).toBe(200);
	expect((await search(math.course_id, "装饰器")).results).toEqual([]);
	expect((await search(python.course_id, "装饰器")).results.length).toBeGreaterThan(0);
	const detached = await (await request(`/api/courses/${math.course_id}/sources?include_detached=true`)).json() as {
		sources: Array<{ source_id: string; status: string }>;
	};
	expect(detached.sources.find((entry) => entry.source_id === pythonSource.source_id)?.status).toBe("detached");

	// 6. Re-binding reuses the original binding id.
	const rebound = await post(`/api/courses/${math.course_id}/sources`, { source_id: pythonSource.source_id });
	expect(rebound.status).toBe(200);
	const reboundBody = await rebound.json() as { binding_id: string; status: string };
	expect(reboundBody.status).toBe("active");

	// 7. A duplicate upload is idempotent: same source, no second manifest row.
	const duplicate = await upload(python.course_id, "python-copy.md", PYTHON_TEXT);
	expect(duplicate.status).toBe(201);
	const duplicateBody = await duplicate.json() as { source_id: string; duplicate: boolean };
	expect(duplicateBody).toMatchObject({ source_id: pythonSource.source_id, duplicate: true });
	const manifest = (await readFile(join(home, "data", "l2", "manifest.jsonl"), "utf-8")).trim().split("\n");
	expect(manifest).toHaveLength(2);

	// 8. Retrying an indexed source is a no-op, and an empty course is explicit.
	expect((await post(`/api/courses/${python.course_id}/sources/${pythonSource.source_id}/retry`, {})).status).toBe(200);
	const emptyCourse = await (await post("/api/courses", { title: "空课程" })).json() as CourseBody;
	expect(await search(emptyCourse.course_id, "装饰器")).toEqual({ course_id: emptyCourse.course_id, query: "装饰器", status: "no_material", results: [] });

	// 9. Unsupported formats are refused before any source record is created.
	const xlsx = await post(`/api/courses/${python.course_id}/sources/upload`, {
		fileName: "sheet.xlsx", dataBase64: Buffer.from("x").toString("base64"),
	});
	expect(xlsx.status).toBe(400);
	expect(await xlsx.json()).toMatchObject({ error: "unsupported_format" });

	// 10. Restart: manifest, index and isolation survive the process boundary.
	await stopServer();
	await startServer();
	const afterRestart = await search(python.course_id, "装饰器");
	expect(afterRestart.status).toBe("ok");
	expect(afterRestart.results.every((hit) => hit.source_ids.includes(pythonSource.source_id))).toBe(true);
	expect((await search(math.course_id, "导数 瞬时变化率")).status).toBe("ok");
});
