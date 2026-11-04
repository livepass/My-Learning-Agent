import { describe, expect, it } from "vitest";
import {
	isSafeReviewConceptId,
	isSafeReviewSessionId,
	parseReviewIntent,
} from "./review-intent.js";

describe("review intent URL contract", () => {
	it("parses a complete review entry", () => {
		expect(parseReviewIntent(
			"?page=practice&intent=review&review_concept_id=concept_closure&session=s1.jsonl&review_question_id=q_123",
		)).toEqual({
			conceptId: "concept_closure",
			sessionId: "s1.jsonl",
			questionId: "q_123",
		});
	});

	it("accepts an entry without a session or generated question", () => {
		expect(parseReviewIntent("?page=practice&intent=review&review_concept_id=concept_closure"))
			.toEqual({ conceptId: "concept_closure" });
	});

	it.each([
		["missing intent", "?page=practice&review_concept_id=concept_closure"],
		["another intent", "?page=practice&intent=learn&review_concept_id=concept_closure"],
		["missing concept", "?page=practice&intent=review"],
		["empty concept", "?page=practice&intent=review&review_concept_id="],
		["unsafe concept", "?page=practice&intent=review&review_concept_id=../etc/passwd"],
	])("ignores %s", (_label, search) => {
		expect(parseReviewIntent(search)).toBeNull();
	});

	it("drops an unsafe session or question id instead of using it", () => {
		const parsed = parseReviewIntent(
			"?intent=review&review_concept_id=concept_closure&session=../escape&review_question_id=bad%20id",
		);
		expect(parsed).toEqual({ conceptId: "concept_closure" });
	});

	it("validates identifier shapes", () => {
		expect(isSafeReviewConceptId("concept_45125622e640")).toBe(true);
		expect(isSafeReviewConceptId("agents.function-calling")).toBe(true);
		expect(isSafeReviewConceptId("../concept")).toBe(false);
		expect(isSafeReviewSessionId("s1.jsonl")).toBe(true);
		expect(isSafeReviewSessionId("a/b")).toBe(false);
	});
});
