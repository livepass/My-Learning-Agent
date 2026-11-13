import { resolveCourseContext } from "../courses/course-context.js";
import type { CourseStore } from "../courses/course-store.js";
import { isSessionManuallyArchived } from "./session-archive-store.js";

/**
 * E4.8a — one policy for "may this conversation accept a new chat turn?".
 *
 * The AI learning workbench is course-scoped, so a chat turn is a learning
 * write inside that course. Both chat routes (`/api/chat`, `/api/chat/stream`)
 * and the history-edit route (which ends in a chat turn) ask this module, so
 * the answer cannot drift between endpoints.
 *
 * | course status | read history | new conversation | continue a chat |
 * | --- | --- | --- | --- |
 * | in_progress | yes | yes | yes |
 * | paused | yes | no | no |
 * | archived | yes | no | no |
 * | completed | yes | no | no |
 *
 * A session that belongs to no course stays readable, but a **Web** one is the
 * legacy chat the product no longer offers: it cannot continue either. Sessions
 * from other channels (CLI, scheduler, IM) keep the previous behaviour, and an
 * unreadable course state fails closed with 503 instead of silently widening the
 * scope to "no course".
 */

export interface ChatWriteRefusal {
	status: 409 | 503;
	body: {
		error:
			| "session_archived"
			| "course_archived"
			| "course_paused"
			| "course_completed"
			| "course_required"
			| "course_unavailable";
		message: string;
		category: "sessions" | "courses";
	};
}

/**
 * True when every recorded channel is `web`.
 *
 * An empty set means the session never recorded a birthplace (an internal
 * runtime session), which is deliberately *not* treated as Web: refusing it
 * would break channels that never wrote `sessions/channels.json`.
 */
export function isWebOnlySession(channels: readonly string[] | undefined): boolean {
	if (!channels || channels.length === 0) return false;
	return channels.includes("web") && channels.every((channel) => channel === "web");
}

export interface ChatWriteGuardInput {
	courseStore: CourseStore | undefined;
	dataDir: string;
	sessionId: string;
	/**
	 * Channels recorded at creation, falling back to the parsed summary. The
	 * caller resolves them because only it owns the channel metadata file.
	 */
	channels: readonly string[] | undefined;
}

export async function refuseChatWrite(input: ChatWriteGuardInput): Promise<ChatWriteRefusal | null> {
	if (isSessionManuallyArchived(input.dataDir, input.sessionId)) {
		return {
			status: 409,
			body: {
				error: "session_archived",
				message: "该会话已归档，仅供查看；请在「系统设置 → 归档会话」恢复会话后再继续提问。",
				category: "sessions",
			},
		};
	}
	if (!input.courseStore) return null;

	let context: Awaited<ReturnType<typeof resolveCourseContext>>;
	try {
		context = await resolveCourseContext(input.courseStore, input.sessionId);
	} catch {
		// Cannot prove which course this is: do not write, do not widen retrieval.
		return {
			status: 503,
			body: {
				error: "course_unavailable",
				message: "课程归属数据暂不可用，本次消息没有发送；请稍后重试。",
				category: "courses",
			},
		};
	}

	if (context.status === "unclassified") {
		if (!isWebOnlySession(input.channels)) return null;
		return {
			status: 409,
			body: {
				error: "course_required",
				message: "这段对话没有归属课程，历史仅供查看。如需继续学习，请先在「AI 学习」中选择或创建课程，再新建对话。",
				category: "courses",
			},
		};
	}

	switch (context.courseStatus) {
		case "archived":
			return {
				status: 409,
				body: {
					error: "course_archived",
					message: "课程已归档，历史记录仅供查看；请在「系统设置 → 归档课程」恢复课程后再继续提问。",
					category: "courses",
				},
			};
		case "paused":
			return {
				status: 409,
				body: {
					error: "course_paused",
					message: "课程已暂停，历史记录仅供查看；请先在课程页点击「继续课程」后再继续提问。",
					category: "courses",
				},
			};
		case "completed":
			return {
				status: 409,
				body: {
					error: "course_completed",
					message: "课程已完成，历史记录仅供查看；如需继续学习，请先调整课程状态。",
					category: "courses",
				},
			};
		default:
			return null;
	}
}
