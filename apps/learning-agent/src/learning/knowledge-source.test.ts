import { describe, expect, it } from "vitest";
import { publicQuestion } from "./contracts.js";
import {
	KNOWLEDGE_SOURCE_KINDS,
	KnowledgeSourceError,
	knowledgeSnippet,
	parseKnowledgeCandidate,
	parseKnowledgeRequest,
	parseKnowledgeSource,
	sameSnippet,
	selectKnowledgeSource,
	type KnowledgeAssessment,
	type KnowledgeCandidate,
	type KnowledgeRequest,
	type KnowledgeSnippet,
} from "./knowledge-source.js";
import type { LearningModelIdentity, LearningQuestion } from "../memory/learner/types.js";

const MODEL: LearningModelIdentity = {
	provider_id: "fixture",
	model_id: "dummy",
	model_version: null,
	version_source: "unavailable",
};

const assessment = (overrides: Partial<KnowledgeAssessment> = {}): KnowledgeAssessment => ({
	availability: "available",
	review_status: "draft",
	contested: false,
	...overrides,
});

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
	return {
		provenance: {
			source_id: "src_closures",
			origin: "user_upload",
			original_content_hash: "aaaaaaaaaaaaaaaa",
		},
		snippet: {
			page_path: "wiki/concepts/closures.md",
			location: { kind: "heading", heading: "词法作用域" },
			content_hash: "bbbbbbbbbbbbbbbb",
			char_count: 120,
		},
		assessment: assessment(),
		found_by: "retrieval",
		score: 0.8,
		...overrides,
	};
}

function request(overrides: Partial<KnowledgeRequest> = {}): KnowledgeRequest {
	return { allow_model_fallback: false, ...overrides };
}

describe("knowledge source kinds", () => {
	it("keeps exactly the three documented kinds", () => {
		expect(KNOWLEDGE_SOURCE_KINDS).toEqual(["user_document", "l2_archive", "model_knowledge"]);
	});
});

