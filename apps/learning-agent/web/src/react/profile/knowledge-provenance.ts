/**
 * Where a knowledge record came from (E4.9i-P2-6, T01).
 *
 * The server already answers this: `origin` is one of `derived` / `manual` /
 * `legacy`, and `provenance_unknown` is a separate boolean it sets when it could
 * not trace the record's evidence (see `profile-updater.ts`: a PATCH writes
 * `origin: "manual"`, and `provenance_unknown` becomes true when the record has
 * no evidence ids).
 *
 * This module only *reads* those two fields. It deliberately never infers
 * origin from `mastery`, `confidence`, `state_label` or `evidence_ids`: those
 * describe the state, not where the record came from, and guessing would turn
 * a missing server answer into a confident wrong one.
 *
 * The display layer must keep three things apart, because conflating them is
 * exactly what makes a record look more trustworthy than it is:
 *
 *   1. origin            — who produced the record
 *   2. provenance_unknown — the server could not trace its evidence
 *   3. evidence count     — how many identifiers are attached, not a quality
 *                           score and not a count of independent practice
 */

export type KnowledgeOrigin = "derived" | "manual" | "legacy";

/** The three values the server is known to emit. */
export const KNOWN_ORIGINS: readonly KnowledgeOrigin[] = ["derived", "manual", "legacy"];

/** i18n key for each known origin. Values live in the locale files. */
const ORIGIN_LABEL_KEYS: Record<KnowledgeOrigin, string> = {
	derived: "profile.knowledge.provenance.originDerived",
	manual: "profile.knowledge.provenance.originManual",
	legacy: "profile.knowledge.provenance.originLegacy",
};

export interface ProvenanceDisplay {
	/**
	 * The i18n key for the label to show. `originUnspecified` when the value is
	 * absent or unrecognised — never a known-origin key, so an unknown value can
	 * never be displayed as 「系统推导」.
	 */
	labelKey: string;
	/** The origin exactly as received, or null when absent. Kept for reporting. */
	origin: string | null;
	/** True when there is no recognised origin to display. */
	unspecified: boolean;
	/** The server's own "could not trace the evidence" flag, passed through. */
	provenanceUnknown: boolean;
}

/**
 * Read the provenance fields for display.
 *
 * `origin` and `provenanceUnknown` are returned independently and may both be
 * shown at once (`manual` + `true` is a real combination). A contradictory pair
 * is displayed as-is: this function does not "fix" the server's answer, because
 * a record that claims both a source and an unknown source is a fact about the
 * data that the reader should see, not something to smooth over.
 */
export function describeProvenance(state: {
	origin?: string | null;
	provenance_unknown?: boolean | null;
}): ProvenanceDisplay {
	// An empty string is absence, not a value: treat it as missing so it reports
	// `origin: null` rather than surfacing a blank origin in reports.
	const raw = typeof state.origin === "string" && state.origin !== "" ? state.origin : null;
	const known = raw !== null && (KNOWN_ORIGINS as readonly string[]).includes(raw);

	return {
		labelKey: known
			? ORIGIN_LABEL_KEYS[raw as KnowledgeOrigin]
			: "profile.knowledge.provenance.originUnspecified",
		origin: raw,
		unspecified: !known,
		// Only a literal `true` means "unknown". Absent or false is *not* a
		// statement that the evidence was verified — it only means the server did
		// not flag it, and this flag has no "verified" value at all.
		provenanceUnknown: state.provenance_unknown === true,
	};
}

export interface EvidenceCount {
	/** The identifier count, or null when the field is unusable. */
	count: number | null;
	/** False means "cannot say" — the UI must not render it as 0. */
	available: boolean;
}

