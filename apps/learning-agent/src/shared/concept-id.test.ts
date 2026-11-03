import { describe, expect, it } from "vitest";
import { isDerivedConceptId, looksLikeSyntheticConceptLabel } from "./concept-id.js";

describe("machine-minted concept identities", () => {
	it("recognises the id shape produced by deriveConceptId", () => {
		expect(isDerivedConceptId("concept_45125622e640")).toBe(true);
		expect(isDerivedConceptId(" concept_45125622e640 ")).toBe(true);
	});

	it("does not mistake curated ids for derived ones", () => {
		expect(isDerivedConceptId("concept_closure")).toBe(false);
		expect(isDerivedConceptId("agents.function-calling")).toBe(false);
		expect(isDerivedConceptId("concept_45125622e64")).toBe(false);
	});

	it("treats both the id and the old title-cased form as synthetic labels", () => {
		expect(looksLikeSyntheticConceptLabel("concept_45125622e640")).toBe(true);
		expect(looksLikeSyntheticConceptLabel("concept 45125622e640")).toBe(true);
		expect(looksLikeSyntheticConceptLabel("Concept 45125622E640")).toBe(true);
		expect(looksLikeSyntheticConceptLabel("concept-45125622e640")).toBe(true);
	});

	it("keeps real topic names usable", () => {
		expect(looksLikeSyntheticConceptLabel("Python 闭包")).toBe(false);
		expect(looksLikeSyntheticConceptLabel("concept closure")).toBe(false);
		expect(looksLikeSyntheticConceptLabel("agents.function-calling")).toBe(false);
	});
});
