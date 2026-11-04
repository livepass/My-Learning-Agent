import { looksLikeSyntheticConceptLabel } from "../shared/concept-id.js";
import type {
	EvidenceResult,
	KnowledgeState,
	KnowledgeStateLabel,
	LearnerProfile,
	Misconception,
} from "../memory/learner/types.js";

/**
 * C4-B: deterministic next-step recommendations from the L1 profile.
 *
 * This is a read-only decision layer, not a second memory system:
 *
 * - no clock inside (the caller passes `asOf`), no model, no disk, no L2/L3;
 * - the input profile is never mutated;
 * - only existing knowledge states can be recommended, at most once each;
 * - a rule must cite a stored fact (active misconception, valid due time,
 *   state label plus evidence), and the public shape carries a machine-readable
 *   `reason_code` so the prose is never the only basis.
 *
 * Deliberately absent: any weighted score over mastery/confidence. The stored
 * numbers are heuristics with no calibration data, so a composite formula would
 * only manufacture precision. Ordering uses fixed rule priority, then a single
 * explicit tiebreak field, then `concept_id`.
 */

export type LearningAction = "review" | "learn" | "practice" | "diagnose" | "transfer";
export type LearningRecommendationReason =
	| "active_misconception"
	| "review_due"
	| "fragile_evidence"
	| "learning_needs_diagnosis"
	| "stable_transfer";

export type SuggestedQuestionKind = "free_recall" | "application" | "transfer";

export interface RecommendationEvidenceBasis {
	state_label?: KnowledgeStateLabel;
	/** Only returned when the stored timestamp is a valid instant. */
	review_due_at?: string;
	last_result?: EvidenceResult;
	/** Count of stored evidence ids; never the events themselves. */
	evidence_count: number;
	has_active_misconception: boolean;
	/** True for legacy/manual/unknown-origin states whose numbers are not trustworthy. */
	provenance_limited: boolean;
	/** True when the state has exposure records but no independent retrieval evidence. */
	exposure_only: boolean;
}

export interface LearningRecommendation {
	concept_id: string;
	/** Absent when the stored name is a machine identity; the UI asks the learner to confirm. */
	concept_name?: string;
	/** Machine-readable companion to `concept_name` being absent. */
	name_available: boolean;
	action: LearningAction;
	suggested_kind?: SuggestedQuestionKind;
	reason_code: LearningRecommendationReason;
	reason: string;
	/** Lower-priority rules the same concept also satisfies. Never creates a second card. */
	also_matches: LearningRecommendationReason[];
	evidence_basis: RecommendationEvidenceBasis;
}

export interface RecommendationOptions {
	/** Maximum items returned. Defaults to 3; clamped to 1..20. */
	limit?: number;
	/**
	 * Restrict the decision to one concept before applying the rules (practice
	 * page). This is not a post-filter over a truncated global list: the concept
	 * is matched against every stored state first, so a concept ranked 4th
	 * globally still gets its own recommendation.
	 */
	conceptId?: string;
}

const PRIORITY: Record<LearningRecommendationReason, number> = {
	active_misconception: 0,
	review_due: 1,
	fragile_evidence: 2,
	learning_needs_diagnosis: 3,
	stable_transfer: 4,
};

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 20;

function parseTime(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : undefined;
}

function evidenceCountOf(state: KnowledgeState): number {
	if (!Array.isArray(state.evidence_ids)) return 0;
	return state.evidence_ids.filter((id) => typeof id === "string" && id.trim().length > 0).length;
}

function countOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Only a state rebuilt from the evidence ledger has trustworthy numeric fields. */
function provenanceLimited(state: KnowledgeState): boolean {
	return state.origin !== "derived" || state.provenance_unknown === true;
}

/**
 * A name is usable only when it is real text. The id itself and the hashed
 * title an older projection produced are identifiers, not topics.
 */
function trustedName(state: KnowledgeState): string | undefined {
	const name = typeof state.concept_name === "string" ? state.concept_name.trim() : "";
	if (!name) return undefined;
	if (name === state.concept_id.trim()) return undefined;
	if (looksLikeSyntheticConceptLabel(name)) return undefined;
	return name;
}

function activeMisconceptions(profile: LearnerProfile, conceptId: string): Misconception[] {
	if (!Array.isArray(profile.misconceptions)) return [];
	return profile.misconceptions.filter((item) => item
		&& item.concept_id === conceptId
		&& item.status === "active");
}

function sortableSeverity(items: Misconception[]): number {
	return items.reduce((max, item) => (
		typeof item.severity === "number" && Number.isFinite(item.severity) ? Math.max(max, item.severity) : max
	), 0);
}

function latestSeenAt(items: Misconception[]): number {
	return items.reduce((latest, item) => {
		const time = parseTime(item.last_seen_at);
		return time === undefined ? latest : Math.max(latest, time);
	}, -Infinity);
}

interface Candidate {
	recommendation: LearningRecommendation;
	priority: number;
	reviewAt?: number;
	severity: number;
	lastSeenAt: number;
	lastEvidenceAt: number;
}

