import { createHash } from "node:crypto";
import { looksLikeSyntheticConceptLabel } from "../shared/concept-id.js";
import { LearningContractError } from "./contracts.js";
import { QUESTION_KINDS } from "./question-generator.js";
import type { KnowledgeDesignationKind } from "./knowledge-source.js";
import type { LearningQuestion } from "../memory/learner/types.js";

/**
 * Parsing of a C1 generation request.
 *
 * The client owns only what the user actually chose: a concept label, an
 * optional goal, an optional document designation and the retry identity. It
 * never supplies provenance, assessment, question ids or model identity — those
 * are server-resolved, so a tampered payload cannot claim a source.
 */

export const MAX_CONCEPT_LABEL_CHARS = 120;
export const MAX_REQUEST_ID_CHARS = 128;

const DESIGNATION_KINDS: readonly KnowledgeDesignationKind[] = ["source_id", "content_hash", "source_identity"];

export interface QuestionGenerationRequest {
	concept_label: string;
	concept_id: string;
	goal_id?: string;
	kind?: LearningQuestion["kind"];
	designated?: { by: KnowledgeDesignationKind; value: string };
	allow_model_fallback: boolean;
	request_id: string;
	expected_revision: number;
	/**
	 * C4: the completed attempt this question continues from.
	 *
	 * Optional so pre-C4 clients keep working. It only *names* an attempt; the
	 * store still verifies that the attempt exists, is completed, and belongs to
	 * the checkpoint's question. A client cannot use it to claim progress.
	 */
	after_attempt_id?: string;
	/**
	 * C4-C: the learner started this generation from a due-review entry.
	 *
	 * Only `"review"` is accepted, and it is stored as question provenance. It is
	 * *not* proof that the concept is due any more — the review entry re-reads the
	 * L1 profile before generating — and it never adds evidence of its own.
	 */
	intent?: "review";
}

function bad(message: string): never {
	throw new LearningContractError("invalid_input", message);
}

function objectOf(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) bad("请求体必须是对象");
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) bad(`请求包含未知字段: ${key}`);
	}
	return record;
}

