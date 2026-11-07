import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseQuestionRequest, requestFingerprint, deriveConceptId } from "./question-request.js";

/**
 * C4 request boundary: `after_attempt_id` is an optional binding to the attempt
 * the question continues from. It must parse strictly, participate in the retry
 * fingerprint, and — crucially — not change the fingerprint of requests written
 * before C4, or their legal retries would turn into conflicts after upgrade.
 */

const base = {
	concept: "Python 闭包",
	request_id: "req_1",
	expected_revision: 3,
	allow_model_fallback: true,
};

describe("parseQuestionRequest after_attempt_id", () => {
	it("accepts an optional attempt binding", () => {
		const parsed = parseQuestionRequest({ ...base, after_attempt_id: "attempt_1" });
		expect(parsed.after_attempt_id).toBe("attempt_1");
	});

	it("omits the field entirely when the client does not send it", () => {
		const parsed = parseQuestionRequest(base);
		expect("after_attempt_id" in parsed).toBe(false);
	});

	it.each(["", " attempt", "../escape", "attempt id", 42, null])("rejects a malformed binding %#", (value) => {
		expect(() => parseQuestionRequest({ ...base, after_attempt_id: value })).toThrow();
	});
});

describe("requestFingerprint after_attempt_id", () => {
	const parsed = (overrides: Record<string, unknown> = {}) => parseQuestionRequest({ ...base, ...overrides });

	it("distinguishes continuations from different attempts", () => {
		const a = requestFingerprint(parsed({ after_attempt_id: "attempt_1" }));
		const b = requestFingerprint(parsed({ after_attempt_id: "attempt_2" }));
		expect(a).not.toBe(b);
	});

	it("distinguishes a continuation from the same request without a binding", () => {
		expect(requestFingerprint(parsed())).not.toBe(requestFingerprint(parsed({ after_attempt_id: "attempt_1" })));
	});

	it("keeps the pre-C4 fingerprint for payloads without a binding", () => {
		// The canonical form before C4 had exactly these keys. A retry of a question
		// committed by an older build must still match its stored fingerprint.
		const legacy = createHash("sha256")
			.update(JSON.stringify({
				concept: "Python 闭包",
				concept_id: parsed().concept_id,
				goal_id: null,
				kind: null,
				designated: null,
				allow_model_fallback: true,
			}))
			.digest("hex")
			.slice(0, 32);
		expect(requestFingerprint(parsed())).toBe(legacy);
	});
});

describe("concept label boundary", () => {
	it.each(["concept_45125622e640", "concept 45125622e640", "Concept 45125622E640"])(
		"refuses to use the machine identity %s as a topic",
		(label) => {
			expect(() => parseQuestionRequest({ ...base, concept: label })).toThrow(/系统生成的标识/);
		},
	);

	it("still allows reusing a derived concept id with a real topic name", () => {
		const parsed = parseQuestionRequest({
			...base,
			concept: "Python 闭包",
			concept_id: "concept_45125622e640",
		});
		expect(parsed.concept_label).toBe("Python 闭包");
		expect(parsed.concept_id).toBe("concept_45125622e640");
	});
});

describe("review intent", () => {
	const parsed = (overrides: Record<string, unknown> = {}) => parseQuestionRequest({ ...base, ...overrides });

	it("accepts only the review intent and omits it otherwise", () => {
		expect(parsed({ intent: "review" }).intent).toBe("review");
		expect("intent" in parsed()).toBe(false);
	});

	it.each(["practice", "REVIEW", "", 1, null])("rejects the unknown intent %#", (value) => {
		expect(() => parseQuestionRequest({ ...base, intent: value })).toThrow();
	});

	it("keeps the pre-C4-C fingerprint for payloads without an intent", () => {
		// Adding the key unconditionally would break retries of questions committed
		// before this build, whose stored fingerprint has no `intent` at all.
		const legacy = createHash("sha256")
			.update(JSON.stringify({
				concept: "Python 闭包",
				concept_id: parsed().concept_id,
				goal_id: null,
				kind: null,
				designated: null,
				allow_model_fallback: true,
			}))
			.digest("hex")
			.slice(0, 32);
		expect(requestFingerprint(parsed())).toBe(legacy);
	});

	it("separates a review request from ordinary practice with the same content", () => {
		expect(requestFingerprint(parsed({ intent: "review" }))).not.toBe(requestFingerprint(parsed()));
	});
});

describe("E4.1a course-scoped concept identity", () => {
	const sameLabel = { ...base, concept: "函数" };

	it("keeps the exact legacy id when no course context exists", () => {
		// Compatibility: every concept_id and evidence reference written before
		// E4.1a must resolve to the same state, so the unscoped digest stays the
		// pre-E4.1a sha256 over the normalised label.
		const legacy = `concept_${createHash("sha256").update("函数").digest("hex").slice(0, 12)}`;
		expect(parseQuestionRequest(sameLabel).concept_id).toBe(legacy);
		expect(parseQuestionRequest(sameLabel, { courseId: null }).concept_id).toBe(legacy);
		expect(deriveConceptId("函数")).toBe(legacy);
	});

	it("does not merge the same name across two courses", () => {
		const python = parseQuestionRequest(sameLabel, { courseId: "course_python" });
		const math = parseQuestionRequest(sameLabel, { courseId: "course_math" });
		expect(python.concept_id).not.toBe(math.concept_id);
		// Still the same shape, so synthetic-label guards and UI checks keep working.
		expect(python.concept_id).toMatch(/^concept_[0-9a-f]{12}$/);
	});

	it("is stable across retries in the same course", () => {
		const first = parseQuestionRequest({ ...sameLabel, request_id: "req_a" }, { courseId: "course_python" });
		const retry = parseQuestionRequest({ ...sameLabel, request_id: "req_a" }, { courseId: "course_python" });
		expect(first.concept_id).toBe(retry.concept_id);
		expect(requestFingerprint(first)).toBe(requestFingerprint(retry));
	});

	it("keeps a client-supplied concept id instead of re-deriving it", () => {
		const parsed = parseQuestionRequest({ ...sameLabel, concept_id: "concept_45125622e640" }, { courseId: "course_python" });
		expect(parsed.concept_id).toBe("concept_45125622e640");
	});
});