describe("selection order", () => {
	it("prefers the document the user named over retrieved material", () => {
		const designated = candidate({ found_by: "designated", score: null });
		const retrieved = candidate({
			found_by: "retrieval",
			score: 0.99,
			provenance: { source_id: "src_other", origin: "user_upload", original_content_hash: "cccccccccccccccc" },
		});

		const result = selectKnowledgeSource({
			request: request({ designated: { by: "source_id", value: "src_closures" } }),
			candidates: [designated, retrieved],
			model: MODEL,
		});

		expect(result.status).toBe("selected");
		if (result.status !== "selected") return;
		expect(result.source.kind).toBe("user_document");
		if (result.source.kind !== "user_document") return;
		expect(result.source.designation).toEqual({ by: "source_id", value: "src_closures" });
		expect(result.source.provenance.source_id).toBe("src_closures");
	});

	it("never substitutes model knowledge for a document the user named but that is missing", () => {
		const result = selectKnowledgeSource({
			request: request({ designated: { by: "source_id", value: "src_missing" }, allow_model_fallback: true }),
			candidates: [candidate({ found_by: "retrieval", score: 0.9 })],
			model: MODEL,
		});

		expect(result).toEqual({ status: "needs_input", reason: "designated_not_found", candidates: [] });
		// Model knowledge and retrieval hits are both refused here on purpose.
		expect(JSON.stringify(result)).not.toContain("model_knowledge");
	});

	it("refuses a designated document whose excerpt changed or disappeared", () => {
		for (const availability of ["snapshot_mismatch", "missing"] as const) {
			const result = selectKnowledgeSource({
				request: request({ designated: { by: "source_id", value: "src_closures" }, allow_model_fallback: true }),
				candidates: [candidate({ found_by: "designated", score: null, assessment: assessment({ availability }) })],
				model: MODEL,
			});

			expect(result.status).toBe("unavailable");
			if (result.status !== "unavailable" || result.reason !== "designated_unavailable") {
				throw new Error(`expected designated_unavailable for ${availability}`);
			}
			expect(result.candidates).toHaveLength(1);
			// Still no silent fallback to the model or to other material.
			expect(JSON.stringify(result)).not.toContain("model_knowledge");
		}
	});

	it("asks the user to choose when a designation matches more than one document", () => {
		const first = candidate({ found_by: "designated", score: null });
		const second = candidate({
			found_by: "designated",
			score: null,
			provenance: { source_id: "src_closures_v2", origin: "user_upload", original_content_hash: "dddddddddddddddd" },
		});

		const result = selectKnowledgeSource({
			request: request({ designated: { by: "source_identity", value: "closures.pdf" } }),
			candidates: [first, second],
			model: null,
		});

		expect(result.status).toBe("needs_input");
		if (result.status !== "needs_input") return;
		expect(result.reason).toBe("designated_ambiguous");
		expect(result.candidates).toHaveLength(2);
	});

	it("treats several excerpts of one designated document as a retrieval choice, not an ambiguity", () => {
		const low = candidate({ found_by: "designated", score: 0.2 });
		const high = candidate({
			found_by: "designated",
			score: 0.7,
			snippet: { ...low.snippet, content_hash: "eeeeeeeeeeeeeeee", location: { kind: "whole_page" } },
		});

		const result = selectKnowledgeSource({
			request: request({ designated: { by: "source_id", value: "src_closures" } }),
			candidates: [low, high],
			model: null,
		});

		expect(result.status).toBe("selected");
		if (result.status !== "selected" || result.source.kind !== "user_document") return;
		expect(result.source.snippet.location).toEqual({ kind: "whole_page" });
	});

	it("falls back to model knowledge only when nothing archived fits and the request allows it", () => {
		const result = selectKnowledgeSource({
			request: request({ query: "闭包", allow_model_fallback: true }),
			candidates: [],
			model: MODEL,
		});

		expect(result.status).toBe("selected");
		if (result.status !== "selected") return;
		expect(result.source.kind).toBe("model_knowledge");
		if (result.source.kind !== "model_knowledge") return;
		expect(result.source.ground).toBe("no_matching_source");
		// Unreported version stays null; nothing is invented.
		expect(result.source.model).toEqual(MODEL);
	});

	it("reports no_source_requested when the turn asked for nothing in particular", () => {
		const result = selectKnowledgeSource({ request: request({ allow_model_fallback: true }), candidates: [], model: MODEL });
		expect(result.status).toBe("selected");
		if (result.status !== "selected" || result.source.kind !== "model_knowledge") return;
		expect(result.source.ground).toBe("no_source_requested");
	});

	it("refuses to answer when the model fallback is disallowed or the identity is missing", () => {
		expect(selectKnowledgeSource({ request: request(), candidates: [], model: MODEL }))
			.toEqual({ status: "unavailable", reason: "model_fallback_disallowed" });
		expect(selectKnowledgeSource({ request: request({ allow_model_fallback: true }), candidates: [], model: null }))
			.toEqual({ status: "unavailable", reason: "model_identity_unavailable" });
	});

	it("ignores archived candidates that are no longer available", () => {
		const result = selectKnowledgeSource({
			request: request({ allow_model_fallback: true }),
			candidates: [candidate({ assessment: assessment({ availability: "missing" }) })],
			model: MODEL,
		});
		expect(result.status).toBe("selected");
		if (result.status !== "selected") return;
		expect(result.source.kind).toBe("model_knowledge");
	});
});

describe("conflicting sources", () => {
	it("reports the disagreement instead of silently picking one side", () => {
		const contested = candidate({ assessment: assessment({ contested: true }), score: 0.9 });
		const other = candidate({
			provenance: { source_id: "src_other", origin: "research", original_content_hash: "ffffffffffffffff" },
			snippet: {
				page_path: "wiki/sources/mdn-closures.md",
				location: { kind: "whole_page" },
				content_hash: "1111111111111111",
				char_count: 90,
			},
			score: 0.4,
		});

		const result = selectKnowledgeSource({ request: request(), candidates: [contested, other], model: null });

		expect(result.status).toBe("needs_input");
		if (result.status !== "needs_input") return;
		expect(result.reason).toBe("conflicting_sources");
		expect(result.candidates.map((item) => item.provenance.source_id).sort()).toEqual(["src_closures", "src_other"]);
	});

	it("keeps the contested flag when a single marked source is selected", () => {
		const result = selectKnowledgeSource({
			request: request(),
			candidates: [candidate({ assessment: assessment({ contested: true }) })],
			model: null,
		});
		expect(result.status).toBe("selected");
		if (result.status !== "selected" || result.source.kind !== "l2_archive") return;
		expect(result.source.assessment.contested).toBe(true);
	});
});

