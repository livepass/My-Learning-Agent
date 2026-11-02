import { expect, it } from "vitest";
import { resolveCapabilities } from "../shared/capabilities.js";
import type { InnoConfig } from "../config.js";
import { disabledRouteCapability } from "./capability-policy.js";
const caps = resolveCapabilities({} as InnoConfig);
it.each(["/api/terminal/sessions", "/api/workspace/file", "/api/jobs", "/api/mcp", "/api/settings/computer-use", "/api/settings/codemode", "/api/learner/profile/knowledge/x", "/api/sessions/x/workspace"])("rejects direct capability access: %s", path => {
	expect(disabledRouteCapability("POST", path, caps)).not.toBeNull();
});
it.each(["/api/settings", "/api/sessions", "/api/chat/stream", "/api/learner/profile/goals"])("keeps core routes: %s", path => {
	expect(disabledRouteCapability("GET", path, caps)).toBeNull();
});
it("reports the removal reason for capabilities that no longer exist", () => {
	expect(caps.capabilities.terminal.reason).toBe("removed");
	expect(caps.capabilities.workspaceFiles.reason).toBe("removed");
	expect(caps.capabilities.learnerRead.reason).toBeUndefined();
});
