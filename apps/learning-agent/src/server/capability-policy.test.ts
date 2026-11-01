import { expect, it } from "vitest";
import { resolveCapabilities } from "../shared/capabilities.js";
import type { InnoConfig } from "../config.js";
import { disabledRouteCapability } from "./capability-policy.js";
const learning = resolveCapabilities({ profile: "learning" } as InnoConfig);
it.each(["/api/terminal/sessions", "/api/workspace/file", "/api/jobs", "/api/mcp", "/api/settings/computer-use", "/api/settings/codemode", "/api/learner/profile/knowledge/x", "/api/sessions/x/workspace"])("rejects direct capability access: %s", path => {
	expect(disabledRouteCapability("POST", path, learning)).not.toBeNull();
});
it.each(["/api/settings", "/api/sessions", "/api/chat/stream", "/api/learner/profile/goals"])("keeps core routes: %s", path => {
	expect(disabledRouteCapability("GET", path, learning)).toBeNull();
});
it("does not change full route dispatch", () => {
	expect(disabledRouteCapability("POST", "/api/terminal/sessions", resolveCapabilities({} as InnoConfig))).toBeNull();
});
