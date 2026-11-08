import { isDerivedConceptId } from "../../shared/concept-id.js";
import { applyLearningEventToProfile } from "./auto-profile.js";
import { buildEffectiveEvidence } from "./corrections.js";
import { evidenceFromEvent } from "./evidence.js";
import type { StoredEvent } from "./event-log.js";
import {
	applyDerivedKnowledgeState,
	applyEvidenceToLinkedMisconception,
	projectKnowledgeState,
} from "./state-engine.js";
import type {
	KnowledgeState,
	LearnerProfile,
	LearningEvent,
	LearningEvidence,
	ManualStamp,
} from "./types.js";

/**
 * Projection rules shared by incremental writes, correction recovery and full
 * rebuilds.
 *
 * The invariant: derived fields are a pure function of
 * (trusted baseline, effective evidence, asOf, rule version). Both the
 * incremental commit and the full rebuild call the same primitives, so the two
 * paths cannot drift apart.
 */

export const PROJECTION_RULE_VERSION = 2;

const DEFAULT_DIAGNOSIS = "有学习接触记录，尚未形成稳定掌握度判断。";

function titleFromConceptId(conceptId: string): string {
	// A derived id carries no human label. Title-casing its hash would invent one
	// ("concept 45125622e640") that later looks like a real topic and gets fed
	// back into generation; keep the identifier so the absence of a name is
	// visible to callers instead of fabricated.
	if (isDerivedConceptId(conceptId)) return conceptId;
	const last = conceptId.split(/[._/]/).filter(Boolean).at(-1) ?? conceptId;
	return last.replace(/[_-]+/g, " ");
}

function inferDomain(conceptId: string): string {
	const parts = conceptId.split(".");
	return parts.length > 1 ? parts.slice(0, -1).join(".") : "general";
}

/**
 * True when a stored name is only the identifier in disguise.
 *
 * `titleFromConceptId` deliberately leaves a derived id as-is so the absence of
 * a name stays visible; that also means a state created before its name was
 * known still carries the hash and must be allowed to adopt a real one later.
 */
function isPlaceholderName(state: KnowledgeState): boolean {
	const name = state.concept_name?.trim() ?? "";
	return !name || name === state.concept_id || isDerivedConceptId(name);
}

export function ensureKnowledgeState(
	profile: LearnerProfile,
	conceptId: string,
	/** E4.6: a real topic name, when the evidence knows one. */
	conceptLabel?: string,
): KnowledgeState {
	let state = profile.knowledge_states.find((item) => item.concept_id === conceptId);
	if (state) {
		// A state first created from evidence that carried no name (or created by
		// an earlier projection) adopts the first real name it sees. A manual name
		// is never overwritten: `origin: "manual"` owns its label.
		const label = conceptLabel?.trim();
		if (label && state.origin !== "manual" && isPlaceholderName(state)) {
			state.concept_name = label;
		}
		return state;
	}
	state = {
		concept_id: conceptId,
		concept_name: conceptLabel?.trim() || titleFromConceptId(conceptId),
		domain: inferDomain(conceptId),
		mastery: 0.05,
		confidence: 0.35,
		stability: 0.1,
		evidence_ids: [],
		diagnosis: DEFAULT_DIAGNOSIS,
		next_actions: [],
		origin: "derived",
	};
	profile.knowledge_states.push(state);
	return state;
}

/** Owner-issued logical stamp for a human edit. Never derived from a clock. */
export function nextManualStamp(profile: LearnerProfile): ManualStamp {
	const edit = (profile.manual_edit_seq ?? 0) + 1;
	profile.manual_edit_seq = edit;
	return { at_seq: profile.projection?.applied_seq ?? 0, edit };
}

/** Reset the fields that are reproducible from evidence; keep labels and provenance. */
function resetDerivedKnowledgeState(state: KnowledgeState): KnowledgeState {
	return {
		concept_id: state.concept_id,
		concept_name: state.concept_name,
		domain: state.domain,
		mastery: 0.05,
		confidence: 0.35,
		stability: 0.1,
		evidence_ids: [],
		diagnosis: DEFAULT_DIAGNOSIS,
		next_actions: [],
		origin: "derived",
	};
}

export interface BaselineReport {
	preservedManualStates: number;
	preservedLegacyStates: number;
	resetDerivedStates: number;
	issues: string[];
}

/**
 * Reset every *derived* field to a clean baseline before replay.
 *
 * A state is treated as derived only when its evidence ids can be resolved in
 * the ledger. Anything else (manual API creation, imported profile, a legacy
 * value with no traceable source) is preserved verbatim and flagged, because
 * silently resetting it would destroy data that the ledger cannot rebuild.
 */
