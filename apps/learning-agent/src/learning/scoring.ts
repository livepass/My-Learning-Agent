import { LearningContractError } from "./contracts.js";
import type { LearningCriterionJudgment, LearningQuestion } from "../memory/learner/types.js";

/**
 * C2 scoring: build the assessment prompt and parse the model's reply.
 *
 * The model only produces prose and per-criterion judgments; the `result`
 * (correct/partial/incorrect/unknown) and the numeric `score` are re-derived by
 * the server in `validateAssessmentCandidate` from those judgments. A model
 * therefore cannot dictate a score or a result — it can only state which
 * criteria were met and why, and the server computes the consequence.
 */

export const MAX_FEEDBACK_CHARS = 8_000;
export const MAX_EXPLANATION_CHARS = 4_000;

const JUDGMENTS: readonly LearningCriterionJudgment[] = ["met", "partially_met", "not_met", "unknown"];

/** The only fields the model may supply; everything else is server-owned. */
export interface ParsedAssessmentCandidate {
	result: "correct" | "partial" | "incorrect" | "unknown";
	feedback: string;
	unknown_reason?: string;
	criteria: { criterion_id: string; judgment: LearningCriterionJudgment; explanation: string }[];
}

function fail(message: string): never {
	throw new LearningContractError("invalid_assessment", message);
}

function stripCodeFence(raw: string): string {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
	return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonObject(raw: string): unknown {
	const body = stripCodeFence(raw);
	try {
		return JSON.parse(body);
	} catch {
		const start = body.indexOf("{");
		const end = body.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			return JSON.parse(body.slice(start, end + 1));
		} catch {
			return undefined;
		}
	}
}

function boundedText(value: unknown, max: number, field: string): string {
	if (typeof value !== "string") fail(`${field} 缺失或不是字符串`);
	const trimmed = value.trim();
	if (!trimmed) fail(`${field} 为空`);
	if (trimmed.length > max) fail(`${field} 超过长度上限`);
	return trimmed;
}

/**
 * Build the assessment prompt.
 *
 * The answer and the reference material are untrusted data and are fenced; the
 * actual guarantee is that the reply is parsed against a closed schema and the
 * result/score are re-derived server-side.
 */
export function buildScoringPrompt(input: {
	question: LearningQuestion;
	answer: string;
}): string {
	const { question, answer } = input;
	const rubricLines = question.rubric
		.map((item, index) => `- ${item.criterion_id}：${item.description}（权重 ${item.weight}）`)
		.join("\n");
	return [
		"你是一位严谨的评分助手。根据给定的评分标准，评估学生作答。",
		"只输出一个 JSON 对象，不要输出代码块标记、解释或其他文字。",
		"字段：",
		'- "result": "correct" | "partial" | "incorrect" | "unknown"',
		'- "feedback": 反馈文本，字符串，说明学生哪里做得好、哪里需要改进',
		'- "criteria": 数组，每条评分标准对应一项 {"criterion_id": 标准 ID, "judgment": "met" | "partially_met" | "not_met" | "unknown", "explanation": 判定理由}',
		'仅当 "result" 为 "unknown" 时输出 "unknown_reason" 字段，说明为什么无法判定',
		"不要输出题目 ID、作答 ID、模型名称或任何分数；这些由系统填写。",
		"",
		"<<<QUESTION",
		question.prompt,
		"QUESTION>>>",
		"",
		"<<<RUBRIC",
		rubricLines,
		"RUBRIC>>>",
		"",
		"<<<REFERENCE_ANSWER",
		question.reference_answer,
		"REFERENCE_ANSWER>>>",
		"",
		"<<<STUDENT_ANSWER",
		answer,
		"STUDENT_ANSWER>>>",
	].join("\n");
}

/**
 * Parse the model's assessment reply.
 *
 * Strict: extra keys are rejected, judgments must be from the closed set, and
 * `result` must be consistent with the judgments (re-checked again by the caller
 * via `validateAssessmentCandidate`). Nothing here computes a score — the caller
 * does that from the rubric weights.
 */
export function parseAssessmentCandidate(raw: string, question: LearningQuestion): ParsedAssessmentCandidate {
	const parsed = extractJsonObject(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("模型输出不是单个对象");
	const record = parsed as Record<string, unknown>;
	const allowed = ["result", "feedback", "unknown_reason", "criteria"];
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) fail(`模型输出包含不允许的字段: ${key}`);
	}
	const result = record.result;
	if (typeof result !== "string" || !["correct", "partial", "incorrect", "unknown"].includes(result)) {
		fail("评分结果不在允许范围内");
	}
	const feedback = boundedText(record.feedback, MAX_FEEDBACK_CHARS, "反馈");
	if (!Array.isArray(record.criteria) || record.criteria.length === 0) fail("评分标准判定至少需要一条");
	if (record.criteria.length !== question.rubric.length) fail("评分标准判定条数与题目不一致");

	const criteria = record.criteria.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) fail("评分标准判定条目不是对象");
		const entry = item as Record<string, unknown>;
		for (const key of Object.keys(entry)) {
			if (!["criterion_id", "judgment", "explanation"].includes(key)) fail("评分标准判定条目包含不允许的字段");
		}
		const id = entry.criterion_id;
		if (typeof id !== "string" || !id) fail("评分标准 ID 缺失");
		const judgment = entry.judgment;
		if (typeof judgment !== "string" || !(JUDGMENTS as readonly string[]).includes(judgment)) {
			fail("评分标准判定不在允许范围内");
		}
		return {
			criterion_id: id,
			judgment: judgment as LearningCriterionJudgment,
			explanation: boundedText(entry.explanation, MAX_EXPLANATION_CHARS, "判定理由"),
		};
	});

	const candidate: ParsedAssessmentCandidate = {
		result: result as ParsedAssessmentCandidate["result"],
		feedback,
		criteria,
	};
	if (result === "unknown") {
		candidate.unknown_reason = boundedText(record.unknown_reason, 4_000, "无法判定原因");
	} else if (record.unknown_reason !== undefined) {
		fail("非 unknown 结果不应带 unknown_reason");
	}
	return candidate;
}
