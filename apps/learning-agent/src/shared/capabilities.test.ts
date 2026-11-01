import { describe, expect, it } from "vitest";
import { normalizeConfig, normalizeModelConfig } from "../config.js";
import { learningToolNames, parseRuntimeProfile, resolveCapabilities } from "./capabilities.js";

const config = () => normalizeConfig({ providers: { fixture: { baseUrl: "http://localhost:1", apiKey: "fixture", models: [normalizeModelConfig({ id: "dummy" })] } } });
describe("runtime capabilities", () => {
	it("keeps old configurations in full and preserves profile across normalization", () => {
		expect(resolveCapabilities(config()).profile).toBe("full");
		expect(normalizeConfig({ ...config(), profile: "learning" }).profile).toBe("learning");
		expect(resolveCapabilities({ ...config(), profile: "learning" }, "full").profile).toBe("full");
	});
	it.each(["", "general", null, true, 1])("rejects invalid profiles instead of widening permissions: %j", value => {
		expect(() => parseRuntimeProfile(value)).toThrow("Invalid profile");
	});
	it("cannot reopen learning capabilities with legacy enabled flags", () => {
		const caps = resolveCapabilities({ ...config(), profile: "learning", mcp: { enabled: true }, subagents: { enabled: true }, plugins: { computerUse: { enabled: true }, codemode: { enabled: true }, officeEngine: { enabled: true } } });
		for (const id of ["mcp", "subagents", "computerUse", "office", "codemode", "terminal", "workspaceFiles"] as const) expect(caps.capabilities[id]).toEqual({ enabled: false, reason: "profile_disabled" });
		expect(Object.isFrozen(caps.capabilities)).toBe(true);
	});
	it("narrows memory and excludes all score-writing tools", () => {
		const caps = resolveCapabilities({ ...config(), profile: "learning", memory: { l1Enabled: false, l2Enabled: false, l3Enabled: true } });
		expect(learningToolNames(caps)).toEqual(["l3_recall"]);
		expect(caps.capabilities.learnerRead.reason).toBe("config_disabled");
	});
	it("preserves full desktop defaults while the learning ceiling always wins", () => {
		expect(resolveCapabilities(config(), "full", { desktop: true }).capabilities.computerUse.enabled).toBe(true);
		expect(resolveCapabilities(config(), "learning", { desktop: true }).capabilities.computerUse.enabled).toBe(false);
		expect(resolveCapabilities({ ...config(), plugins: { computerUse: { enabled: false } } }, "full", { desktop: true }).capabilities.computerUse.enabled).toBe(false);
	});
});