function identifierOf(value: unknown, field: string, maxLength = 128): string {
	if (typeof value !== "string" || !new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,${maxLength - 1}}$`).test(value)) {
		bad(`${field} 不合法`);
	}
	return value;
}

function trimmedText(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") bad(`${field} 必须是字符串`);
	const trimmed = value.trim();
	if (!trimmed) bad(`${field} 不能为空`);
	if (trimmed.length > maxLength) bad(`${field} 超过长度上限`);
	return trimmed;
}

/**
 * Stable, repeatable concept id for a free-text topic.
 *
 * Without a course scope the digest is exactly the pre-E4.1 formula, so every
 * existing concept id keeps resolving to the same L1 state and evidence. With a
 * course scope the course id is part of the hash: 「函数」 in 高等数学 and
 * 「函数」 in Python 编程 become different identities instead of merging into
 * one knowledge state. The id shape (`concept_<12 hex>`) is unchanged, so all
 * existing guards and UI label checks keep working.
 *
 * Limitation, recorded on purpose: this is exact-string matching, not synonym
 * resolution. "闭包" and "JavaScript 闭包" derive different ids, and nothing here
 * touches the L1 profile.
 */
export interface ConceptIdScope {
	/** Persisted course id; `null`/absent keeps the legacy unscoped identity. */
	courseId?: string | null;
}

export function deriveConceptId(label: string, scope: ConceptIdScope = {}): string {
	const normalized = label.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
	const courseId = typeof scope.courseId === "string" ? scope.courseId.trim() : "";
	const material = courseId ? `course\u0000${courseId}\u0000${normalized}` : normalized;
	const digest = createHash("sha256").update(material).digest("hex").slice(0, 12);
	return `concept_${digest}`;
}

/**
 * Fingerprint of the *user-meaningful* request.
 *
 * Retry identity: the same `request_id` may only replay the same intent. The
 * revision is excluded on purpose — a legitimate retry after a crash carries a
 * stale revision and must still find its question rather than conflict.
 *
 * `after_attempt_id` is included only when present: folding a `null` placeholder
 * into every payload would change the fingerprint of requests committed before
 * C4, turning their legitimate retries into false conflicts. `intent` follows the
 * same rule, so questions saved before C4-C keep their original fingerprint.
 */
export function requestFingerprint(request: Omit<QuestionGenerationRequest, "request_id" | "expected_revision">): string {
	const canonical = JSON.stringify({
		concept: request.concept_label,
		concept_id: request.concept_id,
		goal_id: request.goal_id ?? null,
		kind: request.kind ?? null,
		designated: request.designated ?? null,
		allow_model_fallback: request.allow_model_fallback,
		...(request.after_attempt_id ? { after_attempt_id: request.after_attempt_id } : {}),
		...(request.intent ? { intent: request.intent } : {}),
	});
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function parseQuestionRequest(value: unknown, scope: ConceptIdScope = {}): QuestionGenerationRequest {
	const record = objectOf(value, [
		"concept", "concept_id", "goal_id", "kind", "designated",
		"allow_model_fallback", "request_id", "expected_revision", "after_attempt_id", "intent",
	]);

	const conceptLabel = trimmedText(record.concept, "知识点", MAX_CONCEPT_LABEL_CHARS);
	// A machine-minted identity is not a topic. Rejecting it here keeps a hash
	// from becoming the model's natural-language subject (the UI also refuses to
	// prefill such a name, but the server is the boundary that matters).
	if (looksLikeSyntheticConceptLabel(conceptLabel)) {
		bad("知识点名称不能使用系统生成的标识，请填写真实的知识点名称");
	}
	const conceptId = record.concept_id === undefined
		? deriveConceptId(conceptLabel, scope)
		: identifierOf(record.concept_id, "知识点 ID");

	const goalId = record.goal_id === undefined ? undefined : identifierOf(record.goal_id, "学习目标 ID");
	if (record.kind !== undefined && (typeof record.kind !== "string" || !(QUESTION_KINDS as readonly string[]).includes(record.kind))) {
		bad("题目类型不在允许范围内");
	}

	let designated: QuestionGenerationRequest["designated"];
	if (record.designated !== undefined) {
		const entry = objectOf(record.designated, ["by", "value"]);
		if (!DESIGNATION_KINDS.includes(entry.by as KnowledgeDesignationKind)) bad("指定资料的标识方式不合法");
		const by = entry.by as KnowledgeDesignationKind;
		const raw = trimmedText(entry.value, "指定资料", 300);
		if (by === "source_id") identifierOf(raw, "指定资料 ID");
		if (by === "content_hash" && !/^[0-9a-f]{16}$/.test(raw)) bad("指定资料的内容哈希不合法");
		designated = { by, value: raw };
	}

	if (typeof record.allow_model_fallback !== "boolean") bad("allow_model_fallback 必须是布尔值");

	if (typeof record.request_id !== "string" || !record.request_id.trim() || record.request_id.length > MAX_REQUEST_ID_CHARS) {
		bad("request_id 不合法");
	}
	// Request ids are client-generated; keep them to a safe, opaque alphabet.
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(record.request_id)) bad("request_id 不合法");

	const revision = record.expected_revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
		bad("expected_revision 必须是非负整数");
	}

	const afterAttemptId = record.after_attempt_id === undefined
		? undefined
		: identifierOf(record.after_attempt_id, "上一题作答 ID");

	// Only a review intent exists today; anything else is a client error rather
	// than silently ignored, so a typo cannot look like a normal request.
	if (record.intent !== undefined && record.intent !== "review") bad("intent 只接受 review");

	return {
		concept_label: conceptLabel,
		concept_id: conceptId,
		...(goalId ? { goal_id: goalId } : {}),
		...(record.kind ? { kind: record.kind as LearningQuestion["kind"] } : {}),
		...(designated ? { designated } : {}),
		allow_model_fallback: record.allow_model_fallback,
		request_id: record.request_id,
		expected_revision: revision,
		...(afterAttemptId ? { after_attempt_id: afterAttemptId } : {}),
		...(record.intent === "review" ? { intent: "review" as const } : {}),
	};
}
