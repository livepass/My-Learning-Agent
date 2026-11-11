import type { SessionMeta } from "../api/sessions.js";

/**
 * One definition of "this conversation belongs in the daily lists".
 *
 * The server derives `daily_visible = !session.archived && course?.status !== "archived"`
 * (E4.7-R1c) because two independent states can hide a conversation: the
 * learner archived it, or its parent course is archived. Pages must read that
 * field instead of checking `archived` alone — otherwise a conversation hidden
 * with its course keeps appearing on the homepage.
 *
 * A payload written before the field existed falls back to the session's own
 * flag, so an older response can never put an archived conversation back.
 */
export function isDailyVisible(session: Pick<SessionMeta, "archived" | "daily_visible">): boolean {
	return session.daily_visible ?? session.archived !== true;
}