export function resetDerivedFields(
	profile: LearnerProfile,
	events: StoredEvent[],
): BaselineReport {
	const eventIds = new Set(events.map((event) => event.event_id));
	const report: BaselineReport = {
		preservedManualStates: 0,
		preservedLegacyStates: 0,
		resetDerivedStates: 0,
		issues: [],
	};

	profile.knowledge_states = profile.knowledge_states.map((state) => {
		const origin = state.origin;
		const backedByLedger = state.evidence_ids.some((id) => eventIds.has(id));

		if (origin === "manual") {
			report.preservedManualStates += 1;
			return state;
		}
		if (origin === "legacy") {
			report.preservedLegacyStates += 1;
			return { ...state, provenance_unknown: true };
		}
		if (origin === "derived" || backedByLedger) {
			report.resetDerivedStates += 1;
			return resetDerivedKnowledgeState(state);
		}
		report.preservedLegacyStates += 1;
		report.issues.push(`concept ${state.concept_id}: 保留无来源的旧数值，未计入重放增益`);
		return { ...state, origin: "legacy", provenance_unknown: true };
	});

	// Misconception status is derived from linked evidence unless a human owns
	// it. Resetting it prevents a correction (for example to `unknown`) from
	// leaving a stale `repairing` transition behind.
	for (const item of profile.misconceptions) {
		if (item.manual?.status) continue;
		item.status = "active";
		item.last_seen_at = item.first_seen_at;
	}

	profile.derived_summary = "";
	profile.projection = { applied_seq: 0, rule_version: PROJECTION_RULE_VERSION };
	return report;
}

export interface ReplayResult {
	applied: number;
	skippedCorrections: number;
	lastSeq: number;
}

/**
 * Replay events into the profile in ledger order.
 * Corrections are skipped here: they change the effective evidence view, not
 * the event stream, and are applied by the evidence projection.
 */
export function replayEvents(profile: LearnerProfile, events: StoredEvent[]): ReplayResult {
	let applied = 0;
	let skippedCorrections = 0;
	let lastSeq = profile.projection?.applied_seq ?? 0;
	for (const event of events) {
		lastSeq = Math.max(lastSeq, event.seq);
		if (event.correction) {
			skippedCorrections += 1;
			continue;
		}
		if (applyLearningEventToProfile(profile, event, {
			updateSummary: false,
			eventSeq: event.seq,
			deletedGoals: profile.deleted_goals,
		})) applied += 1;
	}
	return { applied, skippedCorrections, lastSeq };
}

/**
 * Recompute every knowledge state from the supplied evidence.
 *
 * `evidence` may be only the newly applied records: the state engine skips
 * evidence ids already present on the base state, so counts and mastery stay
 * idempotent, while `asOf` refreshes time-derived fields for **all** concepts
 * (a new event on concept B moves the global projection time for concept A).
 */
export function projectKnowledge(
	profile: LearnerProfile,
	evidence: LearningEvidence[],
	asOf: Date,
): number {
	const conceptIds = new Set<string>([
		...profile.knowledge_states.map((state) => state.concept_id),
		...profile.misconceptions.map((item) => item.concept_id),
		...evidence.map((item) => item.concept_id),
	]);

	// E4.6: the newest evidence that carries a real topic name names the state.
	// Evidence is in ledger order, so later records win, matching "the learner's
	// most recent wording for this concept".
	const labelByConcept = new Map<string, string>();
	for (const item of evidence) {
		const label = item.concept_label?.trim();
		if (label) labelByConcept.set(item.concept_id, label);
	}

	let changed = 0;
	for (const conceptId of conceptIds) {
		const base = ensureKnowledgeState(profile, conceptId, labelByConcept.get(conceptId));
		const activeMisconceptionIds = profile.misconceptions
			.filter((item) => item.concept_id === conceptId && item.status === "active")
			.map((item) => item.misconception_id);
		const projected = projectKnowledgeState(base, conceptId, evidence, {
			asOf,
			hasActiveMisconception: activeMisconceptionIds.length > 0,
			activeMisconceptionIds,
		});
		if (applyDerivedKnowledgeState(profile, projected)) changed += 1;
	}
	return changed;
}

/** Apply linked-evidence transitions to misconceptions in ledger order. */
export function applyEvidenceTransitions(
	profile: LearnerProfile,
	items: { evidence: LearningEvidence; seq: number }[],
): number {
	let changed = 0;
	for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
		if (applyEvidenceToLinkedMisconception(profile, item.evidence, { eventSeq: item.seq })) changed += 1;
	}
	return changed;
}

