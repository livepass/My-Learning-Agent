import { rebuildLearnerProjection, type RebuildReport } from "./profile-store.js";

/**
 * Replay the complete learner ledger (all archives + active segment) into the
 * profile.
 *
 * - the input is the manifest-ordered ledger, never the tail or a filename sort;
 * - the baseline excludes values that already contain history gains;
 * - corrections are resolved into an effective evidence view before scoring;
 * - manual fields (goals, preferences, hand-written summary) are preserved;
 * - a missing segment, conflicting correction or corrupt profile aborts before
 *   any write, leaving the previous profile untouched.
 */
export async function rebuildProfileFromEvents(
	dataDir: string,
	options?: { asOf?: Date },
): Promise<RebuildReport> {
	return rebuildLearnerProjection(dataDir, options);
}

export type { RebuildReport };
