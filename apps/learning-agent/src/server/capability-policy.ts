import type { EffectiveCapabilities, CapabilityId } from "../shared/capabilities.js";

/** Executed before route dispatch/Agent readiness; mixed domains retain field checks. */
export function disabledRouteCapability(method: string, url: string, caps: EffectiveCapabilities): CapabilityId | null {
		const path = url.split("?", 1)[0];
	const prefix = path.split("/")[2];
	const domains: Record<string, CapabilityId> = { terminal: "terminal", runs: "terminal", workspace: "workspaceFiles", workspaces: "workspaceFiles", jobs: "scheduler", checkins: "scheduler", channels: "channels", bridge: "channels", skills: "externalResources", "skill-library": "contentMarket", presets: "contentMarket", "preset-library": "contentMarket", mcp: "mcp", btw: "subagents" };
	if (domains[prefix]) return domains[prefix];
	if (prefix === "settings") {
		if (method === "GET" && path === "/api/settings") return null;
		// The Magpie gateway probe is part of the model settings domain (it is
		// the same server-side "test this provider" operation as probe-models).
		// Without this entry every Magpie request falls through to the removed
		// externalResources capability and the panel is dead in the product.
		const allowed = /^\/api\/settings\/(?:model(?:\/verify)?|providers(?:\/[^/]+(?:\/models\/[^/]+)?)?|providers\/probe-models|magpie\/(?:health|models)|theme|markdown|close-behavior)$/;
		return allowed.test(path) ? null : "externalResources";
	}
	if (prefix === "learner") {
		if (!caps.capabilities.learnerRead.enabled) return "learnerRead";
		if (/\/knowledge\//.test(path) || /\/misconceptions\//.test(path)) return "learnerManage";
	}
	// E4.1 course data is part of the learning product, like the learner profile:
	// reads follow learnerRead, and mutations require learnerManage. Course
	// ownership is stored on the server, so no capability may bypass it.
	if (prefix === "courses") {
		if (!caps.capabilities.learnerRead.enabled) return "learnerRead";
		if (method !== "GET" && !caps.capabilities.learnerManage.enabled) return "learnerManage";
	}
	if (prefix === "wiki" || prefix === "l2") {
		if (!caps.capabilities.memoryL2.enabled || method !== "GET") return "memoryL2";
	}
	// File search includes arbitrary workspace content; add a scoped search in S3.
	if (prefix === "search") return "workspaceFiles";
	if (prefix === "sessions" && /\/(?:workspace|showcase-export)(?:\/|$)/.test(path)) return "workspaceFiles";
	return null;
}

