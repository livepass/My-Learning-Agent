import { EventEmitter } from "./event-emitter.js";
import { appStore } from "./app-store.js";
import { sessionsStore } from "./sessions-store.js";
import { startCourseLearning } from "../api/courses.js";
import { courseFromLocation, navigate } from "../react/shell/navigation.js";

interface LearnWorkbenchEvents {
	change: void;
}

/**
 * The conversation a first send just created.
 *
 * `courseId` is the scope the send belongs to; the composer re-checks it before
 * dispatching the prompt, so a switch that happened during creation can never
 * turn A's question into a message inside B.
 */
export interface CreatedConversation {
	sessionId: string;
	courseId: string;
}

function errorMessage(error: unknown): string {
	const data = (error as { data?: Record<string, unknown> } | undefined)?.data;
	if (data && typeof data.message === "string" && data.message) return data.message;
	if (error instanceof Error && error.message) return error.message;
	return "创建学习对话失败，请重试。";
}

/** A request id is a single idempotency key: retrying the same creation reuses it. */
function newRequestId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return `learn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	}
	return `learn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * E4.8 — state of the AI learning workbench.
 *
 * Deliberately separate from `coursesStore.selectedCourseId`: that field drives
 * the course-detail page, and switching it clears plans, sources, records and
 * pending writes. The workbench only needs *which course the chat is inside*, so
 * it owns that selection here and reads the course list from `coursesStore`
 * without touching its scoped state.
 *
 * A conversation is never created by selecting a course. The first send calls
 * `ensureConversation`, which uses `POST /api/courses/:id/learning/start` with
 * `task_id: null` — the server binds the new session to the course before the
 * message is allowed to leave the composer.
 */
class LearnWorkbenchStoreImpl extends EventEmitter<LearnWorkbenchEvents> {
	/** The course whose conversations the workbench shows. `null` = nothing selected. */
	courseId: string | null = null;
	/** True while `learning/start` is running; blocks a second click. */
	creating = false;
	/** Failure of the last creation attempt; the draft stays in the composer. */
	error: string | null = null;

	private _requestId: string | null = null;
	private _epoch = 0;

	private notify(): void {
		this.emit("change", undefined);
	}

	/**
	 * Apply the URL to the workbench.
	 *
	 * `?course=` is the selected course. A URL without `?session=` means "no
	 * conversation open", so an in-memory conversation from the previous page is
	 * closed — Back must not keep showing a chat the address no longer names.
	 */
	applyLocation(search?: string): void {
		const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
		const hasSession = Boolean(new URLSearchParams(query).get("session"));
		const closesSession = !hasSession && Boolean(sessionsStore.currentSessionId);
		if (closesSession) sessionsStore.showWelcomeFromHistory();
		const nextCourse = courseFromLocation(query);
		if (nextCourse === this.courseId && !closesSession && !this.error) return;
		// Any location change retires an in-flight creation: its result belongs to
		// the address (and the course) the learner has already left.
		this._epoch += 1;
		this.courseId = nextCourse;
		this._requestId = null;
		this.error = null;
		this.notify();
	}

	/**
	 * Select a course and show its empty workbench.
	 *
	 * The previous course's conversation is closed first: its messages, model
	 * cards and any half-typed draft belong to a page the learner just left.
	 * Nothing is deleted — the binding, transcript and learning record stay.
	 */
	selectCourse(courseId: string | null, options: { history?: "push" | "replace" } = {}): void {
		if (this.courseId === courseId) return;
		this.closeConversation();
		this.courseId = courseId;
		this._requestId = null;
		this.error = null;
		if (typeof window !== "undefined") {
			navigate("learn", {
				history: options.history ?? "push",
				learn: { courseId, session: null },
			});
		}
		this.notify();
	}

	/**
	 * Adopt the course a session is actually bound to (server truth).
	 *
	 * Used after `?session=` is opened: the URL's `?course=` may be stale or
	 * wrong, and a message must never be sent under the wrong course. The URL is
	 * corrected with `replace` so Back does not return to the wrong pairing.
	 */
	adoptCourse(courseId: string | null): void {
		if (this.courseId === courseId) return;
		this._epoch += 1;
		this._requestId = null;
		this.courseId = courseId;
		this.error = null;
		if (typeof window !== "undefined") {
			navigate("learn", { history: "replace", learn: { courseId } });
		}
		this.notify();
	}

	/** Start a new conversation in the selected course (created on first send). */
	beginConversation(): void {
		this.closeConversation();
		this._requestId = null;
		this.error = null;
		this.notify();
	}

	/**
	 * Create (or recover) the conversation for the first turn.
	 *
	 * The attempt is bound to the course that was selected when it started and to
	 * the workbench's epoch:
	 *
	 * - switching course, starting another new conversation, or leaving the
	 *   workbench bumps the epoch, so a late answer returns `null` and never opens
	 *   a conversation under the new course;
	 * - `request_id` survives a failure, so retrying the same click returns the
	 *   conversation the failed attempt already created instead of a duplicate;
	 * - the created conversation is never deleted when the UI moved on — the
	 *   server binding and its B2 record stay intact.
	 */
	async ensureConversation(): Promise<CreatedConversation | null> {
		const courseId = this.courseId;
		const openSessionId = sessionsStore.currentSessionId;
		if (openSessionId) {
			// Nothing to create: the send belongs to the open conversation and its
			// course. Without a course (legacy unclassified history) the composer is
			// read-only, so this is a programming error, not a send.
			if (!courseId) {
				this.error = "请先选择课程。";
				this.notify();
				return null;
			}
			return { sessionId: openSessionId, courseId };
		}
		if (!courseId) {
			this.error = "请先选择课程。";
			this.notify();
			return null;
		}
		if (this.creating) return null;
		const requestId = this._requestId ?? newRequestId();
		this._requestId = requestId;
		const epoch = this._epoch;
		this.creating = true;
		this.error = null;
		this.notify();
		try {
			const started = await startCourseLearning(courseId, { task_id: null, request_id: requestId });
			// Superseded while the server was working: do not open it, do not send,
			// and do not overwrite the new course's error/draft state.
			if (epoch !== this._epoch || this.courseId !== courseId) return null;
			this._requestId = null;
			const sessionId = started.session.session_id;
			// The server has bound the session to the course and created its B2
			// record; only now may the message be sent.
			await sessionsStore.openSession(sessionId, { historyMode: "replace" });
			void sessionsStore.refresh();
			return { sessionId, courseId };
		} catch (err) {
			if (epoch === this._epoch) this.error = errorMessage(err);
			return null;
		} finally {
			if (epoch === this._epoch) {
				this.creating = false;
				this.notify();
			}
		}
	}

	/**
	 * True when the workbench still shows this course (and, if given, this
	 * conversation). Checked immediately before the prompt is dispatched.
	 */
	isCurrent(courseId: string | null, sessionId: string | null): boolean {
		if (this.courseId !== courseId) return false;
		if (sessionId === null) return true;
		return sessionsStore.currentSessionId === sessionId;
	}

	clearError(): void {
		if (!this.error) return;
		this.error = null;
		this.notify();
	}

	reset(): void {
		this._epoch += 1;
		this.courseId = null;
		this.creating = false;
		this.error = null;
		this._requestId = null;
	}

	/** Close the open conversation without deleting anything. */
	private closeConversation(): void {
		this._epoch += 1;
		if (sessionsStore.currentSessionId || !sessionsStore.pendingNewSession) {
			sessionsStore.beginNewSession();
		}
		appStore.setChatDraft("");
	}
}

export const learnWorkbenchStore = new LearnWorkbenchStoreImpl();
