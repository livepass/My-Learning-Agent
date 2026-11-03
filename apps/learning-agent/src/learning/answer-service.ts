import { randomUUID } from "node:crypto";
import {
	assertSameAttempt,
	LearningContractError,
	learningRecoveryAction,
	parseAttemptSubmission,
	prepareLearningAttempt,
	validateAssessmentCandidate,
} from "./contracts.js";
import { buildScoringPrompt, parseAssessmentCandidate } from "./scoring.js";
import { LearningRecordError, type LearningRecordStore } from "./record-store.js";
import { buildEvidenceFromAssessment } from "./evidence-adapter.js";
import {
	LearnerStoreError,
	inspectEvidenceProjection,
	loadProfile,
	recordEventAndUpdateProfile,
} from "../memory/learner/profile-store.js";
import type { ModelCompletion } from "../shared/model-completion.js";
import type {
	LearningAttempt,
	LearningAttemptProgress,
	LearningCheckpoint,
	LearningEvent,
	LearningQuestion,
	LearningSessionRecord,
	ValidatedLearningAssessment,
} from "../memory/learner/types.js";

/**
 * C2 orchestration: save a learner's answer, then evaluate it reliably.
 * C3 orchestration: record evaluated answer as L1 evidence and advance checkpoint.
 *
 * Reuses the existing C1/B2 contracts unchanged — `parseAttemptSubmission`,
 * `prepareLearningAttempt`, `assertSameAttempt`, `validateAssessmentCandidate`
 * and `learningRecoveryAction` are the single source of truth for the attempt
 * state machine; this module only drives them in the right order and owns the
 * model call and evidence recording.
 */

export interface AnswerServiceDeps {
	learningRecordStore: LearningRecordStore;
	/** Parent directory of L1 learner profile & event ledger (C3). */
	learnerDataDir?: string;
	/** Optional override for L1 write operation (injected for tests). */
	recordEventAndUpdateProfile?: typeof recordEventAndUpdateProfile;
	/** Optional override for L1 read operation (injected for tests). */
	loadProfile?: typeof loadProfile;
	/** Optional override for the L1 projection inspection (injected for tests). */
	inspectEvidenceProjection?: typeof inspectEvidenceProjection;
	/** Side-channel model call used for scoring (same contract as C1 generation). */
	complete: ModelCompletion;
	/** Identifies this process for the "evaluating" recovery branch. */
	processRunId: string;
	/** Evaluation retry budget (matches the value the routes expose). */
	maxEvaluationAttempts: number;
	/** Lightweight readiness probe; false means "do not spend a retry". */
	checkModelReady?: () => Promise<boolean>;
	sessionExists: (sessionId: string) => boolean;
	now?: () => Date;
}

export type AnswerServiceFailure = {
	ok: false;
	status: 400 | 404 | 409 | 422 | 502 | 503;
	error: string;
	message: string;
	revision?: number;
};

export type SaveAnswerResult =
	| {
		ok: true;
		created: boolean;
		attempt: LearningAttempt;
		record: LearningSessionRecord;
	}
	| AnswerServiceFailure;

export type EvaluateResult =
	| {
		ok: true;
		/** Recovery action resolved the state without needing a new model call. */
		replayed: boolean;
		assessment?: ValidatedLearningAssessment;
		/** Next recovery action after this step (C3 uses this to advance). */
		pendingAction: string;
		record: LearningSessionRecord;
	}
	| AnswerServiceFailure;

function failure(status: AnswerServiceFailure["status"], error: string, message: string, extra?: Partial<AnswerServiceFailure>): AnswerServiceFailure {
	return { ok: false, status, error, message, ...extra };
}

