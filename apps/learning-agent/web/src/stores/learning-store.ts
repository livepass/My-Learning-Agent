import { EventEmitter } from "./event-emitter.js";
import {
	describeGenerationError,
	describeLearningError,
	evaluateAnswer,
	generateLearningQuestion,
	getLearningState,
	initLearning,
	pauseLearning,
	resumeLearning,
	submitAnswer,
	type GenerateQuestionInput,
	type LearningState,
	type PublicAssessment,
	type PublicAttemptView,
	type PublicLearningQuestion,
} from "../api/learning.js";

interface LearningStoreEvents {
	change: void;
}

/**
 * UI state for the current session's learning checkpoint.
 *
 * Deliberately not a second persistence layer: the authoritative record lives
 * on the server (`learning/<sessionId>.json`) and meta.json only carries a
 * rebuildable projection. This store mirrors the last read so the page can
 * render status/step/revision and offer pause/resume.
 *
 * Async isolation — reads and writes have *separate* lifetimes:
 *
 *   reads   `load()`; the newest read owns `isLoading`
 *   writes  `init()` / `pause()` / `resume()`; the newest write owns `isSaving`
 *
 * A read therefore never invalidates a write, and a write never invalidates
 * another write's bookkeeping. Both kinds still check the session before
 * painting, so a response for a conversation the user has left is dropped.
 * `clear()` invalidates both.
 *
 * A completed write outranks any read that was issued before it committed:
 * otherwise a slow reload could repaint the pre-write revision over the
 * server's freshly applied checkpoint.
 */
class LearningStoreImpl extends EventEmitter<LearningStoreEvents> {
	sessionId: string | null = null;
	state: LearningState | null = null;
	isLoading = false;
	isSaving = false;
	error: string | null = null;
	/** A question generation call is in flight for the current session. */
	isGenerating = false;
	/** Failure of the last generation attempt; cleared on the next attempt. */
	generateError: string | null = null;
	/** An answer submission is in flight for the current session. */
	isSubmitting = false;
	/** Failure of the last answer submission; cleared on the next attempt. */
	submitError: string | null = null;
	/** An evaluation (model scoring) call is in flight for the current session. */
	isEvaluating = false;
	/** Failure of the last evaluation; cleared on the next attempt. */
	evaluateError: string | null = null;
	/** The latest public assessment, when one has been returned. */
	assessment: PublicAssessment | null = null;

	/** Newest read ticket; a newer read invalidates older reads only. */
	private _readTicket = 0;
	/** Newest write ticket; a newer write invalidates older writes only. */
	private _writeTicket = 0;
	/** Session whose newest read is still in flight. */
	private _readingSession: string | null = null;
	/** Session whose newest write is still in flight. */
	private _savingSession: string | null = null;
	/** Newest generation ticket; separate from writes because it is long-running. */
	private _generateTicket = 0;
	/** Session whose newest generation is still in flight. */
	private _generatingSession: string | null = null;
	/** Newest submission ticket (separate from evaluation). */
	private _submitTicket = 0;
	/** Session whose newest submission is still in flight. */
	private _submittingSession: string | null = null;
	/** Newest evaluation ticket (long-running model call). */
	private _evaluateTicket = 0;
	/** Session whose newest evaluation is still in flight. */
	private _evaluatingSession: string | null = null;
	/** Retry identity for the last failed attempt, keyed by its payload. */
	private _pendingRequest: { key: string; id: string } | null = null;
	/** Retry identity for the last answer submission, keyed by its payload. */
	private _pendingAttempt: { key: string; id: string } | null = null;

