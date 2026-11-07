import { readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createRouteDispatcher, requiresAgent, type RouteHandlers } from "./route-dispatch.js";

const routesDir = join(import.meta.dirname, "routes");
const routeFiles = readdirSync(routesDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
const req = {} as IncomingMessage;
const res = {} as ServerResponse;

function makeHandlers() {
	return {
		sessions: vi.fn<RouteHandlers["sessions"]>().mockResolvedValue(false),
		wiki: vi.fn<RouteHandlers["wiki"]>().mockResolvedValue(false),
		learner: vi.fn<RouteHandlers["learner"]>().mockResolvedValue(false),
		settings: vi.fn<RouteHandlers["settings"]>().mockResolvedValue(false),
		commands: vi.fn<RouteHandlers["commands"]>().mockResolvedValue(false),
		chat: vi.fn<RouteHandlers["chat"]>().mockResolvedValue(false),
		courses: vi.fn<RouteHandlers["courses"]>().mockResolvedValue(false),
	} satisfies RouteHandlers;
}

function routePatterns(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(join(routesDir, file), "utf8"), ts.ScriptTarget.Latest, true);
	const patterns = new Set<string>();
	const visit = (node: ts.Node): void => {
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.startsWith("/api/")) {
			patterns.add(node.text);
		} else if (ts.isTemplateExpression(node) && node.head.text.startsWith("/api/")) {
			patterns.add(node.head.text + node.templateSpans.map((span) => "route-probe" + span.literal.text).join(""));
		} else if (ts.isRegularExpressionLiteral(node)) {
			// The settings model-delete route uses an anchored regex instead of
			// matchRoute. Replace its variable path segments with a concrete ID.
			const pattern = node.text.slice(1, node.text.lastIndexOf("/")).replaceAll("\\/", "/");
			if (pattern.startsWith("^/api/")) {
				patterns.add(pattern.replace(/^\^|\$$/g, "").replaceAll("[^/]+", "route-probe"));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return [...patterns].map((pattern) => pattern.replace(/:[A-Za-z]\w*/g, "route-probe"));
}

describe("route prefix dispatch", () => {
	it("registers every route domain and every registry entry covers a declared URL", () => {
		const handlers = makeHandlers();
		const { registry } = createRouteDispatcher(handlers);
		expect(routeFiles.map((file) => file.slice(0, -3)).sort()).toEqual(Object.keys(handlers).sort());
		for (const { prefix, handler } of registry) {
			const domain = Object.entries(handlers).find(([, candidate]) => candidate === handler)![0];
			expect(routePatterns(`${domain}.ts`).some((pattern) => pattern.split("?", 1)[0].split("/", 3).join("/") === prefix), prefix)
				.toBe(true);
		}
	});

	it.each(routeFiles)("dispatches every URL literal/pattern in %s to its owning handler", async (file) => {
		const handlers = makeHandlers();
		const domain = file.slice(0, -3) as keyof RouteHandlers;
		handlers[domain].mockResolvedValue(true);
		const { dispatch } = createRouteDispatcher(handlers);
		const patterns = routePatterns(file);
		expect(patterns.length).toBeGreaterThan(0);
		for (const url of patterns) {
			vi.clearAllMocks();
			expect(await dispatch(req, res, "GET", url), `${file}: ${url}`).toBe(true);
			expect(handlers[domain], url).toHaveBeenCalledExactlyOnceWith(req, res, "GET", url);
			for (const [other, handler] of Object.entries(handlers)) {
				if (other !== domain) {
					expect(handler, `${file}: unrelated ${other} called for ${url}`).not.toHaveBeenCalled();
				}
			}
		}
	});

	it("uses the query-free prefix while passing the original URL and method to the handler", async () => {
		const handlers = makeHandlers();
		handlers.chat.mockResolvedValue(true);
		const { dispatch } = createRouteDispatcher(handlers);
		const url = "/api/chat?next=/api/sessions&bad=%";
		expect(await dispatch(req, res, "POST", url)).toBe(true);
		expect(handlers.chat).toHaveBeenCalledExactlyOnceWith(req, res, "POST", url);
		expect(handlers.sessions).not.toHaveBeenCalled();
	});

	it("declines when the handler on a known prefix declines", async () => {
		const handlers = makeHandlers();
		const { dispatch } = createRouteDispatcher(handlers);
		expect(await dispatch(req, res, "DELETE", "/api/sessions/session.jsonl/unknown")).toBe(false);
		expect(handlers.sessions).toHaveBeenCalledOnce();
		expect(handlers.chat).not.toHaveBeenCalled();
	});

	it.each([
		"/", "/health", "/api/health", "/api", "/assets/app.js", "/api/unknown", "/api/chatty",
		// Removed workbench domains now fall through to the JSON 404.
		"/api/jobs", "/api/checkins", "/api/channels", "/api/skills", "/api/search",
		"/api/workspaces", "/api/presets", "/api/terminal", "/api/runs", "/api/btw", "/api/mcp",
	])(
		"leaves unmatched, removed or special URL %s to the server skeleton",
		async (url) => {
			const handlers = makeHandlers();
			const { dispatch } = createRouteDispatcher(handlers);
			expect(await dispatch(req, res, "GET", url)).toBe(false);
			for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
		},
	);
});


describe("Agent readiness boundary", () => {
	it.each([
		["GET", "/api/sessions"], ["GET", "/api/sessions/history.jsonl"],
		["GET", "/api/sessions/history.jsonl/context-usage"],
		["GET", "/api/settings"], ["POST", "/api/settings/model"], ["PUT", "/api/settings/providers"],
		["GET", "/api/chat/status/history.jsonl"], ["POST", "/api/chat/abort"],
		["GET", "/api/learner/profile"], ["GET", "/api/wiki/index"],
	])("does not wait for Agent: %s %s", (method, path) => {
		expect(requiresAgent(method, path)).toBe(false);
	});
	it.each([
		["GET", "/api/commands"], ["POST", "/api/chat"], ["POST", "/api/chat/stream"],
		["POST", "/api/sessions"], ["POST", "/api/sessions/a.jsonl/activate?source=history"],
		["POST", "/api/sessions/a.jsonl/branch-before-message"], ["POST", "/api/sessions/a.jsonl/generate-topic"],
		["POST", "/api/settings/model/verify"],
	])("waits for runtime operations: %s %s", (method, path) => {
		expect(requiresAgent(method, path)).toBe(true);
	});
});
