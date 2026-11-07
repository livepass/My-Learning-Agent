import type { CourseStore } from "../../courses/course-store.js";
import { CourseStoreError } from "../../courses/course-store.js";
import { isSafeRecordId } from "../../courses/types.js";

/**
 * E4.4b — the one place that answers "which past conversations may this
 * session recall?".
 *
 * The answer comes from persisted `CourseSessionBinding` rows only. A course
 * id supplied by the model, the prompt or the client is never an input: the
 * `l3_recall` tool has no course parameter, and this resolver only reads the
 * binding of the session the runtime is actually on.
 *
 * Degradation is deliberately asymmetric:
 *
 * - no binding → `unclassified` (legacy behaviour: global history). An old
 *   conversation that predates courses must keep working;
 * - a binding whose course has no other sessions → an EMPTY set. That is a
 *   real scope: "this course has no history yet", not "search everything";
 * - an unreadable course store → `unavailable`. Falling back to global recall
 *   here would leak other courses precisely when ownership is unknown.
 */
export type RecallScope =
	| { status: "course"; courseId: string; allowedSessionIds: ReadonlySet<string> }
	| { status: "unclassified" }
	| { status: "unavailable"; reason: string };

export async function resolveRecallScope(
	courseStore: CourseStore | undefined,
	sessionId: string | undefined,
): Promise<RecallScope> {
	// No store is a deployment without the course domain (pre-E4.1 behaviour).
	if (!courseStore) return { status: "unclassified" };
	if (!sessionId || !isSafeRecordId(sessionId)) return { status: "unclassified" };
	try {
		const context = await courseStore.getSessionContext(sessionId);
		if (!context) return { status: "unclassified" };
		const bindings = await courseStore.listSessionBindings(context.course.course_id);
		return {
			status: "course",
			courseId: context.course.course_id,
			allowedSessionIds: new Set(bindings.map((binding) => binding.session_id)),
		};
	} catch (err) {
		return {
			status: "unavailable",
			reason: err instanceof CourseStoreError ? err.code : "course_store_error",
		};
	}
}

/** Options for `recall`: only a course scope is passed through. */
export function recallOptionsForScope(scope: RecallScope): { allowedSessionIds?: ReadonlySet<string> } {
	return scope.status === "course" ? { allowedSessionIds: scope.allowedSessionIds } : {};
}

export const RECALL_SCOPE_UNAVAILABLE_TEXT =
	"历史对话的课程范围暂时无法解析，本次不做跨会话检索（不会退化为全局检索）。";
