import { join } from "node:path";
import { readTextAsync } from "../storage/file-store.js";
import { publicQuestion } from "./contracts.js";
import { LearningRecordError, type LearningRecordStore } from "./record-store.js";
import { selectKnowledgeSource, type KnowledgeCandidate, type KnowledgeSource } from "./knowledge-source.js";
import { adoptableExcerpt, designatedCandidates, retrievalCandidates, type KnowledgeLookupDeps } from "./knowledge-lookup.js";
import { generateQuestion, type GeneratedQuestion, type QuestionGenerationFailureCode } from "./question-generator.js";
import { requestFingerprint, type QuestionGenerationRequest } from "./question-request.js";
import type { ModelCompletion } from "../shared/model-completion.js";
import type { LearningModelIdentity, LearningQuestion, PublicLearningQuestion } from "../memory/learner/types.js";

/**
 * C1 orchestration: knowledge selection → model generation → atomic commit.
 *
 * The order is deliberate and mirrors the task's reliability contract:
 *
 *   read record → check state → **outside the lock**: choose knowledge, call
 *   the model, validate → **inside the lock**: re-check session/record/
 *   revision/state/idempotency → append question, set awaiting_answer, bump
 *   revision once.
 *
 * Nothing is written before validation, so a failed generation leaves the
 * record byte-identical and the checkpoint untouched.
 */

export interface QuestionServiceDeps {
	learningRecordStore: LearningRecordStore;
	l2DataDir: string;
	/** L2 switch from the effective capabilities. */
	l2Enabled: boolean;
	/** Indexed search; `null` means "retrieval unavailable", not "no matches". */
	search: ((query: string) => Promise<unknown[] | null>) | null;
	complete: ModelCompletion;
	/** Runtime-reported identity, used only to decide model fallback. */
	currentModel: () => LearningModelIdentity | null;
	sessionExists: (sessionId: string) => boolean;
	/** Injected for deterministic tests. */
	now?: () => Date;
	lookup?: KnowledgeLookupDeps;
}

export type QuestionServiceFailure = {
	ok: false;
	status: 400 | 404 | 409 | 422 | 502 | 503;
	error: string;
	message: string;
	revision?: number;
	code?: QuestionGenerationFailureCode | "designated_unavailable" | "l2_unavailable" | "conflicting_sources" | "needs_input";
};

export type QuestionServiceResult =
	| {
		ok: true;
		created: boolean;
		record: Awaited<ReturnType<LearningRecordStore["create"]>>;
		question: LearningQuestion;
		publicQuestion: PublicLearningQuestion;
		/** Public source type for the UI: never the page path or the excerpt. */
		knowledge: "l2_document" | "model_knowledge";
	}
	| QuestionServiceFailure;

function failure(status: QuestionServiceFailure["status"], error: string, message: string, extra?: Partial<QuestionServiceFailure>): QuestionServiceFailure {
	return { ok: false, status, error, message, ...extra };
}

