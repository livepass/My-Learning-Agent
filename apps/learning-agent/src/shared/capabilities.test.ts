import { describe, expect, it } from "vitest";
import { normalizeConfig, normalizeModelConfig } from "../config.js";
import { learningToolNames, resolveCapabilities } from "./capabilities.js";

const config = () => normalizeConfig({ providers: { fixture: { baseUrl: "http://localhost:1", apiKey: "fixture", models: [normalizeModelConfig({ id: "dummy" })] } } });
describe("runtime capabilities", () => {
	it("has one product: a leftover profile key is dropped, not honoured", () => {
		const parsed = normalizeConfig({ ...config(), profile: "full" } as Parameters<typeof normalizeConfig>[0]);
		expect("profile" in parsed).toBe(false);
		expect(resolveCapabilities(parsed).capabilities.terminal.enabled).toBe(false);
	});
	it("cannot reopen removed capabilities with legacy enabled flags", () => {
		const caps = resolveCapabilities(config());
		for (const id of ["mcp", "subagents", "computerUse", "office", "codemode", "terminal", "workspaceFiles", "ocr", "webAccess", "scheduler", "channels"] as const) {
			expect(caps.capabilities[id]).toEqual({ enabled: false, reason: "removed" });
		}
		expect(Object.isFrozen(caps.capabilities)).toBe(true);
	});
	it("narrows memory and excludes every learning tool with it", () => {
		const caps = resolveCapabilities({ ...config(), memory: { l1Enabled: false, l2Enabled: false, l3Enabled: true } });
		expect(learningToolNames(caps)).toEqual(["l3_recall"]);
		expect(caps.capabilities.learnerRead.reason).toBe("config_disabled");
	});
	it("exposes the learning tools when memory is on", () => {
		const caps = resolveCapabilities({ ...config(), memory: { l1Enabled: true, l2Enabled: true, l3Enabled: true } });
		expect(learningToolNames(caps).sort()).toEqual([
			"assess_learning_prerequisites",
			"get_learner_context",
			"l2_lint",
			"l2_query",
			"l3_recall",
			"patch_learner_profile",
			"record_learning_event",
			"record_learning_evidence",
			"review_learner_profile",
		]);
	});
});
