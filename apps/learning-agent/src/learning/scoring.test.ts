import { describe, expect, it } from "vitest";
import { LearningContractError } from "./contracts.js";
import { buildScoringPrompt, parseAssessmentCandidate } from "./scoring.js";
import type { LearningQuestion } from "../memory/learner/types.js";

const question: LearningQuestion = {
	question_id: "q1",
	question_version: "1",
	concept_id: "concept_closure",
	prompt: "解释闭包为什么持有外层变量。",
	kind: "free_recall",
	rubric_version: "c1-v1",
	rubric: [
		{ criterion_id: "c1", description: "指出捕获的是变量本身", weight: 2 },
		{ criterion_id: "c2", description: "说明生命周期被延长", weight: 1 },
	],
	hints: ["先想想变量存在哪里"],
	reference_answer: "闭包捕获变量绑定，不是值的副本。",
};

const validCandidate = {
	result: "partial",
	feedback: "指出了变量绑定，但没说明生命周期。",
	criteria: [
		{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" },
		{ criterion_id: "c2", judgment: "not_met", explanation: "未说明生命周期" },
	],
};

describe("scoring prompt", () => {
	it("fences the question, rubric, reference answer and student answer", () => {
		const prompt = buildScoringPrompt({ question, answer: "我的回答" });
		expect(prompt).toContain("<<<QUESTION");
		expect(prompt).toContain("<<<RUBRIC");
		expect(prompt).toContain("<<<REFERENCE_ANSWER");
		expect(prompt).toContain("<<<STUDENT_ANSWER");
		expect(prompt).toContain("我的回答");
		expect(prompt).toContain("c1");
		// The model must not decide a score or result.
		expect(prompt).toContain("这些由系统填写");
	});

	it("forbids the model from supplying ids or scores", () => {
		const prompt = buildScoringPrompt({ question, answer: "x" });
		expect(prompt).toContain("不要输出题目 ID");
		expect(prompt).toContain("不要输出");
	});
});

describe("assessment candidate parsing", () => {
	it("accepts a complete, consistent candidate", () => {
		const parsed = parseAssessmentCandidate(JSON.stringify(validCandidate), question);
		expect(parsed.result).toBe("partial");
		expect(parsed.feedback).toBe(validCandidate.feedback);
		expect(parsed.criteria).toHaveLength(2);
		expect(parsed.criteria[0]).toEqual(validCandidate.criteria[0]);
	});

	it("tolerates one fenced JSON block", () => {
		expect(() => parseAssessmentCandidate("```json\n" + JSON.stringify(validCandidate) + "\n```", question)).not.toThrow();
	});

	it("rejects a reply that is not a single object", () => {
		expect(() => parseAssessmentCandidate("not json", question)).toThrow(LearningContractError);
		expect(() => parseAssessmentCandidate("", question)).toThrow(LearningContractError);
		expect(() => parseAssessmentCandidate(JSON.stringify([validCandidate]), question)).toThrow(LearningContractError);
	});

	it("rejects criteria whose count does not match the rubric", () => {
		const short = { ...validCandidate, criteria: validCandidate.criteria.slice(1) };
		expect(() => parseAssessmentCandidate(JSON.stringify(short), question)).toThrow(/条数/);
	});

	it("rejects an unknown judgment or result", () => {
		expect(() => parseAssessmentCandidate(JSON.stringify({ ...validCandidate, result: "genius" }), question)).toThrow(LearningContractError);
		const badJudgment = { ...validCandidate, criteria: [{ criterion_id: "c1", judgment: "great", explanation: "x" }, validCandidate.criteria[1]] };
		expect(() => parseAssessmentCandidate(JSON.stringify(badJudgment), question)).toThrow(LearningContractError);
	});

	it("requires unknown_reason only for an unknown result", () => {
		expect(() => parseAssessmentCandidate(JSON.stringify({ ...validCandidate, unknown_reason: "多余" }), question)).toThrow(LearningContractError);
		const unknown = { ...validCandidate, result: "unknown", unknown_reason: "主体指代不清" };
		expect(parseAssessmentCandidate(JSON.stringify(unknown), question).unknown_reason).toBe("主体指代不清");
	});

	it("rejects fields the model does not own", () => {
		for (const extra of [{ score: 0.5 }, { model: "gpt-4" }, { attempt_id: "a1" }, { question_id: "q2" }]) {
			expect(() => parseAssessmentCandidate(JSON.stringify({ ...validCandidate, ...extra }), question)).toThrow(LearningContractError);
		}
	});

	it("rejects empty feedback", () => {
		expect(() => parseAssessmentCandidate(JSON.stringify({ ...validCandidate, feedback: "  " }), question)).toThrow(LearningContractError);
	});
});
