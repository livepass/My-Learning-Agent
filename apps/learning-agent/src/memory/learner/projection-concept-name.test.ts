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

	it("uses the evidence's topic name for a new state (E4.6)", () => {
		const profile = createDefaultProfile();
		const state = ensureKnowledgeState(profile, "concept_45125622e640", "数列极限的 ε-N 定义");

		expect(state.concept_id).toBe("concept_45125622e640");
		expect(state.concept_name).toBe("数列极限的 ε-N 定义");
	});

	it("lets a hash-named state adopt a real name later, but never a manual one", () => {
		const profile = createDefaultProfile();
		const derived = ensureKnowledgeState(profile, "concept_45125622e640");
		expect(derived.concept_name).toBe("concept_45125622e640");

		// The state was created before the name was known; the first real name wins.
		expect(ensureKnowledgeState(profile, "concept_45125622e640", "Python 装饰器").concept_name).toBe("Python 装饰器");

		// A later wording for the same concept does not keep renaming the state.
		expect(ensureKnowledgeState(profile, "concept_45125622e640", "别的说法").concept_name).toBe("Python 装饰器");

		// A human-owned label is never overwritten by evidence.
		const manual = ensureKnowledgeState(profile, "agents.function-calling");
		manual.origin = "manual";
		manual.concept_name = "函数调用（人工命名）";
		expect(ensureKnowledgeState(profile, "agents.function-calling", "function calling").concept_name)
			.toBe("函数调用（人工命名）");
	});
});