function mapRecordError(err: LearningRecordError): QuestionServiceFailure {
	switch (err.code) {
		case "RECORD_NOT_FOUND":
			return failure(404, "learning_not_found", "学习记录不存在，请先初始化。");
		case "RECORD_CONFLICT":
			return failure(409, "learning_conflict", "学习状态已更新，请重新加载后再试。", { revision: err.currentRevision });
		case "RECORD_STATE_INVALID":
			return failure(409, "learning_state_invalid", "当前检查点状态不允许出题。");
		case "RECORD_CORRUPT":
			return failure(422, "learning_corrupt", "学习记录已损坏，已停止写入。");
		case "RECORD_WRITER_LOCK":
		case "RECORD_LOCK_LOST":
		case "RECORD_CLOSED":
			return failure(503, "learning_read_only", "学习记录暂时不可写（可能由另一个进程持有写入权）。");
		default:
			return failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
}

export async function generateAndCommitQuestion(
	deps: QuestionServiceDeps,
	sessionId: string,
	request: QuestionGenerationRequest,
): Promise<QuestionServiceResult> {
	// 1. The record must already exist. Generation never initialises one.
	let existing;
	try {
		existing = await deps.learningRecordStore.get(sessionId);
	} catch (err) {
		return err instanceof LearningRecordError ? mapRecordError(err) : failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
	if (!existing) return failure(404, "learning_not_found", "学习记录不存在，请先初始化。");

	const fingerprint = requestFingerprint(request);

	// 2. Idempotent replay: a retry returns its own question even with a stale
	//    revision, and never triggers a second model call.
	const replay = existing.questions.find((question) => question.generation?.request_id === request.request_id);
	if (replay) {
		if (replay.generation?.fingerprint !== fingerprint) {
			return failure(409, "request_conflict", "该请求 ID 已用于不同的出题请求。", {
				revision: existing.checkpoint.revision,
			});
		}
		return {
			ok: true,
			created: false,
			record: existing,
			question: replay,
			publicQuestion: publicQuestion(replay),
			knowledge: replay.knowledge?.kind === "model_knowledge" ? "model_knowledge" : "l2_document",
		};
	}

	// 3. Cheap state checks before spending a model call.
	if (existing.checkpoint.revision !== request.expected_revision) {
		return failure(409, "learning_conflict", "学习状态已更新，请重新加载后再试。", {
			revision: existing.checkpoint.revision,
		});
	}
	if (existing.checkpoint.status !== "active") {
		return failure(409, "learning_state_invalid", "学习检查点不是进行中状态，不能出题。");
	}
	if (existing.checkpoint.pending_attempt_id) {
		return failure(409, "learning_state_invalid", "存在尚未完成的作答，不能出题。");
	}
	if (existing.checkpoint.step !== "conversation" || existing.checkpoint.question) {
		return failure(409, "learning_state_invalid", "当前已有待作答的题目。", {
			revision: existing.checkpoint.revision,
		});
	}

	// 4. Knowledge selection, outside the write boundary.
	let candidates: KnowledgeCandidate[] = [];
	if (request.designated) {
		candidates = await designatedCandidates(deps.l2DataDir, request.designated, deps.lookup).catch(() => []);
	} else if (deps.search && deps.l2Enabled) {
		const retrieval = await retrievalCandidates(deps.l2DataDir, request.concept_label, {
			...deps.lookup,
			search: deps.search as KnowledgeLookupDeps["search"],
		});
		if (retrieval.status === "unavailable") {
			// A broken index must not be reported as "the knowledge base is empty".
			return failure(503, "l2_unavailable", "知识库检索暂不可用，请稍后重试或指定资料。");
		}
		candidates = retrieval.candidates;
	}

	const selection = selectKnowledgeSource({
		request: {
			...(request.designated ? { designated: request.designated } : {}),
			query: request.concept_label,
			...(request.goal_id ? { goal_id: request.goal_id } : {}),
			concept_id: request.concept_id,
			allow_model_fallback: request.allow_model_fallback && !request.designated,
		},
		candidates,
		// Only needed when the selector actually falls back to model knowledge.
		model: deps.currentModel(),
	});

	if (selection.status !== "selected") {
		if (selection.status === "needs_input") {
			if (selection.reason === "designated_not_found") {
				return failure(404, "designated_not_found", "指定的资料在知识库中找不到，请确认后重试。");
			}
			if (selection.reason === "designated_ambiguous") {
				return failure(409, "designated_ambiguous", "指定的资料匹配到多份来源，请选择其中一份。");
			}
			return failure(409, "conflicting_sources", "多份资料说法不一致，请先确认采用哪一份。");
		}
		if (selection.reason === "designated_unavailable") {
			return failure(409, "designated_unavailable", "指定的资料内容已变化或无法读取，不能作为本次出题依据。");
		}
		if (selection.reason === "model_fallback_disallowed") {
			return failure(422, "no_knowledge_source", "没有可用的知识依据，且未允许使用模型知识。");
		}
		// model_identity_unavailable / no_matching_source
		return failure(503, "model_not_ready", "模型尚未就绪，请先完成模型配置。");
	}

	// 5. Keep the adopted excerpt so history survives later L2 edits.
	const adoptedText = selection.source.kind === "model_knowledge"
		? undefined
		: await readAdoptedText(deps, selection.source, candidates);

	// 6. Generate and validate. Any failure here writes nothing.
	const generation = await generateQuestion(
		{ complete: deps.complete, now: deps.now },
		{
			concept_label: request.concept_label,
			concept_id: request.concept_id,
			...(request.goal_id ? { goal_id: request.goal_id } : {}),
			...(request.kind ? { kind: request.kind } : {}),
			knowledge: selection.source,
			snippet_text: adoptedText,
			snippet_title: selection.source.kind === "model_knowledge" ? undefined : selection.source.snippet.page_path,
		},
	);
	if (!generation.ok) {
		const status = generation.code === "model_not_ready" ? 503
			: generation.code === "model_timeout" ? 503
				: generation.code === "model_error" || generation.code === "empty_output" ? 502
					: 422;
		return failure(status, generation.code, generation.message, { code: generation.code });
	}

	// 7. Commit inside the record store's serialized write boundary.
	const question = toLearningQuestion(generation.question, request);
	try {
		const committed = await deps.learningRecordStore.commitQuestion(sessionId, {
			requestId: request.request_id,
			fingerprint,
			expectedRevision: request.expected_revision,
			question,
			sessionExists: () => deps.sessionExists(sessionId),
		});
		return {
			ok: true,
			created: committed.created,
			record: committed.record,
			question: committed.question,
			publicQuestion: publicQuestion(committed.question),
			knowledge: committed.question.knowledge?.kind === "model_knowledge" ? "model_knowledge" : "l2_document",
		};
	} catch (err) {
		return err instanceof LearningRecordError
			? mapRecordError(err)
			: failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
}

/**
 * Read the exact excerpt the selection points at.
 *
 * Uses the same extractor the candidate builder used, so the text re-hashed by
 * `toStoredKnowledge` matches the snapshot the selection carries. A page that
 * changed between selection and commit therefore fails the comparison instead
 * of being bound to a stale identity.
 */
async function readAdoptedText(
	deps: QuestionServiceDeps,
	source: KnowledgeSource,
	candidates: readonly KnowledgeCandidate[],
): Promise<string | undefined> {
	if (source.kind === "model_knowledge") return undefined;
	const candidate = candidates.find((item) => item.provenance.source_id === source.provenance.source_id
		&& item.snippet.page_path === source.snippet.page_path
		&& item.snippet.content_hash === source.snippet.content_hash);
	if (!candidate) return undefined;
	const read = deps.lookup?.page ?? defaultPageReader;
	const text = await read(deps.l2DataDir, source.snippet.page_path);
	if (!text) return undefined;
	return adoptableExcerpt(text) ?? undefined;
}

async function defaultPageReader(l2DataDir: string, wikiPath: string): Promise<string | null> {
	const text = await readTextAsync(join(l2DataDir, wikiPath), "");
	return text ? text : null;
}

function toLearningQuestion(generated: GeneratedQuestion, request: QuestionGenerationRequest): LearningQuestion {
	return {
		question_id: generated.question_id,
		question_version: generated.question_version,
		concept_id: generated.concept_id,
		...(generated.goal_id ? { goal_id: generated.goal_id } : {}),
		prompt: generated.prompt,
		kind: generated.kind,
		rubric_version: generated.rubric_version,
		rubric: generated.rubric,
		hints: generated.hints,
		reference_answer: generated.reference_answer,
		knowledge: generated.knowledge,
		generation: { request_id: request.request_id, fingerprint: requestFingerprint(request) },
	};
}
