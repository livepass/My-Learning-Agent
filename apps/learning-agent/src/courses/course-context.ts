import { isSafeRecordId } from "./types.js";
import type { CourseStore } from "./course-store.js";

/**
 * E4.1a — the single server-side course-context resolver.
 *
 * L1, L2, L3 and B2 must all answer "which course is this request about?" the
 * same way. The only authority is the persisted `CourseSessionBinding`; a
 * client may state an intent (the course it believes it is in), but that is a
 * claim to be checked against the binding, never a scope to be trusted.
 *
 * Deliberately absent: any inference from a session title, chat topic or L2
 * content. A session without a binding is 「未归类」 and stays there.
 */

export type ResolvedCourseContext =
	| {
		status: "course";
		sessionId: string;
		courseId: string;
		courseTitle: string;
		/**
		 * E4.7-R1: the parent course is archived. The session stays readable,
		 * but learning progress (new questions, answers, evidence) must be
		 * refused; callers check this before writing.
		 */
		courseArchived: boolean;
		taskId: string | null;
		/**
		 * Active L2 source ids of this course. An empty array is a real scope:
		 * the course has no material, so retrieval must return nothing rather
		 * than widen to the whole knowledge base.
		 */
		sourceIds: readonly string[];
		goalIds: readonly string[];
	}
	| { status: "unclassified"; sessionId: string };

export type CourseContextErrorCode =
	| "course_context_invalid"
	| "course_intent_mismatch"
	| "concept_course_mismatch";

export class CourseContextError extends Error {
	readonly code: CourseContextErrorCode;

	constructor(code: CourseContextErrorCode, message: string) {
		super(message);
		this.name = "CourseContextError";
		this.code = code;
	}
}

/**
 * Resolve a session's course from persisted state.
 *
 * `undefined` store (route tests, or a deployment without the course domain)
 * means every session is unclassified, matching pre-E4.1 behaviour. A store
 * read failure is not swallowed here: the caller decides whether the request
 * can continue without a scope, instead of this helper silently widening it.
 */
export async function resolveCourseContext(
	store: CourseStore | undefined,
	sessionId: string,
): Promise<ResolvedCourseContext> {
	if (!isSafeRecordId(sessionId)) {
		throw new CourseContextError("course_context_invalid", "会话 ID 不合法，无法解析课程上下文");
	}
	if (!store) return { status: "unclassified", sessionId };
	const context = await store.getSessionContext(sessionId);
	if (!context) return { status: "unclassified", sessionId };
	return {
		status: "course",
		sessionId,
		courseId: context.course.course_id,
		courseTitle: context.course.title,
		courseArchived: context.course.status === "archived",
		taskId: context.binding.task_id,
		sourceIds: [...context.sourceIds].sort(),
		goalIds: [...context.goalIds].sort(),
	};
}

/**
 * Check a client's course selection against the persisted binding.
 *
 * - unbound session + a claimed course → mismatch (a client cannot create an
 *   association by asserting one);
 * - bound session + another course → mismatch (course switching must never
 *   move an existing conversation);
 * - no claim → accepted, the binding decides.
 */
export function assertClientCourseIntent(
	context: ResolvedCourseContext,
	requestedCourseId: unknown,
): void {
	if (requestedCourseId === undefined || requestedCourseId === null || requestedCourseId === "") return;
	if (!isSafeRecordId(requestedCourseId)) {
		throw new CourseContextError("course_context_invalid", "课程 ID 不合法");
	}
	if (context.status === "unclassified") {
		throw new CourseContextError("course_intent_mismatch", "该会话尚未归属任何课程，不能按指定课程访问");
	}
	if (context.courseId !== requestedCourseId) {
		throw new CourseContextError("course_intent_mismatch", "会话已属于另一门课程，不能切换课程上下文");
	}
}

/**
 * L2/L3 retrieval scope.
 *
 * `undefined` = unclassified legacy session, keep the pre-E4.1 global scope.
 * `[]` = a course with no material, which must retrieve nothing. Collapsing
 * these two would either leak other courses' material into a new course or
 * silently widen an empty course to the whole knowledge base.
 */
export function retrievalSourceScope(context: ResolvedCourseContext): readonly string[] | undefined {
	return context.status === "course" ? context.sourceIds : undefined;
}

export interface ConceptScopeState {
	concept_id: string;
	course_id?: string;
}

export type ConceptScopeCheck =
	| { ok: true }
	| { ok: false; conceptCourseId: string };

/**
 * Reject reusing another course's concept identity.
 *
 * A concept with no `course_id` is legacy/unclassified: it may be practised in
 * any course, and stays unclassified in L1 (it is never retroactively adopted).
 * A concept already attributed to a different course must not be written into
 * this course's evidence — that is exactly the "Python 函数 vs 高数 函数"
 * merge this contract exists to prevent.
 */
export function checkConceptScope(
	states: readonly ConceptScopeState[],
	conceptId: string,
	courseId: string,
): ConceptScopeCheck {
	const state = states.find((candidate) => candidate.concept_id === conceptId);
	if (!state?.course_id || state.course_id === courseId) return { ok: true };
	return { ok: false, conceptCourseId: state.course_id };
}
