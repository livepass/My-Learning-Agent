/**
 * Where a knowledge record came from (E4.9i-P2-6, T01).
 *
 * The server already answers this: `origin` is one of `derived` / `manual` /
 * `legacy`, and `provenance_unknown` is a separate boolean it sets when it could
 * not establish provenance for retained historical values (see the actual
 * definition in `memory/learner/types.ts`). The flag does not attest that a
 * tracing operation took place or establish evidence quality.
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
 *   2. provenance_unknown — historical information has an unconfirmed source
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
	/** The server-owned source-unknown flag, independent of origin. */
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
 *
 * An array whose elements are not all usable identifiers is also unavailable
 * (E4.9i-P2-6-R1, F04).
 *
 * For a non-string element the basis is the write paths: `patchProfile()` runs
 * appended ids through `uniqueStrings()`, which trims and drops empties
 * (`profile-updater.ts:176`), and the automatic paths push ids they generated
 * (`auto-profile.ts:307`, `state-engine.ts:277`). A `null`, a number or an
 * object can only be present in a hand-edited or corrupted file.
 *
 * A blank string is different: the tool schema is `Type.Array(Type.String())`
 * with no `minLength`, and `updateProfile()` merges `knowledge_states` without
 * normalising `evidence_ids` (`profile-updater.ts:111-117`), so `""` *can* be
 * stored. The reason it still counts as unusable is that the server's own
 * notion of "how much evidence" already excludes it — `daily-plan.ts:133` and
 * `recommendations.ts:97` both count with
 * `typeof id === "string" && id.trim().length > 0`. Showing such an id as
 * evidence would put a number on screen that the server itself does not use.
 *
 * In both cases the rule is the same: filtering the bad elements out and
 * counting the rest would report a smaller, confident number about a payload
 * this build cannot fully read, which is exactly the kind of silent correction
 * this module refuses to make.
 */
export function describeEvidenceCount(evidenceIds: unknown): EvidenceCount {
	if (!Array.isArray(evidenceIds)) return { count: null, available: false };
	for (const id of evidenceIds) {
		if (typeof id !== "string" || id.trim() === "") return { count: null, available: false };
	}
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

interface GoalEditableFields {
	title: string;
	type: string;
	status: string;
	priority: unknown;
	success_criteria: readonly string[];
}

/**
 * A detached copy of a goal for the editor's opening snapshot (E4.9i-P2-6-R2).
 *
 * The editor needs a record that the store will never replace. `goal` is the
 * live prop: every refresh hands over a new object, and the draft must not be
 * compared against it (see `goalPatchFromDraft`). Copying the object is enough
 * for the scalar fields, but `success_criteria` is an array: sharing it would
 * let a draft edit reach into the snapshot — and, through it, into the record
 * still held by the store — so the array is copied element by element.
 *
 * Elements are strings, so a shallow element copy is complete.
 */
export function goalEditingBaseline<G extends GoalEditableFields>(goal: G): G {
	return { ...goal, success_criteria: [...goal.success_criteria] };
}

/**
 * The PATCH body for the goal editor (E4.9i-P2-6-R1, F01; snapshot rule in R2).
 *
 * The server treats *presence* of a field as "the human edited it" and stamps
 * that field as manually maintained (`server/routes/learner.ts`). So sending an
 * untouched value is not a no-op: it re-orders ownership and can overwrite a
 * newer value the server received while this editor was open.
 *
 * `baseline` must be the record as it looked when the editor opened
 * (`goalEditingBaseline`), never the current `goal` prop. Diffing against the
 * live record is what E4.9i-P2-6-R2 fixes: a field the server updated while the
 * editor was open then differs from the stale draft, so an untouched field would
 * be re-sent with its old value — overwriting the server's newer one and
 * refreshing its ownership stamp. The comparison answers "what did the user
 * change?", and only the opening record can answer that.
 *
 * The rule this function implements:
 *
 *   - every field is sent only when the draft differs from the baseline;
 *   - `priority` is sent only when the user moved the slider (or used the
 *     endpoint button), because an anomalous stored value has no matching
 *     slider position — a diff alone cannot tell "left alone" from "set to the
 *     end of the track";
 *   - an empty result means "nothing to save", and the caller must not issue a
 *     request at all.
 *
 * A field the user did change is sent as the draft value even if the server also
 * changed it meanwhile: this round keeps the existing "a manual PATCH wins"
 * semantics. It does not resolve multi-client edit conflicts.
 */
export function goalPatchFromDraft<G extends GoalEditableFields>(
	baseline: G,
	draft: G,
	priorityTouched: boolean,
): { title?: G["title"]; type?: G["type"]; status?: G["status"]; priority?: number; success_criteria?: string[] } {
	const patch: {
		title?: G["title"];
		type?: G["type"];
		status?: G["status"];
		priority?: number;
		success_criteria?: string[];
	} = {};
	if (draft.title !== baseline.title) patch.title = draft.title;
	if (draft.type !== baseline.type) patch.type = draft.type;
	if (draft.status !== baseline.status) patch.status = draft.status;
	if (!sameStringArray(draft.success_criteria, baseline.success_criteria)) {
		patch.success_criteria = [...draft.success_criteria];
	}
	// A touched priority is only sendable when it is a finite weight in [0,1]:
	// the slider and the endpoint button can only produce those, but the guard
	// keeps a programmatic caller from writing an anomaly back.
	if (priorityTouched && typeof draft.priority === "number" && Number.isFinite(draft.priority)
		&& draft.priority >= 0 && draft.priority <= 1) {
		patch.priority = draft.priority;
	}
	return patch;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
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
