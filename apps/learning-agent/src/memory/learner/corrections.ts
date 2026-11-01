import { stableStringify } from "../../utils/stable-json.js";
import { evidenceFromEvent } from "./evidence.js";
import type { StoredEvent } from "./event-log.js";
import type {
	EvidenceResult,
	LearningEvidence,
	LearningEvidenceCorrection,
} from "./types.js";

/**
 * Effective evidence view.
 *
 * Corrections never overwrite the original record: the ledger keeps the first
 * answer and every later revision, and this module derives the value that
 * scoring should use. Two consequences matter for the rest of the store:
 *
 * - a correction is not a second attempt, so counts and mastery must be
 *   recomputed from the effective value instead of adding a new gain;
 * - an invalid or ambiguous chain blocks a rebuild rather than producing a
 *   "best guess" projection.
 */

export type CorrectionErrorCode =
	| "CORRECTION_INVALID"
	| "CORRECTION_UNKNOWN_EVIDENCE"
	| "CORRECTION_CONFLICT"
	| "CORRECTION_CHAIN_CONFLICT";

export class CorrectionError extends Error {
	readonly code: CorrectionErrorCode;

	constructor(code: CorrectionErrorCode, message: string) {
		super(message);
		this.name = "CorrectionError";
		this.code = code;
	}
}

export interface EffectiveEvidenceItem {
	evidence: LearningEvidence;
	/** Ledger position of the revision that determines the effective value. */
	seq: number;
}

export interface EffectiveEvidenceView {
	evidence: LearningEvidence[];
	items: EffectiveEvidenceItem[];
	corrections: LearningEvidenceCorrection[];
	/** Replays of an already recorded correction (same id, same content). */
	duplicatedCorrections: number;
}

/**
 * Deterministic correction id: target evidence + revision content + the
 * revision it supersedes. A retry of the same correction therefore produces
 * the same id, and a different revision of the same evidence cannot collide.
 */
export { deterministicCorrectionId } from "./correction-id.js";

function clampScore(result: EvidenceResult, score: number | undefined): number | undefined {
	if (result === "unknown") return undefined;
	if (result === "incorrect") return 0;
	if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
	if (result === "correct") return Math.min(1, Math.max(0.8, score));
	return Math.min(0.79, Math.max(0.2, score));
}

function validateCorrection(correction: LearningEvidenceCorrection): void {
	if (
		!correction
		|| correction.schema_version !== 1
		|| typeof correction.correction_id !== "string"
		|| !correction.correction_id
		|| typeof correction.evidence_id !== "string"
		|| !correction.evidence_id
		|| typeof correction.reason !== "string"
		|| !["correct", "partial", "incorrect", "unknown"].includes(correction.corrected_result)
	) {
		throw new CorrectionError("CORRECTION_INVALID", "纠正记录结构不完整");
	}
}

/**
 * Business content of a correction: everything a human decided, nothing the
 * writer generated. Two retries of the same correction therefore compare equal
 * even though their event ids and timestamps differ.
 */
function correctionBusinessDigest(correction: LearningEvidenceCorrection): string {
	return stableStringify({
		evidence_id: correction.evidence_id,
		supersedes: correction.supersedes ?? null,
		corrected_result: correction.corrected_result,
		corrected_score: correction.corrected_score ?? null,
		reason: correction.reason,
	});
}

function applyCorrection(evidence: LearningEvidence, correction: LearningEvidenceCorrection): LearningEvidence {	return {
		...evidence,
		result: correction.corrected_result,
		score: clampScore(correction.corrected_result, correction.corrected_score),
		metadata: {
			...(evidence.metadata ?? {}),
			corrected: true,
			correction_id: correction.correction_id,
			original_result: evidence.metadata?.original_result ?? evidence.result,
		},
	};
}

export function buildEffectiveEvidence(events: StoredEvent[]): EffectiveEvidenceView {
	const evidenceById = new Map<string, EffectiveEvidenceItem>();
	for (const event of events) {
		for (const evidence of evidenceFromEvent(event)) {
			if (!evidenceById.has(evidence.evidence_id)) {
				evidenceById.set(evidence.evidence_id, { evidence, seq: event.seq });
			}
		}
	}

	const seen = new Map<string, string>();
	const heads = new Map<string, string>();
	const applied = new Map<string, EffectiveEvidenceItem>();
	const corrections: LearningEvidenceCorrection[] = [];
	let duplicated = 0;

	for (const event of events) {
		const correction = event.correction;
		if (!correction) continue;
		validateCorrection(correction);
		if (!evidenceById.has(correction.evidence_id)) {
			throw new CorrectionError("CORRECTION_UNKNOWN_EVIDENCE", "纠正记录引用的证据不存在");
		}

		const digest = correctionBusinessDigest(correction);
		const previous = seen.get(correction.correction_id);
		if (previous !== undefined) {
			if (previous !== digest) {
				throw new CorrectionError("CORRECTION_CONFLICT", "同一纠正 ID 出现不同内容");
			}
			duplicated += 1;
			continue;
		}
		seen.set(correction.correction_id, digest);

		const head = heads.get(correction.evidence_id);
		if (correction.supersedes) {
			if (correction.supersedes !== head) {
				throw new CorrectionError("CORRECTION_CHAIN_CONFLICT", "纠正链引用不是当前有效修订");
			}
		} else if (head) {
			// Two revisions without an explicit order claim would make the
			// effective value depend on replay accidents.
			throw new CorrectionError("CORRECTION_CHAIN_CONFLICT", "同一证据出现未声明顺序的第二条纠正");
		}
		heads.set(correction.evidence_id, correction.correction_id);
		const original = evidenceById.get(correction.evidence_id)!;
		applied.set(correction.evidence_id, {
			evidence: applyCorrection(original.evidence, correction),
			// The revision is the newer fact; manual stamps must compare against it.
			seq: event.seq,
		});
		corrections.push(correction);
	}

	const items = [...evidenceById.values()].map((item) => applied.get(item.evidence.evidence_id) ?? item);
	return {
		evidence: items.map((item) => item.evidence),
		items,
		corrections,
		duplicatedCorrections: duplicated,
	};
}
