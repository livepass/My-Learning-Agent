import type { IncomingMessage, ServerResponse } from "node:http";

type RouteHandler = (req: IncomingMessage, res: ServerResponse, method: string, url: string) => Promise<boolean>;

/**
 * Learning-product route domains. The workbench domains (jobs, checkins,
 * channels/bridge, skills, global search, workspaces, presets, terminal/runs,
 * btw) were removed with the legacy feature set, so their prefixes now fall
 * through to the server's JSON 404 instead of a dedicated handler.
 */
export type RouteHandlers = Record<
	| "sessions" | "wiki" | "learner" | "settings" | "commands" | "chat",
	RouteHandler
>;

export function createRouteDispatcher(handlers: RouteHandlers) {
	const registry = [
		{ prefix: "/api/sessions", handler: handlers.sessions },
		{ prefix: "/api/wiki", handler: handlers.wiki },
		{ prefix: "/api/l2", handler: handlers.wiki },
		{ prefix: "/api/learner", handler: handlers.learner },
		{ prefix: "/api/settings", handler: handlers.settings },
		{ prefix: "/api/commands", handler: handlers.commands },
		{ prefix: "/api/chat", handler: handlers.chat },
	];
	const byPrefix = new Map<string, RouteHandler[]>();
	for (const { prefix, handler } of registry) {
		const candidates = byPrefix.get(prefix) ?? [];
		candidates.push(handler);
		byPrefix.set(prefix, candidates);
	}

	const dispatch: RouteHandler = async (req, res, method, url) => {
		// Strip only the query for lookup; handlers receive the original URL.
		const prefix = url.split("?", 1)[0].split("/", 3).join("/");
		for (const handler of byPrefix.get(prefix) ?? []) {
			if (await handler(req, res, method, url)) return true;
		}
		return false;
	};
	return { registry, dispatch };
}

/** Data routes stay usable while extension startup runs in the background. */
export function requiresAgent(method: string, url: string): boolean {
	const path = url.split("?", 1)[0];
	if (method === "GET") return path === "/api/commands";
	if (method !== "POST") return false;
	return ["/api/chat", "/api/chat/stream", "/api/sessions"].includes(path)
		|| /^\/api\/sessions\/[^/]+\/(activate|branch-before-message|generate-topic)$/.test(path)
		// C1 generation calls the model, so the agent runtime must exist first.
		|| /^\/api\/sessions\/[^/]+\/learning\/questions\/generate$/.test(path);
}