describe("source identity and snippet versions", () => {
	it("records the manifest identity together with the adopted excerpt", () => {
		const result = selectKnowledgeSource({ request: request(), candidates: [candidate()], model: null });
		expect(result.status).toBe("selected");
		if (result.status !== "selected" || result.source.kind !== "l2_archive") return;
		expect(result.source.provenance).toEqual({
			source_id: "src_closures",
			origin: "user_upload",
			original_content_hash: "aaaaaaaaaaaaaaaa",
		});
		expect(result.source.snippet.page_path).toBe("wiki/concepts/closures.md");
		expect(result.source.snippet.location).toEqual({ kind: "heading", heading: "词法作用域" });
		expect(result.source.score).toBe(0.8);
	});

	it("distinguishes two excerpt versions of the same original document", () => {
		const before = knowledgeSnippet({
			page_path: "wiki/concepts/closures.md",
			location: { kind: "heading", heading: "词法作用域" },
			text: "闭包捕获的是变量本身，而不是变量在创建时的值。",
		});
		const after = knowledgeSnippet({
			page_path: "wiki/concepts/closures.md",
			location: { kind: "heading", heading: "词法作用域" },
			text: "闭包捕获的是变量本身；循环里的 var 因此共享同一个绑定。",
		});

		// Same page, same location, different adopted text.
		expect(before.page_path).toBe(after.page_path);
		expect(before.content_hash).not.toBe(after.content_hash);
		expect(sameSnippet(before, after)).toBe(false);

		// The original document hash is unchanged in both: it cannot tell them apart.
		const originalHash = "aaaaaaaaaaaaaaaa";
		expect(before.content_hash).not.toBe(originalHash);
		expect(after.content_hash).not.toBe(originalHash);
	});

	it("treats identical text at the same location as the same excerpt", () => {
		const text = "闭包捕获的是变量本身。";
		const a = knowledgeSnippet({ page_path: "wiki/concepts/closures.md", location: { kind: "whole_page" }, text });
		const b = knowledgeSnippet({ page_path: "wiki/concepts/closures.md", location: { kind: "whole_page" }, text });
		expect(sameSnippet(a, b)).toBe(true);
		expect(a.content_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(a.char_count).toBe(text.length);
	});

	it("separates the same text filed under different locations", () => {
		const text = "闭包捕获的是变量本身。";
		const heading = knowledgeSnippet({ page_path: "wiki/concepts/closures.md", location: { kind: "heading", heading: "定义" }, text });
		const lines = knowledgeSnippet({ page_path: "wiki/concepts/closures.md", location: { kind: "line_range", start_line: 10, end_line: 12 }, text });
		expect(sameSnippet(heading, lines)).toBe(false);
	});
});

describe("traceability is not verification", () => {
	it("keeps availability, review status and contested as three independent facts", () => {
		const source = parseKnowledgeSource({
			kind: "l2_archive",
			provenance: { source_id: "src_1", origin: "user_upload", original_content_hash: "aaaaaaaaaaaaaaaa" },
			snippet: {
				page_path: "wiki/concepts/closures.md",
				location: { kind: "whole_page" },
				content_hash: "bbbbbbbbbbbbbbbb",
				char_count: 10,
			},
			assessment: { availability: "available", review_status: "draft", contested: false },
			score: null,
		});

		if (source.kind !== "l2_archive") throw new Error("expected an archived source");
		// A resolvable source that nobody reviewed and nobody disputed.
		expect(source.assessment).toEqual({ availability: "available", review_status: "draft", contested: false });
		// There is no boolean claiming the content is true.
		expect(Object.keys(source.assessment).sort()).toEqual(["availability", "contested", "review_status"]);
		expect(JSON.stringify(source)).not.toMatch(/verified|fact_checked|is_true/);
	});

	it("accepts an unreviewed page as a valid traceable source", () => {
		const parsed = parseKnowledgeSource({
			kind: "l2_archive",
			provenance: { source_id: "src_1", origin: "user_upload", original_content_hash: "aaaaaaaaaaaaaaaa" },
			snippet: { page_path: "wiki/concepts/x.md", location: { kind: "whole_page" }, content_hash: "bbbbbbbbbbbbbbbb", char_count: 1 },
			assessment: { availability: "available", review_status: "unknown", contested: true },
			score: 0.5,
		});
		if (parsed.kind !== "l2_archive") throw new Error("expected an archived source");
		expect(parsed.assessment.review_status).toBe("unknown");
		expect(parsed.assessment.contested).toBe(true);
	});
});

describe("model knowledge cannot carry a citation", () => {
	it("rejects any citation-shaped field on a model source", () => {
		for (const extra of [
			{ source_id: "src_1" },
			{ page_path: "wiki/concepts/closures.md" },
			{ url: "https://example.com/textbook" },
			{ page: 42 },
			{ citation: "第 3 章" },
			{ provenance: {} },
			{ snippet: {} },
		]) {
			expect(() => parseKnowledgeSource({
				kind: "model_knowledge",
				model: MODEL,
				ground: "no_source_requested",
				...extra,
			})).toThrow(KnowledgeSourceError);
		}
	});

	it("keeps the model source shape closed at exactly kind/model/ground", () => {
		const parsed = parseKnowledgeSource({ kind: "model_knowledge", model: MODEL, ground: "no_source_requested" });
		// Adding a citation field later would have to change this list on purpose.
		expect(Object.keys(parsed).sort()).toEqual(["ground", "kind", "model"]);
	});

	it("keeps an unreported model version null and refuses an invented one", () => {
		const parsed = parseKnowledgeSource({ kind: "model_knowledge", model: MODEL, ground: "no_source_requested" });
		if (parsed.kind !== "model_knowledge") throw new Error("expected model knowledge");
		expect(parsed.model.model_version).toBeNull();
		expect(parsed.model.version_source).toBe("unavailable");

		expect(() => parseKnowledgeSource({
			kind: "model_knowledge",
			model: { provider_id: "fixture", model_id: "dummy", model_version: null, version_source: "provider_reported" },
			ground: "no_source_requested",
		})).toThrow(KnowledgeSourceError);

		expect(() => parseKnowledgeSource({
			kind: "model_knowledge",
			model: { provider_id: "fixture", model_id: "dummy", model_version: "2026-01-01", version_source: "unavailable" },
			ground: "no_source_requested",
		})).toThrow(KnowledgeSourceError);
	});
});

describe("untrusted input is rejected", () => {
	it("rejects unsafe or non-wiki page paths", () => {
		for (const pagePath of [
			"../../etc/passwd",
			"/etc/passwd",
			"wiki/../../secret.md",
			"wiki/./concepts/x.md",
			"wiki\\concepts\\closures.md",
			"concepts/closures.md",
			"wiki/concepts/closures.txt",
			"wiki//closures.md",
			"wiki/concepts/\0.md",
		]) {
			expect(() => knowledgeSnippet({ page_path: pagePath, location: { kind: "whole_page" }, text: "x" }))
				.toThrow(KnowledgeSourceError);
		}
	});

	it("rejects invalid identifiers and hashes", () => {
		expect(() => parseKnowledgeCandidate({
			...candidate(),
			provenance: { source_id: "..", origin: "user_upload", original_content_hash: "aaaaaaaaaaaaaaaa" },
		})).toThrow(KnowledgeSourceError);

		expect(() => parseKnowledgeCandidate({
			...candidate(),
			provenance: { source_id: "src_1", origin: "user_upload", original_content_hash: "not-a-hash" },
		})).toThrow(KnowledgeSourceError);

		expect(() => parseKnowledgeCandidate({
			...candidate(),
			snippet: { page_path: "wiki/x.md", location: { kind: "whole_page" }, content_hash: "ZZZZ", char_count: 1 },
		})).toThrow(KnowledgeSourceError);
	});

	it("rejects unknown origins, statuses, scores and extra fields", () => {
		expect(() => parseKnowledgeCandidate({
			...candidate(),
			provenance: { source_id: "src_1", origin: "crawler", original_content_hash: "aaaaaaaaaaaaaaaa" },
		})).toThrow(KnowledgeSourceError);

		expect(() => parseKnowledgeCandidate({
			...candidate(),
			assessment: { availability: "available", review_status: "verified", contested: false },
		})).toThrow(KnowledgeSourceError);

		expect(() => parseKnowledgeCandidate({ ...candidate(), score: 3 })).toThrow(KnowledgeSourceError);
		expect(() => parseKnowledgeCandidate({ ...candidate(), note: "trust me" })).toThrow(KnowledgeSourceError);
	});

	it("rejects malformed requests instead of guessing a policy", () => {
		expect(() => parseKnowledgeRequest({})).toThrow(KnowledgeSourceError);
		expect(() => parseKnowledgeRequest({ allow_model_fallback: "yes" })).toThrow(KnowledgeSourceError);
		expect(() => parseKnowledgeRequest({ allow_model_fallback: true, designated: { by: "email", value: "a@b" } }))
			.toThrow(KnowledgeSourceError);
		expect(() => parseKnowledgeRequest({ allow_model_fallback: true, designated: { by: "content_hash", value: "short" } }))
			.toThrow(KnowledgeSourceError);
	});

	it("fails closed when a candidate is malformed", () => {
		expect(() => selectKnowledgeSource({
			request: request({ allow_model_fallback: true }),
			candidates: [{ ...candidate(), snippet: { ...candidate().snippet, page_path: "../x.md" } }],
			model: MODEL,
		})).toThrow(KnowledgeSourceError);
	});

	it("rejects an unknown source kind", () => {
		expect(() => parseKnowledgeSource({ kind: "learner_profile", learner_id: "u1" })).toThrow(KnowledgeSourceError);
		expect(() => parseKnowledgeSource({ kind: "web_page", url: "https://example.com" })).toThrow(KnowledgeSourceError);
	});
});

describe("compatibility with existing learning records", () => {
	it("leaves LearningQuestion untouched and adds no source field to it", () => {
		const question: LearningQuestion = {
			question_id: "q1",
			question_version: "1",
			concept_id: "concept_closure",
			prompt: "解释闭包与词法作用域的关系。",
			kind: "free_recall",
			rubric_version: "r1",
			rubric: [{ criterion_id: "c1", description: "说明捕获的是变量", weight: 1 }],
			hints: ["想想循环里的 var"],
			reference_answer: "闭包捕获变量本身。",
		};

		// The public projection is unchanged by C0: same six fields, no provenance.
		expect(Object.keys(publicQuestion(question)).sort()).toEqual([
			"concept_id", "goal_id", "kind", "prompt", "question_id", "question_version",
		]);
		expect(Object.keys(question)).not.toContain("knowledge_source");

		// And a knowledge source cannot smuggle a question payload either.
		expect(() => parseKnowledgeSource({
			kind: "model_knowledge",
			model: MODEL,
			ground: "no_source_requested",
			question,
		})).toThrow(KnowledgeSourceError);
	});

	it("keeps a snippet usable as plain JSON for a future optional field", () => {
		const snippet: KnowledgeSnippet = knowledgeSnippet({
			page_path: "wiki/concepts/closures.md",
			location: { kind: "line_range", start_line: 3, end_line: 9 },
			text: "闭包捕获变量本身。",
		});
		const roundTripped = parseKnowledgeSource({
			kind: "l2_archive",
			provenance: { source_id: "src_1", origin: "user_upload", original_content_hash: "aaaaaaaaaaaaaaaa" },
			snippet: JSON.parse(JSON.stringify(snippet)),
			assessment: assessment(),
			score: null,
		});
		if (roundTripped.kind !== "l2_archive") throw new Error("expected an archived source");
		expect(roundTripped.snippet).toEqual(snippet);
	});
});