function reasonText(
	reason: LearningRecommendationReason,
	basis: RecommendationEvidenceBasis,
): string {
	switch (reason) {
		case "active_misconception":
			return "学习档案中有一条仍在活跃状态的误区记录，建议先通过解释、反例与概念澄清处理它（这不代表误区已经被验证修复）。";
		case "review_due":
			return `这条知识点的复习时间已到（${basis.review_due_at?.slice(0, 10) ?? "已到期"}），建议先用自由回忆检索一次。`;
		case "fragile_evidence":
			return "最近的证据显示这个知识点还不稳定，建议用一道应用题做轻度变式练习。";
		case "learning_needs_diagnosis":
			return basis.exposure_only
				? "这个知识点目前只有接触记录，还没有独立回忆证据，建议先用自由回忆补充一次可追溯的作答。"
				: "这个知识点已开始学习但证据还不充分，建议先用自由回忆补充一次独立证据。";
		case "stable_transfer":
			return "已有多条可信证据，建议用迁移题检验能否在新情境中应用（这不代表已经永久掌握）。";
	}
}

function actionFor(reason: LearningRecommendationReason): {
	action: LearningAction;
	suggested_kind?: SuggestedQuestionKind;
} {
	switch (reason) {
		case "active_misconception": return { action: "learn" };
		case "review_due": return { action: "review", suggested_kind: "free_recall" };
		case "fragile_evidence": return { action: "practice", suggested_kind: "application" };
		case "learning_needs_diagnosis": return { action: "diagnose", suggested_kind: "free_recall" };
		case "stable_transfer": return { action: "transfer", suggested_kind: "transfer" };
	}
}

function candidateFor(
	state: KnowledgeState,
	profile: LearnerProfile,
	asOf: number,
): Candidate | undefined {
	const conceptId = typeof state.concept_id === "string" ? state.concept_id.trim() : "";
	if (!conceptId) return undefined;

	const misconceptions = activeMisconceptions(profile, conceptId);
	const hasActiveMisconception = misconceptions.length > 0;
	const limited = provenanceLimited(state);
	const evidenceCount = evidenceCountOf(state);
	const reviewAt = parseTime(state.review_due_at);
	const reviewDue = reviewAt !== undefined && reviewAt <= asOf;
	const retrievalCount = countOf(state.retrieval_count);
	const exposureCount = countOf(state.exposure_count);
	const exposureOnly = retrievalCount === 0 && (exposureCount ?? 0) > 0;
	const label = state.state_label;

	// Rule evaluation in fixed priority order. A low-provenance state may still
	// surface an explicit active misconception, but its heuristic labels and
	// timestamps are not used to claim anything else.
	const matches: LearningRecommendationReason[] = [];
	if (hasActiveMisconception) matches.push("active_misconception");
	if (!limited) {
		// A due date alone is not a review task: without traceable evidence the
		// timestamp may be a leftover, and claiming "review due" would invent work.
		if (reviewDue && evidenceCount > 0) matches.push("review_due");
		if (evidenceCount > 0 && label === "fragile") matches.push("fragile_evidence");
		if (evidenceCount > 0 && label === "learning") matches.push("learning_needs_diagnosis");
		if (evidenceCount > 0 && label === "stable") matches.push("stable_transfer");
	}
	if (matches.length === 0) return undefined;

	const reason = matches[0];
	const basis: RecommendationEvidenceBasis = {
		...(label ? { state_label: label } : {}),
		...(reviewAt !== undefined ? { review_due_at: state.review_due_at } : {}),
		...(state.last_result ? { last_result: state.last_result } : {}),
		evidence_count: evidenceCount,
		has_active_misconception: hasActiveMisconception,
		provenance_limited: limited,
		exposure_only: exposureOnly,
	};
	const name = trustedName(state);
	const { action, suggested_kind: suggestedKind } = actionFor(reason);

	return {
		recommendation: {
			concept_id: conceptId,
			...(name ? { concept_name: name } : {}),
			name_available: Boolean(name),
			action,
			...(suggestedKind ? { suggested_kind: suggestedKind } : {}),
			reason_code: reason,
			reason: reasonText(reason, basis),
			also_matches: matches.slice(1),
			evidence_basis: basis,
		},
		priority: PRIORITY[reason],
		...(reviewAt !== undefined ? { reviewAt } : {}),
		severity: sortableSeverity(misconceptions),
		lastSeenAt: latestSeenAt(misconceptions),
		lastEvidenceAt: parseTime(state.last_evidence_at) ?? -Infinity,
	};
}

