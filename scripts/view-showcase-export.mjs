#!/usr/bin/env node
/**
 * View exported showcase cases without touching apps/showcase/public/cases.
 *
 * Serves apps/showcase/dist (the built replay site) with a cases overlay:
 * requests under /cases/ are answered from the overlay dir first (cases you
 * exported via the product's "导出为回放案例" button or
 * `npm run showcase:export -- --session … --out <dir>`), falling back to the
 * built-in published cases. /cases/index.json merges both (overlay wins by
 * case id).
 *
 * Usage:
 *   node scripts/view-showcase-export.mjs [--cases <dir>] [--port <N>] [--build] [--no-open]
 *   npm run showcase:view [-- --cases <dir> …]
 *
 * Defaults: --cases runtime/data/showcase-exports/cases --port 4175
 * Builds apps/showcase/dist automatically when missing (or with --build).
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const distDir = join(repoRoot, "apps/showcase/dist");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const casesDir = resolve(flag("cases", join(repoRoot, "runtime/data/showcase-exports/cases")));
const port = Number(flag("port", "4175"));
const noOpen = args.includes("--no-open");

if (args.includes("--build") || !existsSync(join(distDir, "index.html"))) {
	console.log("[view] building showcase (apps/showcase/dist)…");
	const res = spawnSync("npm", ["run", "showcase:build"], { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
	if (res.status !== 0) process.exit(res.status ?? 1);
}
if (!existsSync(casesDir)) {
	console.warn(`[view] cases dir does not exist yet: ${casesDir}`);
	console.warn("[view] export one first: product sidebar → 导出为回放案例, or");
	console.warn("[view]   npm run showcase:export -- --session <file-or-substring> --out " + casesDir);
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".pdf": "application/pdf",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
	".ico": "image/x-icon",
};

function readCaseIndex(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "index.json"), "utf-8"));
		return Array.isArray(parsed?.cases) ? parsed.cases : [];
	} catch {
		return [];
	}
}

function sendFile(res, filePath) {
	const ext = extname(filePath).toLowerCase();
	res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" });
	res.end(readFileSync(filePath));
}

/** Resolve `rel` inside `root`, refusing path escapes. Returns null if missing. */
function resolveInside(root, rel) {
	const full = normalize(join(root, rel));
	if (!full.startsWith(root)) return null;
	return existsSync(full) && statSync(full).isFile() ? full : null;
}

const server = createServer((req, res) => {
	const url = decodeURIComponent((req.url ?? "/").split("?")[0]);

	if (url === "/cases/index.json") {
		// Merge built-in cases with overlay cases; overlay wins by id.
		const byId = new Map();
		for (const entry of readCaseIndex(join(distDir, "cases"))) byId.set(entry.id, entry);
		for (const entry of readCaseIndex(casesDir)) byId.set(entry.id, entry);
		res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
		res.end(JSON.stringify({ cases: [...byId.values()] }));
		return;
	}

	if (url.startsWith("/cases/")) {
		const rel = url.slice("/cases/".length);
		const overlay = resolveInside(casesDir, rel);
		if (overlay) return sendFile(res, overlay);
		const builtin = resolveInside(join(distDir, "cases"), rel);
		if (builtin) return sendFile(res, builtin);
		res.writeHead(404).end("not found");
		return;
	}

	// Static site; hash routing means every page is index.html.
	const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
	const file = resolveInside(distDir, rel) ?? join(distDir, "index.html");
	sendFile(res, file);
});

server.listen(port, () => {
	const target = `http://localhost:${port}/`;
	console.log(`[view] serving showcase at ${target}`);
	console.log(`[view] built-in cases: ${join(distDir, "cases")}`);
	console.log(`[view] overlay cases:  ${casesDir}`);
	if (!noOpen) {
		const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		spawnSync(opener, [target], { shell: process.platform === "win32", stdio: "ignore" });
	}
});