/**
 * Count the evidence identifiers as stored.
 *
 * The count is `evidence_ids.length`, exactly. It is not deduplicated: a legacy
 * mirror record and its source event may carry the same identifier, and the
 * number shown must match what the server holds rather than a tidied-up
 * estimate. Deduplicating here would silently change the meaning of every
 * count already on screen.
 *
 * A missing, null or non-array value is *unavailable*, never 0 — rendering it
 * as 0 would claim "no evidence" about a record whose evidence we simply
 * cannot read.
 */
export function describeEvidenceCount(evidenceIds: unknown): EvidenceCount {
	if (!Array.isArray(evidenceIds)) return { count: null, available: false };
	return { count: evidenceIds.length, available: true };
}

/**
 * The one-line evidence summary both course views show.
 *
 * Kept here rather than in a component so the count and its wording are decided
 * in one place: the panels that show this number must not each decide how to
 * round it, deduplicate it, or what to say when it is unreadable.
 */
export function evidenceSummary(
	t: (key: string, options?: Record<string, unknown>) => string,
	evidenceIds: unknown,
): string {
	const evidence = describeEvidenceCount(evidenceIds);
	return evidence.available
		? t("profile.knowledge.provenance.evidenceCount", { count: evidence.count })
		: t("profile.knowledge.provenance.evidenceUnavailable");
}

export type GoalPriorityDisplay =
	| { kind: "percent"; percent: number; raw: number }
	| { kind: "anomaly"; raw: number }
	| { kind: "unavailable" };

/**
 * Format a goal's stored priority for display (T06).
 *
 * Priority is documented as a 0–1 weight. Historic records can hold something
 * else, and the three cases must stay distinct:
 *
 *   finite, in [0,1]  → a normal percentage
 *   finite, outside   → an anomaly, shown with its raw value (never 300%,
 *                       never silently clamped to 100%)
 *   anything else     → unavailable (NaN, Infinity, missing, non-numeric)
 *
 * `Number.isFinite` is what separates the last two from the first: `Infinity`
 * is a number but not a usable weight, and `NaN` fails every comparison, so a
 * plain range check would let both through.
 */
export function formatGoalPriority(value: unknown): GoalPriorityDisplay {
	if (typeof value !== "number" || !Number.isFinite(value)) return { kind: "unavailable" };
	if (value < 0 || value > 1) return { kind: "anomaly", raw: value };
	return { kind: "percent", percent: Math.round(value * 100), raw: value };
}

/**
 * The value to give a 0–100 slider for a stored priority.
 *
 * An anomalous value has no valid position on the track, so the thumb sits at
 * the nearest end purely as a visual placeholder — `draft.priority` itself is
 * unchanged, and nothing is written back unless the user moves the control.
 */
export function priorityForSlider(value: unknown): number {
	const display = formatGoalPriority(value);
	if (display.kind === "percent") return display.raw;
	if (display.kind === "anomaly") return display.raw < 0 ? 0 : 1;
	return 0;
}

/** The formatted value alone, without the field name. */
export function goalPriorityText(
	t: (key: string, options?: Record<string, unknown>) => string,
	value: unknown,
): string {
	const display = formatGoalPriority(value);
	if (display.kind === "unavailable") return t("profile.goals.priorityUnavailable");
	if (display.kind === "anomaly") {
		return t("profile.goals.priorityAnomaly", { value: String(display.raw) });
	}
	return `${display.percent}%`;
}

/**
 * The whole line a surface shows for a priority: field name plus value.
 *
 * The anomaly and unavailable strings are already complete sentences
 * (「优先级异常 · 原始值 3」 / 「优先级不可用」), so prefixing them with the field
 * name again would read 「优先级 优先级异常 · 原始值 3」. Only the percentage,
 * which is a bare number, needs the name in front of it.
 */
export function goalPriorityLine(
	t: (key: string, options?: Record<string, unknown>) => string,
	value: unknown,
): string {
	const display = formatGoalPriority(value);
	if (display.kind !== "percent") return goalPriorityText(t, value);
	return `${t("profile.goals.priority")} ${display.percent}%`;
}