	/**
	 * Flags are derived, never assigned ad hoc: a flag is on only while the
	 * newest operation of its kind belongs to the session currently on screen.
	 * That is what keeps a save on A from disabling controls on B, and what
	 * keeps a pending save visible when a reload for A starts.
	 */
	private syncFlags(): void {
		this.isLoading = this._readingSession !== null && this._readingSession === this.sessionId;
		this.isSaving = this._savingSession !== null && this._savingSession === this.sessionId;
		this.isGenerating = this._generatingSession !== null && this._generatingSession === this.sessionId;
		this.isSubmitting = this._submittingSession !== null && this._submittingSession === this.sessionId;
		this.isEvaluating = this._evaluatingSession !== null && this._evaluatingSession === this.sessionId;
	}

	private notify(): void {
		this.emit("change", undefined);
	}

	private beginRead(sessionId: string): number {
		this._readingSession = sessionId;
		const ticket = ++this._readTicket;
		this.syncFlags();
		return ticket;
	}

	/** Only the newest read may clear the loading flag. */
	private endRead(ticket: number): void {
		if (ticket !== this._readTicket) return;
		this._readingSession = null;
		this.syncFlags();
	}

	private beginWrite(sessionId: string): number {
		this._savingSession = sessionId;
		const ticket = ++this._writeTicket;
		this.syncFlags();
		return ticket;
	}

	/** Only the newest write may clear the saving flag. */
	private endWrite(ticket: number): void {
		if (ticket !== this._writeTicket) return;
		this._savingSession = null;
		this.syncFlags();
	}

	/** True when a newer write has taken over from `ticket`. */
	private writeWasSuperseded(ticket: number): boolean {
		return ticket !== this._writeTicket;
	}

	/**
	 * Settle a successful write.
	 *
	 * Returns true when the caller should paint the result. Clears the saving
	 * flag for the winning write, and drops any read that was issued earlier for
	 * the same session because the write is now the freshest known state.
	 */
	private commitWrite(ticket: number, sessionId: string): boolean {
		if (this.writeWasSuperseded(ticket)) return false;
		this._savingSession = null;
		if (this.sessionId !== sessionId) {
			this.syncFlags();
			return false;
		}
		if (this._readingSession === sessionId) {
			// That read was issued before this write committed; its payload is older.
			this._readTicket += 1;
			this._readingSession = null;
		}
		return true;
	}

	/** Read-only load. Never initialises a missing record. */
	async load(sessionId: string): Promise<void> {
		if (this.sessionId !== sessionId) {
			this.sessionId = sessionId;
			this.state = null;
			this.error = null;
			// Errors and the assessment belong to the session that produced them;
			// switching conversations must not carry a stale failure/result over.
			this.generateError = null;
			this.submitError = null;
			this.evaluateError = null;
			this.assessment = null;
		}
		const ticket = this.beginRead(sessionId);
		this.notify();
		try {
			const state = await getLearningState(sessionId);
			if (ticket !== this._readTicket || this.sessionId !== sessionId) return;
			this.state = state;
			this.error = null;
		} catch (err) {
			if (ticket !== this._readTicket || this.sessionId !== sessionId) return;
			this.state = null;
			this.error = describeLearningError(err);
		} finally {
			this.endRead(ticket);
			this.notify();
		}
	}

	clear(): void {
		// Invalidate in-flight reads and writes: neither may restore the state
		// the caller just cleared, and neither may re-arm a flag we reset here.
		this._readTicket += 1;
		this._writeTicket += 1;
		this._generateTicket += 1;
		this._submitTicket += 1;
		this._evaluateTicket += 1;
		this._readingSession = null;
		this._savingSession = null;
		this._generatingSession = null;
		this._submittingSession = null;
		this._evaluatingSession = null;
		this._pendingRequest = null;
		this._pendingAttempt = null;
		this.sessionId = null;
		this.state = null;
		this.error = null;
		this.generateError = null;
		this.submitError = null;
		this.evaluateError = null;
		this.assessment = null;
		this.syncFlags();
		this.notify();
	}

