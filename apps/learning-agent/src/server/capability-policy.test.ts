import { expect, it } from "vitest";
import { resolveCapabilities } from "../shared/capabilities.js";
import type { InnoConfig } from "../config.js";
import { disabledRouteCapability } from "./capability-policy.js";
const caps = resolveCapabilities({} as InnoConfig);
it.each(["/api/terminal/sessions", "/api/workspace/file", "/api/jobs", "/api/mcp", "/api/settings/computer-use", "/api/settings/codemode", "/api/learner/profile/knowledge/x", "/api/sessions/x/workspace"])("rejects direct capability access: %s", path => {
	expect(disabledRouteCapability("POST", path, caps)).not.toBeNull();
});
it.each(["/api/settings", "/api/sessions", "/api/chat/stream", "/api/learner/profile/goals", "/api/courses", "/api/courses/course_abc"])("keeps core routes: %s", path => {
	expect(disabledRouteCapability("GET", path, caps)).toBeNull();
});
it("keeps course writes inside the learner capabilities instead of falling through", () => {
	// A course mutation is learner data, not a removed workbench capability.
	expect(disabledRouteCapability("POST", "/api/courses", caps)).toBeNull();
	expect(disabledRouteCapability("PATCH", "/api/courses/course_abc", caps)).toBeNull();
	const readOnly = resolveCapabilities({ memory: { l1Enabled: false } } as InnoConfig);
	expect(disabledRouteCapability("GET", "/api/courses", readOnly)).toBe("learnerRead");
	expect(disabledRouteCapability("POST", "/api/courses", readOnly)).toBe("learnerRead");
});
it.each(["/api/settings/magpie/health", "/api/settings/magpie/models", "/api/settings/model/verify"])("keeps the model settings probes in the model settings domain: %s", path => {
	// externalResources is a removed capability, so falling through to it would
	// 403 every Magpie request even though the panel is a model setting.
	expect(disabledRouteCapability("POST", path, caps)).toBeNull();
});
it("reports the removal reason for capabilities that no longer exist", () => {
	expect(caps.capabilities.terminal.reason).toBe("removed");
	expect(caps.capabilities.workspaceFiles.reason).toBe("removed");
	expect(caps.capabilities.learnerRead.reason).toBeUndefined();
});