function mapRecordError(err: LearningRecordError): AnswerServiceFailure {
	switch (err.code) {
		case "RECORD_NOT_FOUND":
			return failure(404, "learning_not_found", "学习记录或作答不存在。", { revision: err.currentRevision });
		case "RECORD_CONFLICT":
			return failure(409, "learning_conflict", "学习状态已更新，请重新加载后再试。", { revision: err.currentRevision });
		case "RECORD_STATE_INVALID":
			return failure(409, "learning_state_invalid", "当前检查点状态不允许该操作。", { revision: err.currentRevision });
		case "RECORD_CORRUPT":
			return failure(422, "learning_corrupt", "学习记录已损坏，已停止写入。");
		case "RECORD_WRITER_LOCK":
		case "RECORD_LOCK_LOST":
		case "RECORD_CLOSED":
			return failure(503, "learning_read_only", "学习记录暂时不可写。");
		default:
			return failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
}

function mapLearnerStoreError(err: LearnerStoreError): AnswerServiceFailure {
	switch (err.code) {
		case "LEARNING_RECORD_CONFLICT":
		case "ATTEMPT_IDENTITY_MISMATCH":
		case "HISTORY_IDENTITY_CONFLICT":
			return failure(409, "learning_conflict", "学习记录冲突，已拒绝覆盖原记录。");
		case "STORE_WRITE_DISABLED":
		case "STORE_UNAVAILABLE":
			return failure(503, "learning_read_only", "学习档案暂时不可写。");
		case "PROFILE_CORRUPT":
		case "EVENT_LOG_CORRUPT":
			return failure(422, "learning_corrupt", "学习档案数据已损坏。");
		default:
			return failure(503, "learning_unavailable", "学习档案暂时不可用。");
	}
}

/** Resolve the saved question a checkpoint ref points at, or undefined. */
function questionFor(record: LearningSessionRecord, questionId: string, questionVersion: string): LearningQuestion | undefined {
	return record.questions.find(
		(question) => question.question_id === questionId && question.question_version === questionVersion,
	);
}

/**
 * Save a learner's answer for the current question.
 *
 * Validation happens outside the write boundary (via `prepareLearningAttempt`),
 * then `commitAttempt` re-checks the checkpoint inside the lock and appends the
 * attempt atomically. A retried submit of the same attempt id returns its own
 * attempt without a second write.
 */
export async function saveAnswer(
	deps: AnswerServiceDeps,
	sessionId: string,
	submission: unknown,
): Promise<SaveAnswerResult> {
	let parsed;
	try {
		parsed = parseAttemptSubmission(submission);
	} catch (err) {
		return failure(400, "invalid_request", err instanceof LearningContractError ? err.message : "请求不合法");
	}

	// Read the record to resolve the question and validate outside the lock.
	let existing: LearningSessionRecord | undefined;
	try {
		existing = await deps.learningRecordStore.get(sessionId);
	} catch (err) {
		return err instanceof LearningRecordError ? mapRecordError(err) : failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
	if (!existing) return failure(404, "learning_not_found", "学习记录不存在，请先初始化。");

	const question = existing.checkpoint.question
		? questionFor(existing, existing.checkpoint.question.question_id, existing.checkpoint.question.question_version)
		: undefined;
	if (!question) return failure(409, "learning_state_invalid", "当前没有待作答的题目。");

	// Idempotent replay first: a retried submit carries a now-stale revision and
	// must find its own attempt instead of being rejected for that stale revision.
	const replayed = existing.attempts.find((candidate) => candidate.attempt_id === parsed.attempt_id);
	if (replayed) {
		try {
			assertSameAttempt(replayed, sessionId, parsed);
		} catch (err) {
			return failure(409, "learning_conflict", "该作答 ID 已用于不同的提交。", { revision: existing.checkpoint.revision });
		}
		return { ok: true, created: false, attempt: replayed, record: existing };
	}

	let attempt: LearningAttempt;
	try {
		attempt = prepareLearningAttempt(
			existing.checkpoint,
			question,
			parsed,
			existing.exposures,
			deps.now ? deps.now() : new Date(),
		);
	} catch (err) {
		// checkpoint_conflict → the client must reload; any other contract error
		// is a malformed submission (already screened by parseAttemptSubmission).
		return failure(409, "learning_conflict", err instanceof LearningContractError ? err.message : "提交被拒绝，请重新加载。", {
			revision: existing.checkpoint.revision,
		});
	}

	try {
		const committed = await deps.learningRecordStore.commitAttempt(sessionId, {
			attempt,
			expectedRevision: parsed.expected_revision,
			sessionExists: () => deps.sessionExists(sessionId),
		});
		return { ok: true, created: committed.created, attempt: committed.attempt, record: committed.record };
	} catch (err) {
		return err instanceof LearningRecordError ? mapRecordError(err) : failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
}

/**
 * Evaluate a saved attempt.
 *
 * Order, mirroring C1 generation: read → decide via `learningRecoveryAction`
 * → probe model readiness (without spending a retry) → mark `evaluating`
 * (durable) → call the model outside the lock → validate → persist `evaluated`
 * or `evaluation_failed`.
 *
 * Recovery is never re-invented: `learningRecoveryAction` alone decides whether
 * the attempt may be scored now, must wait, or has exhausted its retry budget.
 *
 * `retry` is the explicit user action for re-scoring a `evaluation_failed`
 * attempt. A plain GET/refresh never passes it, so a saved failure keeps its
 * `await_manual_retry` stance until the user asks to retry.
 */
export async function evaluateAttempt(
	deps: AnswerServiceDeps,
	sessionId: string,
	attemptId: string,
	expectedRevision: number,
	options: { retry?: boolean } = {},
): Promise<EvaluateResult> {
	let existing: LearningSessionRecord | undefined;
	try {
		existing = await deps.learningRecordStore.get(sessionId);
	} catch (err) {
		return err instanceof LearningRecordError ? mapRecordError(err) : failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
	if (!existing) return failure(404, "learning_not_found", "学习记录不存在，请先初始化。");

	const attempt = existing.attempts.find((candidate) => candidate.attempt_id === attemptId);
	if (!attempt) return failure(404, "attempt_not_found", "作答不存在。");
	const previousProgress = attempt.progress;

	const action = learningRecoveryAction(attempt, deps.processRunId, deps.maxEvaluationAttempts);
	if (action === "wait_for_running_evaluation") {
		return { ok: true, replayed: true, pendingAction: action, record: existing };
	}
	if (action === "mark_retry_limit") {
		return failure(409, "retry_limit", "该作答的评估重试次数已用尽。", { revision: existing.checkpoint.revision });
	}
	// A saved failure is not auto-retried by a refresh; the user must opt in.
	// With an explicit retry it re-enters "evaluate". `answer_saved` and a
	// dead-process `evaluating` already map to "evaluate"; anything past
	// "evaluated" is C3 territory and is returned as-is.
	if (action === "await_manual_retry" && !options.retry) {
		return { ok: true, replayed: true, pendingAction: action, record: existing };
	}
	// An explicit retry of a saved failure must still respect the retry budget:
	// `learningRecoveryAction` maps `evaluation_failed` to `await_manual_retry`
	// without checking the counter, so the check happens here.
	if (action === "await_manual_retry" && attempt.evaluation_attempts >= deps.maxEvaluationAttempts) {
		return failure(409, "retry_limit", "该作答的评估重试次数已用尽。", { revision: existing.checkpoint.revision });
	}
	if (action !== "evaluate" && action !== "await_manual_retry") {
		return { ok: true, replayed: true, pendingAction: action, record: existing };
	}

	// P1-3: do not spend a retry if the model cannot actually start a request.
	// The durable `evaluation_attempts` counter is only incremented once a real
	// request can begin; "not configured / no credentials / not ready" returns
	// here with the budget intact.
	if (deps.checkModelReady) {
		let ready: boolean;
		try {
			ready = await deps.checkModelReady();
		} catch {
			ready = false;
		}
		if (!ready) {
			return failure(503, "model_not_ready", "模型尚未就绪，请先在系统设置里配置。", {
				revision: existing.checkpoint.revision,
			});
		}
	}

	const question = questionFor(existing, attempt.question_id, attempt.question_version);
	if (!question) return failure(409, "learning_state_invalid", "作答对应的题目已不在记录中。");

	// Durable "started" marker first, so a crash mid-call is recoverable.
	const evaluationRunId = `eval_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	const evaluating: Extract<LearningAttemptProgress, { stage: "evaluating" }> = {
		stage: "evaluating",
		process_run_id: deps.processRunId,
		evaluation_run_id: evaluationRunId,
		model: { provider_id: "pending", model_id: "pending", model_version: null, version_source: "unavailable" },
		started_at: deps.now ? deps.now().toISOString() : new Date().toISOString(),
	};

	let afterBegin: LearningSessionRecord;
	try {
		afterBegin = await deps.learningRecordStore.beginEvaluation(sessionId, attemptId, {
			expectedRevision,
			progress: evaluating,
		});
	} catch (err) {
		return err instanceof LearningRecordError ? mapRecordError(err) : failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}

	// Model call outside the write boundary.
	const prompt = buildScoringPrompt({ question, answer: attempt.answer });
	const completion = await deps.complete({ prompt, maxTokens: 2_000, timeoutMs: 60_000 });

	if (completion.status === "not_ready") {
		// The probe said ready but the call itself came back not-ready (a race, or
		// the probe was absent). Do not leave the attempt stuck in "evaluating"
		// and do not count this as a consumed retry — perform a compensating rollback
		// verifying evaluationRunId so a later attempt can start cleanly without
		// spending the learner's retry budget.
		try {
			await deps.learningRecordStore.rollbackEvaluation(sessionId, attemptId, {
				expectedRevision: afterBegin.checkpoint.revision,
				evaluationRunId,
				progress: previousProgress.stage === "evaluating" ? { stage: "answer_saved" } : previousProgress,
			});
		} catch {
			// best-effort; the next evaluate will recover a stale "evaluating".
		}
		return failure(503, "model_not_ready", "模型尚未就绪，请先在系统设置里配置。");
	}
	if (completion.status !== "ok") {
		const code: "provider_error" | "timeout" = completion.status === "timeout" || completion.status === "aborted" ? "timeout" : "provider_error";
		const message = code === "timeout" ? "评估超时，请重试。" : "评估失败，请重试。";
		const failProgress: Extract<LearningAttemptProgress, { stage: "evaluation_failed" }> = {
			stage: "evaluation_failed",
			failure: { code, message, failed_at: deps.now ? deps.now().toISOString() : new Date().toISOString() },
		};
		try {
			await deps.learningRecordStore.failEvaluation(sessionId, attemptId, {
				expectedRevision: afterBegin.checkpoint.revision,
				evaluationRunId,
				progress: failProgress,
			});
		} catch (err) {
			// The failure record is best-effort; the evaluation state is still
			// "evaluating" on disk and will be recovered on the next attempt.
			if (!(err instanceof LearningRecordError)) throw err;
		}
		return failure(code === "timeout" ? 503 : 502, code === "timeout" ? "model_timeout" : "model_error", message);
	}

	// Validate the model reply and re-derive result/score server-side.
	let assessment: ValidatedLearningAssessment;
	try {
		const candidate = parseAssessmentCandidate(completion.text, question);
		assessment = validateAssessmentCandidate(
			{
				question_id: attempt.question_id,
				question_version: attempt.question_version,
				result: candidate.result,
				feedback: candidate.feedback,
				...(candidate.unknown_reason ? { unknown_reason: candidate.unknown_reason } : {}),
				criteria: candidate.criteria,
			},
			attempt,
			completion.model,
			deps.now ? deps.now() : new Date(),
		);
	} catch (err) {
		// The model produced an unparseable / inconsistent assessment. Record it
		// as an invalid assessment so a manual retry can follow.
		const failProgress: Extract<LearningAttemptProgress, { stage: "evaluation_failed" }> = {
			stage: "evaluation_failed",
			failure: {
				code: "invalid_assessment",
				message: err instanceof LearningContractError ? err.message : "模型输出未通过评分校验",
				failed_at: deps.now ? deps.now().toISOString() : new Date().toISOString(),
			},
		};
		try {
			await deps.learningRecordStore.failEvaluation(sessionId, attemptId, {
				expectedRevision: afterBegin.checkpoint.revision,
				evaluationRunId,
				progress: failProgress,
			});
		} catch (recordErr) {
			if (!(recordErr instanceof LearningRecordError)) throw recordErr;
		}
		return failure(422, "invalid_assessment", "模型输出未通过评分校验，请重试。");
	}

	try {
		const done = await deps.learningRecordStore.completeEvaluation(sessionId, attemptId, {
			expectedRevision: afterBegin.checkpoint.revision,
			evaluationRunId,
			progress: { stage: "evaluated", assessment },
		});
		return { ok: true, replayed: false, assessment, pendingAction: "publish_saved_evidence", record: done };
	} catch (err) {
		return err instanceof LearningRecordError ? mapRecordError(err) : failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
}

export interface FinalizeAttemptResultSuccess {
	ok: true;
	replayed: boolean;
	attempt: LearningAttempt;
	record: LearningSessionRecord;
	checkpoint: LearningCheckpoint;
	event: LearningEvent;
	profileVersion: number;
}

export type FinalizeAttemptResult =
	| FinalizeAttemptResultSuccess
	| AnswerServiceFailure;

/**
 * Serialize finalization per (store, session, attempt) inside this process.
 *
 * The two stores cannot share a transaction, so the only way to make a
 * concurrent duplicate submission deterministic is to let the first call
 * finish before the second one reads: the loser then sees `completed` and
 * takes the replay branch instead of racing through the intermediate stages
 * and surfacing a spurious 409. Cross-process concurrency still relies on the
 * L1 dedupe key plus the B2 stage guards — this is an optimization for the
 * common "double click" case, not a distributed lock.
 */
const finalizeQueues = new Map<string, Promise<unknown>>();

function serializeFinalize<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = finalizeQueues.get(key) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const tail = run.then(() => undefined, () => undefined);
	finalizeQueues.set(key, tail);
	void tail.finally(() => {
		if (finalizeQueues.get(key) === tail) finalizeQueues.delete(key);
	});
	return run;
}

/**
 * C3: convert an evaluated attempt into durable L1 evidence, project mastery,
 * and advance the B2 checkpoint.
 *
 * Implements crash recovery across failure windows A–F:
 * - Window A: L1 write not yet attempted -> writes L1 event, advances B2.
 * - Window B: L1 event written, projection crashed -> L1 dedupe automatically recovers projection.
 * - Window C: L1 written & projected, B2 at evaluated -> L1 dedupe returns existing event, advances B2.
 * - Window D: B2 at evidence_recorded -> advances to profile_projected then completed.
 * - Window E: B2 at profile_projected -> advances checkpoint and completes attempt.
 * - Window F: Checkpoint already completed -> returns saved result idempotently.
 */
export function finalizeAttempt(
	deps: AnswerServiceDeps,
	sessionId: string,
	attemptId: string,
	expectedRevision: number,
): Promise<FinalizeAttemptResult> {
	const key = `${deps.learningRecordStore.dataDir}\u0000${sessionId}\u0000${attemptId}`;
	return serializeFinalize(key, () => finalizeAttemptUnlocked(deps, sessionId, attemptId, expectedRevision));
}

async function finalizeAttemptUnlocked(
	deps: AnswerServiceDeps,
	sessionId: string,
	attemptId: string,
	expectedRevision: number,
): Promise<FinalizeAttemptResult> {
	if (!deps.sessionExists(sessionId)) {
		return failure(404, "learning_not_found", "学习会话不存在或已被删除。");
	}

	let existing: LearningSessionRecord | undefined;
	try {
		existing = await deps.learningRecordStore.get(sessionId);
	} catch (err) {
		return err instanceof LearningRecordError ? mapRecordError(err) : failure(503, "learning_unavailable", "学习记录暂时不可用。");
	}
	if (!existing) return failure(404, "learning_not_found", "学习记录不存在，请先初始化。");

	const attempt = existing.attempts.find((candidate) => candidate.attempt_id === attemptId);
	if (!attempt) return failure(404, "attempt_not_found", "作答不存在。");

	// Window F: Attempt is already completed -> idempotent replay.
	if (attempt.progress.stage === "completed") {
		return {
			ok: true,
			replayed: true,
			attempt,
			record: existing,
			checkpoint: existing.checkpoint,
			event: attempt.progress.event,
			profileVersion: attempt.progress.profile_version,
		};
	}

	// Verify revision for uncompleted attempts: optimistic concurrency.
	if (existing.checkpoint.revision !== expectedRevision) {
		return failure(409, "learning_conflict", "学习状态已更新，请重新加载后再试。", { revision: existing.checkpoint.revision });
	}

	// Must be the pending attempt awaiting answer/feedback
	if (existing.checkpoint.pending_attempt_id !== attemptId) {
		return failure(409, "learning_state_invalid", "该作答不是当前待处理的作答。");
	}

	// Un-evaluated attempts cannot be recorded as evidence
	const stage = attempt.progress.stage;
	if (stage === "answer_saved" || stage === "evaluating" || stage === "evaluation_failed") {
		return failure(409, "learning_state_invalid", "该作答尚未评分，不能记录学习证据。");
	}

	const learnerDataDir = deps.learnerDataDir;
	const recordFn = deps.recordEventAndUpdateProfile ?? recordEventAndUpdateProfile;
	const loadProfileFn = deps.loadProfile ?? loadProfile;
	const inspectProjectionFn = deps.inspectEvidenceProjection ?? inspectEvidenceProjection;

	// Without a data dir the real L1 implementations cannot run; callers that
	// omit it must inject every L1 dependency they exercise.
	if (!learnerDataDir && (!deps.recordEventAndUpdateProfile || !deps.inspectEvidenceProjection)) {
		return failure(503, "learning_unavailable", "学习档案存储目录未配置。");
	}

	try {
		// Window E: already at profile_projected -> complete attempt and advance checkpoint
		if (stage === "profile_projected") {
			const afterComp = await deps.learningRecordStore.completeAttempt(sessionId, attemptId, {
				expectedRevision: existing.checkpoint.revision,
				strict: false,
			});
			const finalAttempt = afterComp.attempts.find((a) => a.attempt_id === attemptId)!;
			return {
				ok: true,
				replayed: true,
				attempt: finalAttempt,
				record: afterComp,
				checkpoint: afterComp.checkpoint,
				event: attempt.progress.event,
				profileVersion: attempt.progress.profile_version,
			};
		}

		// Window D: already at evidence_recorded -> verify projection, record projection, then complete
		if (stage === "evidence_recorded") {
			// The event identity and its ledger sequence were persisted with the
			// attempt. Claiming `profile_projected` is only truthful when the ledger
			// really holds that event and the profile cursor covers it.
			const inspection = await inspectProjectionFn(learnerDataDir!, {
				event_id: attempt.progress.event.event_id,
				...(attempt.progress.event.seq !== undefined ? { seq: attempt.progress.event.seq } : {}),
			});
			if (!inspection.ledgerMatched) {
				return failure(409, "evidence_missing", "学习证据尚未写入权威账本，请重试。");
			}
			if (!inspection.ruleVersionMatched) {
				return failure(503, "projection_pending", "画像投影规则版本待重建，暂不能完成本次记录。");
			}
			// Owner-side recovery already ran inside the inspection; a remaining lag
			// means this process could not project (read-only or L1 unavailable).
			if (!inspection.projected) {
				return failure(503, "projection_pending", "画像投影尚未覆盖该证据，请稍后重试。");
			}
			const afterProj = await deps.learningRecordStore.recordProfileProjected(sessionId, attemptId, {
				expectedRevision: existing.checkpoint.revision,
				profileVersion: inspection.appliedSeq,
				strict: false,
			});
			const afterComp = await deps.learningRecordStore.completeAttempt(sessionId, attemptId, {
				expectedRevision: afterProj.checkpoint.revision,
				strict: false,
			});
			const finalAttempt = afterComp.attempts.find((a) => a.attempt_id === attemptId)!;
			return {
				ok: true,
				replayed: true,
				attempt: finalAttempt,
				record: afterComp,
				checkpoint: afterComp.checkpoint,
				event: attempt.progress.event,
				profileVersion: inspection.appliedSeq,
			};
		}

		// Windows A, B, C: stage === "evaluated"
		const currentProfile = await loadProfileFn(learnerDataDir!);
		const learnerId = currentProfile.learner_id || "default";

		const candidateEvent = buildEvidenceFromAssessment(
			attempt,
			learnerId,
			deps.now ? deps.now() : new Date(),
		);

		const recordResult = await recordFn(learnerDataDir!, candidateEvent);
		const committedEvent = recordResult.event;
		const profileVersion = recordResult.profile.version;

		// B2 transitions
		const afterEv = await deps.learningRecordStore.recordEvidence(sessionId, attemptId, {
			expectedRevision: existing.checkpoint.revision,
			event: committedEvent,
			strict: false,
		});
		const afterProj = await deps.learningRecordStore.recordProfileProjected(sessionId, attemptId, {
			expectedRevision: afterEv.checkpoint.revision,
			profileVersion,
			strict: false,
		});
		const afterComp = await deps.learningRecordStore.completeAttempt(sessionId, attemptId, {
			expectedRevision: afterProj.checkpoint.revision,
			strict: false,
		});
		const finalAttempt = afterComp.attempts.find((a) => a.attempt_id === attemptId)!;

		return {
			ok: true,
			replayed: recordResult.status === "duplicate",
			attempt: finalAttempt,
			record: afterComp,
			checkpoint: afterComp.checkpoint,
			event: committedEvent,
			profileVersion,
		};
	} catch (err) {
		if (err instanceof LearnerStoreError) {
			return mapLearnerStoreError(err);
		}
		if (err instanceof LearningRecordError) {
			return mapRecordError(err);
		}
		throw err;
	}
}
