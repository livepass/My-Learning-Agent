import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummary } from "./session-model.js";

export interface ReplacementSession {
	id: string;
	path: string;
	updatedAt: string;
	messageCount: number;
}

export interface SelectReplacementInput {
	sessionsDir: string;
	/** The session being deleted: never its own replacement. */
	excludeId: string;
	/** `archives.json`: `true` = archived, `false` = explicitly restored. */
	archiveMetadata: Record<string, boolean>;
	parseSessionFile: (filePath: string) => { summary: SessionSummary } | null;
	isBlocked: (sessionId: string) => boolean;
	/**
	 * E4.7-R2a: candidates the caller knows are not usable in daily study even
	 * though the file is fine — notably a conversation whose parent course is
	 * archived. The file scan cannot see that state; the route supplies it from
	 * the course store inside the queue slot.
	 */
	isExcluded?: (sessionId: string) => boolean;
}

/**
 * Pick an existing conversation the runtime may safely take over when the
 * active session is deleted (D3).
 *
 * Eligibility mirrors what the learner can actually see and resume:
 * - the file must exist and parse;
 * - it must not be the session being deleted or one already being deleted;
 * - it must not be archived;
 * - it must have at least one message. A header-only session is invisible in
 *   `GET /api/sessions` (messageCount > 0 is the main visibility rule), so
 *   switching to it would reproduce the old "invisible replacement" bug under
 *   a different id.
 *
 * Most recently updated wins; the order is deterministic for equal timestamps
 * because `readdirSync` order is stable on a given platform and we keep it.
 */
export function selectReplacementSession(input: SelectReplacementInput): ReplacementSession | null {
	if (!existsSync(input.sessionsDir)) return null;
	const candidates: ReplacementSession[] = [];
	for (const file of readdirSync(input.sessionsDir)) {
		if (!file.endsWith(".jsonl") || file === input.excludeId) continue;
		if (input.isBlocked(file)) continue;
		if (input.archiveMetadata[file] === true) continue;
		if (input.isExcluded?.(file)) continue;
		const path = join(input.sessionsDir, file);
		const parsed = input.parseSessionFile(path);
		if (!parsed || parsed.summary.messageCount <= 0) continue;
		candidates.push({
			id: file,
			path,
			updatedAt: parsed.summary.updatedAt,
			messageCount: parsed.summary.messageCount,
		});
	}
	candidates.sort((a, b) => {
		const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
		if (Number.isFinite(delta) && delta !== 0) return delta;
		return a.id.localeCompare(b.id);
	});
	return candidates[0] ?? null;
}