export interface ProjectionCommitResult extends BaselineReport {
	mode: "incremental" | "full";
	applied: number;
	skippedCorrections: number;
	knowledgeChanged: number;
	lastSeq: number;
	asOf: string;
}

export interface ProjectionCommitOptions {
	mode: "incremental" | "full";
	/** Highest sequence committed to the ledger; the cursor must land here. */
	lastSeq: number;
	/**
	 * All events are required for `full`; `incremental` needs only pending ones.
	 * The caller supplies the latest observed fact time in both cases.
	 */
	asOf: Date;
}

/**
 * Single projection commit used by writes, recovery and rebuilds.
 */
export function commitProjection(
	profile: LearnerProfile,
	events: StoredEvent[],
	options: ProjectionCommitOptions,
): ProjectionCommitResult {
	const baseline: BaselineReport = options.mode === "full"
		? resetDerivedFields(profile, events)
		: { preservedManualStates: 0, preservedLegacyStates: 0, resetDerivedStates: 0, issues: [] };

	const replay = replayEvents(profile, events);

	let evidence: LearningEvidence[];
	let transitionItems: { evidence: LearningEvidence; seq: number }[];
	if (options.mode === "full") {
		const view = buildEffectiveEvidence(events);
		evidence = view.evidence;
		transitionItems = view.items;
	} else {
		transitionItems = events
			.filter((event) => !event.correction)
			.flatMap((event) => evidenceFromEvent(event).map((item) => ({ evidence: item, seq: event.seq })));
		evidence = transitionItems.map((item) => item.evidence);
	}

	applyEvidenceTransitions(profile, transitionItems);
	const knowledgeChanged = projectKnowledge(profile, evidence, options.asOf);

	profile.derived_summary = options.mode === "full"
		? deriveSummaryFromEvents(events)
		: appendDerivedSummary(profile, events);
	profile.projection = {
		applied_seq: options.lastSeq,
		rule_version: PROJECTION_RULE_VERSION,
		as_of: options.asOf.toISOString(),
	};

	return {
		...baseline,
		mode: options.mode,
		applied: replay.applied,
		skippedCorrections: replay.skippedCorrections,
		knowledgeChanged,
		lastSeq: options.lastSeq,
		asOf: options.asOf.toISOString(),
	};
}

/** Event-derived summary kept separate from the user-owned `profile_summary`. */
export function deriveSummaryFromEvents(events: LearningEvent[], limit = 8): string {
	const sentences = events
		.map(learningEventSummaryLine)
		.filter((line): line is string => !!line);
	return sentences.slice(-limit).join("\n");
}

function learningEventSummaryLine(event: LearningEvent): string | undefined {
	if (event.correction) return undefined;
	const conceptIds = event.context.concept_ids ?? [];
	const label =
		typeof event.payload.topic === "string"
			? event.payload.topic
			: typeof event.payload.concept === "string"
				? event.payload.concept
				: typeof event.payload.goal === "string"
					? event.payload.goal
					: typeof event.payload.goal_description === "string"
						? event.payload.goal_description
						: conceptIds[0];
	if (!label) return undefined;
	return `最近记录：${label}（${event.event_type}，${event.timestamp.slice(0, 10)}）。`;
}

function appendDerivedSummary(profile: LearnerProfile, events: StoredEvent[], limit = 8): string {
	const lines = profile.derived_summary?.split("\n").filter(Boolean) ?? [];
	for (const event of events) {
		const line = learningEventSummaryLine(event);
		if (line && !lines.includes(line)) lines.push(line);
	}
	return lines.slice(-limit).join("\n");
}

/**
 * Deterministic projection time.
 *
 * Using "now" would make retrievability and review labels change on every
 * rebuild, so two rebuilds of one ledger would disagree. The latest recorded
 * fact is the only consistent observation point; `max` (not "last line") also
 * covers events that arrived late with an older timestamp.
 */
export function latestFactTime(events: LearningEvent[]): Date | undefined {
	let latest: number | undefined;
	for (const event of events) {
		const parsed = Date.parse(event.timestamp);
		if (Number.isFinite(parsed) && (latest === undefined || parsed > latest)) latest = parsed;
	}
	return latest === undefined ? undefined : new Date(latest);
}

export function projectionAsOf(events: LearningEvent[], fallback: Date = new Date()): Date {
	return latestFactTime(events) ?? fallback;
}