	/** Explicit user action: create the record for the current session. */
	async init(goalId?: string): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId) return;
		const ticket = this.beginWrite(sessionId);
		this.notify();
		try {
			await initLearning(sessionId, goalId);
			const state = await getLearningState(sessionId);
			if (this.commitWrite(ticket, sessionId)) {
				this.state = state;
				this.error = null;
			}
		} catch (err) {
			if (this.writeWasSuperseded(ticket)) return;
			this._savingSession = null;
			if (this.sessionId === sessionId) this.error = describeLearningError(err);
		} finally {
			this.endWrite(ticket);
			this.notify();
		}
	}

	async pause(): Promise<void> {
		await this.transition("pause");
	}

	async resume(): Promise<void> {
		await this.transition("resume");
	}

	private async transition(action: "pause" | "resume"): Promise<void> {
		const sessionId = this.sessionId;
		const revision = this.state?.checkpoint?.revision;
		if (!sessionId || revision === undefined) return;
		const ticket = this.beginWrite(sessionId);
		// Snapshot so a conflict refresh cannot clobber a read that started later.
		const readTicketAtStart = this._readTicket;
		this.notify();
		try {
			const checkpoint = action === "pause"
				? await pauseLearning(sessionId, revision)
				: await resumeLearning(sessionId, revision);
			// The server already applied this to session A; only the UI write is
			// conditional, so switching to B never shows A's checkpoint.
			if (this.commitWrite(ticket, sessionId)) {
				this.state = { ...(this.state ?? { exists: true }), exists: true, checkpoint };
				this.error = null;
			}
		} catch (err) {
			if (this.writeWasSuperseded(ticket)) return;
			this._savingSession = null;
			if (this.sessionId !== sessionId) {
				this.syncFlags();
				return;
			}
			const message = describeLearningError(err);
			// A conflict means someone else advanced the checkpoint: refresh so the
			// UI shows the current revision instead of retrying blindly. The refresh
			// keeps this write's ticket, so it can only ever update this session and
			// the error stays visible afterwards.
			await this.refreshQuietly(sessionId, ticket, readTicketAtStart);
			if (this.writeWasSuperseded(ticket)) return;
			if (this.sessionId !== sessionId) return;
			this.error = message;
		} finally {
			this.endWrite(ticket);
			this.notify();
		}
	}

	/**
	 * Generate one question for the current session.
	 *
	 * Long-running and therefore on its own ticket: a generation in flight must
	 * not invalidate a pause/resume, and switching sessions must not let a late
	 * result paint the new one. The request id is reused across retries of the
	 * same payload, so the server can answer with the already-committed question
	 * instead of generating a second one.
	 */
	async generate(input: GenerateQuestionInputInput): Promise<boolean> {
		const sessionId = this.sessionId;
		const revision = this.state?.checkpoint?.revision;
		if (!sessionId) {
			this.generateError = "请先打开一段学习会话。";
			this.notify();
			return false;
		}
		if (revision === undefined) {
			this.generateError = "学习状态尚未加载完成，请稍后重试。";
			this.notify();
			return false;
		}
		const requestId = this.requestIdFor(sessionId, input);
		const ticket = ++this._generateTicket;
		this._generatingSession = sessionId;
		this.generateError = null;
		this.syncFlags();
		this.notify();
		try {
			const result = await generateLearningQuestion(sessionId, {
				...input,
				request_id: requestId,
				expected_revision: revision,
			});
			if (ticket !== this._generateTicket || this.sessionId !== sessionId) return true;
			this.state = {
				...(this.state ?? { exists: true }),
				exists: true,
				checkpoint: result.checkpoint,
				questions: mergeQuestions(this.state?.questions, result.question),
			};
			this.error = null;
			this.generateError = null;
			// The committed question outranks a read issued before it.
			if (this._readingSession === sessionId) {
				this._readTicket += 1;
				this._readingSession = null;
			}
			// Committed: the next generation is a new request, not a retry.
			this._pendingRequest = null;
			return true;
		} catch (err) {
			if (ticket !== this._generateTicket || this.sessionId !== sessionId) return false;
			this.generateError = describeGenerationError(err);
			if ((err as { status?: number }).status === 409) {
				// Revision moved: refresh so the next attempt carries the new one.
				await this.load(sessionId).catch(() => undefined);
			}
			return false;
		} finally {
			if (ticket === this._generateTicket) {
				this._generatingSession = null;
				this.syncFlags();
				this.notify();
			}
		}
	}

	/**
	 * Submit the learner's answer for the current question.
	 *
	 * The attempt id is generated client-side and reused across retries of the
	 * same payload, so a retried submit finds its own answer instead of saving a
	 * second one.
	 */
	async submitAnswer(answer: string): Promise<boolean> {
		const sessionId = this.sessionId;
		const question = this.state?.checkpoint?.question;
		const revision = this.state?.checkpoint?.revision;
		if (!sessionId || !question || revision === undefined) {
			this.submitError = "当前没有可作答的题目。";
			this.notify();
			return false;
		}
		const attemptId = this.attemptIdFor(sessionId, question.question_id, question.question_version, answer);
		const ticket = ++this._submitTicket;
		this._submittingSession = sessionId;
		this.submitError = null;
		this.syncFlags();
		this.notify();
		try {
			const result = await submitAnswer(sessionId, {
				attempt_id: attemptId,
				question_id: question.question_id,
				question_version: question.question_version,
				answer,
				expected_revision: revision,
			});
			if (ticket !== this._submitTicket || this.sessionId !== sessionId) return true;
			// Merge, not replace: the route's checkpoint omits the question ref and
			// knowledge badge, which the page still needs to render.
			const committedAttempt: PublicAttemptView = {
				attempt_id: result.attempt.attempt_id,
				question_id: result.attempt.question_id,
				question_version: result.attempt.question_version,
				answer,
				accepted_at: result.attempt.accepted_at,
				stage: "answer_saved",
				retryable: false,
				evaluation_attempts: 0,
			};
			this.state = {
				...(this.state ?? { exists: true }),
				exists: true,
				checkpoint: { ...this.state?.checkpoint, ...result.checkpoint },
				attempts: [
					...(this.state?.attempts ?? []).filter((a) => a.attempt_id !== committedAttempt.attempt_id),
					committedAttempt,
				],
			};
			this.submitError = null;
			return true;
		} catch (err) {
			if (ticket !== this._submitTicket || this.sessionId !== sessionId) return false;
			this.submitError = describeGenerationError(err);
			return false;
		} finally {
			if (ticket === this._submitTicket) {
				this._submittingSession = null;
				this.syncFlags();
				this.notify();
			}
		}
	}

	/**
	 * Ask the server to evaluate the saved answer, or `retry` a failed one.
	 *
	 * Long-running (model scoring) and therefore on its own ticket. After a
	 * successful evaluation the store re-reads the public state so the full
	 * attempt view (answer + assessment/failure + retryability) is available.
	 */
	async evaluateAnswer(retry = false): Promise<boolean> {
		const sessionId = this.sessionId;
		const attemptId = this.state?.checkpoint?.pending_attempt_id;
		const revision = this.state?.checkpoint?.revision;
		if (!sessionId || !attemptId || revision === undefined) {
			this.evaluateError = "当前没有待评估的作答。";
			this.notify();
			return false;
		}
		const ticket = ++this._evaluateTicket;
		this._evaluatingSession = sessionId;
		this.evaluateError = null;
		this.syncFlags();
		this.notify();
		try {
			const result = await evaluateAnswer(sessionId, attemptId, revision, { retry });
			if (ticket !== this._evaluateTicket || this.sessionId !== sessionId) return true;
			this.state = {
				...(this.state ?? { exists: true }),
				exists: true,
				checkpoint: { ...this.state?.checkpoint, ...result.checkpoint },
			};
			if (result.assessment) this.assessment = result.assessment;
			this.evaluateError = null;
			// Re-read so the attempt view (answer + stage + failure + retryable)
			// reflects the durable record, not just this response.
			await this.load(sessionId).catch(() => undefined);
			return true;
		} catch (err) {
			if (ticket !== this._evaluateTicket || this.sessionId !== sessionId) return false;
			this.evaluateError = describeGenerationError(err);
			// A failed evaluation still moves the durable attempt to
			// "evaluation_failed"; re-read so the page shows "重新评分" instead of
			// a stale "开始评分".
			await this.load(sessionId).catch(() => undefined);
			return false;
		} finally {
			if (ticket === this._evaluateTicket) {
				this._evaluatingSession = null;
				this.syncFlags();
				this.notify();
			}
		}
	}

	/**
	 * The current pending attempt's public view, when one exists. Derived from
	 * the last read state so the page renders "answer saved / evaluating /
	 * evaluated / failed" without ever guessing from local flags.
	 */
	get currentAttempt(): PublicAttemptView | undefined {
		const pendingId = this.state?.checkpoint?.pending_attempt_id;
		if (!pendingId) return undefined;
		return this.state?.attempts?.find((attempt) => attempt.attempt_id === pendingId);
	}

	/** Stable attempt id for one (question, answer) pair, reused across retries. */
	private attemptIdFor(sessionId: string, questionId: string, questionVersion: string, answer: string): string {
		const key = JSON.stringify([sessionId, questionId, questionVersion, answer]);
		if (this._pendingAttempt?.key === key) return this._pendingAttempt.id;
		const id = newRequestId();
		this._pendingAttempt = { key, id };
		return id;
	}

	/**
	 * Stable id for one user intent.
	 *
	 * A failure that the user retries unchanged keeps its id (the server may have
	 * committed before the response was lost); changing the concept starts a new
	 * request.
	 */
	private requestIdFor(sessionId: string, input: GenerateQuestionInputInput): string {
		// Every field the server folds into its request fingerprint must be part of
		// this key too: omitting `kind` would let two different question types share
		// one retry id and then collide server-side as "same id, different intent".
		const key = JSON.stringify([sessionId, input.concept, input.concept_id ?? "", input.goal_id ?? "",
			input.kind ?? "", input.designated ?? null, input.allow_model_fallback]);
		if (this._pendingRequest?.key === key) return this._pendingRequest.id;
		const id = newRequestId();
		this._pendingRequest = { key, id };
		return id;
	}

	/**
	 * Re-read a session's state after a failed write.
	 *
	 * Never claims a ticket: the caller's `finally` still owns the saving flag.
	 * Applies only when the session is still current, this write is still the
	 * newest, and no read has been issued since the write started — anything
	 * newer already carries at least as fresh a payload.
	 */
	private async refreshQuietly(sessionId: string, ticket: number, readTicketAtStart: number): Promise<void> {
		try {
			const state = await getLearningState(sessionId);
			if (this.writeWasSuperseded(ticket)) return;
			if (this._readTicket !== readTicketAtStart) return;
			if (this.sessionId !== sessionId) return;
			this.state = state;
		} catch {
			// Keep the previous state; the caller surfaces the transition error.
		}
	}
}

function mergeQuestions(
	current: readonly PublicLearningQuestion[] | undefined,
	question: PublicLearningQuestion,
): PublicLearningQuestion[] {
	const rest = (current ?? []).filter(
		(item) => !(item.question_id === question.question_id && item.question_version === question.question_version),
	);
	return [...rest, question];
}

function newRequestId(): string {
	const globalCrypto = globalThis.crypto as Crypto | undefined;
	if (globalCrypto?.randomUUID) return `qg_${globalCrypto.randomUUID().replace(/-/g, "")}`;
	return `qg_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Caller-supplied fields; the store adds the retry id and revision. */
export type GenerateQuestionInputInput = Omit<GenerateQuestionInput, "request_id" | "expected_revision">;

export const learningStore = new LearningStoreImpl();
