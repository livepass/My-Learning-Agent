import { sha256Hex } from "../../storage/file-store.js";
import { stableStringify } from "../../utils/stable-json.js";
import type { LearningEvidenceCorrection } from "./types.js";

/**
 * Deterministic correction identity: target evidence + revision content + the
 * revision it supersedes. A retried correction therefore produces the same id,
 * and a different revision of the same evidence cannot collide with it.
 */
export function deterministicCorrectionId(
	correction: Omit<LearningEvidenceCorrection, "correction_id">,
): string {
	const canonical = stableStringify({
		evidence_id: correction.evidence_id,
		supersedes: correction.supersedes ?? null,
		corrected_result: correction.corrected_result,
		corrected_score: correction.corrected_score ?? null,
		reason: correction.reason,
	});
	return `cor_${sha256Hex(canonical).slice(0, 16)}`;
}
