import type { EffectiveCapabilities, CapabilityId } from "../shared/capabilities.js";

/** Executed before route dispatch/Agent readiness; mixed domains retain field checks. */
export function disabledRouteCapability(method: string, url: string, caps: EffectiveCapabilities): CapabilityId | null {
	if (caps.profile !== "learning") return null;
	const path = url.split("?", 1)[0];
	const prefix = path.split("/")[2];
	const domains: Record<string, CapabilityId> = { terminal: "terminal", runs: "terminal", workspace: "workspaceFiles", workspaces: "workspaceFiles", jobs: "scheduler", checkins: "scheduler", channels: "channels", bridge: "channels", skills: "externalResources", "skill-library": "contentMarket", presets: "contentMarket", "preset-library": "contentMarket", mcp: "mcp", btw: "subagents" };
	if (domains[prefix]) return domains[prefix];
	if (prefix === "settings") {
		if (method === "GET" && path === "/api/settings") return null;
		const allowed = /^\/api\/settings\/(?:model|providers(?:\/[^/]+(?:\/models\/[^/]+)?)?|providers\/probe-models|theme|markdown|close-behavior)$/;
		return allowed.test(path) ? null : "externalResources";
	}
	if (prefix === "learner") {
		if (!caps.capabilities.learnerRead.enabled) return "learnerRead";
		if (/\/knowledge\//.test(path) || /\/misconceptions\//.test(path)) return "learnerManage";
	}
	if (prefix === "wiki" || prefix === "l2") {
		if (!caps.capabilities.memoryL2.enabled || method !== "GET") return "memoryL2";
	}
	// File search includes arbitrary workspace content; add a scoped search in S3.
	if (prefix === "search") return "workspaceFiles";
	if (prefix === "sessions" && /\/(?:workspace|showcase-export)(?:\/|$)/.test(path)) return "workspaceFiles";
	return null;
}

