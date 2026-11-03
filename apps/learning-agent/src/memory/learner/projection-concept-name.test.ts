import { describe, expect, it } from "vitest";
import { ensureKnowledgeState } from "./projection.js";
import { createDefaultProfile } from "./types.js";

/**
 * C4-P2: a derived concept id carries no human label. The projector must not
 * invent one by title-casing its hash — otherwise the UI would later offer
 * "concept 45125622e640" as the learner's topic.
 */
describe("projected concept names", () => {
	it("keeps a derived id as an identifier instead of fabricating a title", () => {
		const profile = createDefaultProfile();
		const state = ensureKnowledgeState(profile, "concept_45125622e640");

		expect(state.concept_id).toBe("concept_45125622e640");
		expect(state.concept_name).toBe("concept_45125622e640");
		expect(state.concept_name).not.toContain(" ");
	});

	it("still derives a readable name for curated concept ids", () => {
		const profile = createDefaultProfile();
		const state = ensureKnowledgeState(profile, "agents.function-calling");

		expect(state.concept_name).toBe("function calling");
	});

	it("preserves an existing human label when the state already exists", () => {
		const profile = createDefaultProfile();
		const state = ensureKnowledgeState(profile, "concept_45125622e640");
		state.concept_name = "Python 闭包";

		expect(ensureKnowledgeState(profile, "concept_45125622e640").concept_name).toBe("Python 闭包");
	});
});