function compare(a: Candidate, b: Candidate): number {
	if (a.priority !== b.priority) return a.priority - b.priority;
	if (a.recommendation.reason_code === "review_due" && b.recommendation.reason_code === "review_due") {
		const left = a.reviewAt ?? Number.POSITIVE_INFINITY;
		const right = b.reviewAt ?? Number.POSITIVE_INFINITY;
		if (left !== right) return left - right;
	}
	if (a.recommendation.reason_code === "active_misconception"
		&& b.recommendation.reason_code === "active_misconception") {
		if (a.severity !== b.severity) return b.severity - a.severity;
		if (a.lastSeenAt !== b.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
	}
	if (a.lastEvidenceAt !== b.lastEvidenceAt) return b.lastEvidenceAt - a.lastEvidenceAt;
	// Code-unit order, not locale order: the tiebreak must be identical on every
	// machine, independent of the host locale.
	const left = a.recommendation.concept_id;
	const right = b.recommendation.concept_id;
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Recommend the next learning actions for a profile at a fixed instant.
 *
 * Returns [] for an invalid `asOf` rather than guessing "now": a caller that
 * cannot state the time it is asking about has no basis for a due-date claim.
 */
export function recommendNextLearningActions(
	profile: LearnerProfile,
	asOf: Date,
	options: RecommendationOptions = {},
): LearningRecommendation[] {
	if (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) return [];
	if (!profile || !Array.isArray(profile.knowledge_states)) return [];

	const requested = options.limit;
	const limit = typeof requested === "number" && Number.isFinite(requested) && requested >= 1
		? Math.min(Math.floor(requested), MAX_LIMIT)
		: DEFAULT_LIMIT;
	const asOfMs = asOf.getTime();
	const scopedConcept = options.conceptId !== undefined;
	const requestedConcept = scopedConcept ? options.conceptId!.trim() : "";
	if (scopedConcept && !requestedConcept) return [];
	const states = scopedConcept
		? profile.knowledge_states.filter((state) => state && state.concept_id === requestedConcept)
		: profile.knowledge_states;

	const candidates: Candidate[] = [];
	for (const state of states) {
		if (!state || typeof state !== "object") continue;
		const candidate = candidateFor(state, profile, asOfMs);
		if (candidate) candidates.push(candidate);
	}

	candidates.sort(compare);
	// One primary recommendation per concept: after sorting, the first entry is
	// the highest-priority one. Duplicates are dropped rather than merged, so a
	// concept never produces two conflicting cards.
	const seen = new Set<string>();
	const chosen: LearningRecommendation[] = [];
	for (const candidate of candidates) {
		const conceptId = candidate.recommendation.concept_id;
		if (seen.has(conceptId)) continue;
		seen.add(conceptId);
		chosen.push(candidate.recommendation);
		if (chosen.length >= limit) break;
	}
	return chosen;
}

/** Explicit empty state for the API: no usable knowledge evidence vs no matching rule. */
export function hasUsableKnowledgeEvidence(profile: LearnerProfile, conceptId?: string): boolean {
	if (!Array.isArray(profile.knowledge_states)) return false;
	const requested = typeof conceptId === "string" ? conceptId.trim() : "";
	return profile.knowledge_states.some((state) => state
		&& typeof state === "object"
		&& (!requested || state.concept_id === requested)
		&& evidenceCountOf(state) > 0
		&& !provenanceLimited(state));
}

/** Public read-only response of `GET /api/learner/recommendations`. */
export interface RecommendationSnapshot {
	/** The instant the rules were evaluated at (server clock, echoed verbatim). */
	as_of: string;
	generated_at: string;
	profile_version: number;
	projection?: { applied_seq: number; rule_version: number; as_of?: string };
	recommendations: LearningRecommendation[];
	status: "ok" | "empty";
	empty_reason?: "no_knowledge_evidence" | "no_actionable_state";
	limit: number;
	/** Echo of a concept-scoped read; absent for the global list. */
	concept_id?: string;
}

/**
 * Build the public snapshot. Contains only recommendation fields and profile
 * version metadata: no answers, rubrics, evidence events or free-form profile
 * summaries.
 */
export function buildRecommendationSnapshot(
	profile: LearnerProfile,
	asOf: Date,
	options: RecommendationOptions = {},
): RecommendationSnapshot {
	const recommendations = recommendNextLearningActions(profile, asOf, options);
	const limit = typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit >= 1
		? Math.min(Math.floor(options.limit), 20)
		: 3;
	const conceptId = typeof options.conceptId === "string" ? options.conceptId.trim() : "";
	const projection = profile.projection;
	return {
		as_of: asOf.toISOString(),
		generated_at: asOf.toISOString(),
		profile_version: profile.version,
		...(projection ? {
			projection: {
				applied_seq: projection.applied_seq,
				rule_version: projection.rule_version,
				...(projection.as_of ? { as_of: projection.as_of } : {}),
			},
		} : {}),
		recommendations,
		...(recommendations.length > 0
			? { status: "ok" as const }
			: {
				status: "empty" as const,
				empty_reason: hasUsableKnowledgeEvidence(profile, conceptId || undefined)
					? "no_actionable_state" as const
					: "no_knowledge_evidence" as const,
			}),
		limit,
		...(conceptId ? { concept_id: conceptId } : {}),
	};
}
