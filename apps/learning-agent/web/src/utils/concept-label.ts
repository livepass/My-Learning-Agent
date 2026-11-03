/**
 * Synthetic concept labels (frontend copy).
 *
 * Mirrors `src/shared/concept-id.ts`: the learning layer derives
 * `concept_<12 hex>` from free text, and older L1 projections could turn that
 * into "concept 45125622e640". Neither is a topic name, so the practice page
 * must not prefill either as the topic for the next question. The two packages
 * are separate builds; this tiny predicate is duplicated rather than reaching
 * across the workspace boundary.
 */

const DERIVED_CONCEPT_ID = /^concept_[0-9a-f]{12}$/i;
const DERIVED_CONCEPT_TITLE = /^concept[ _-][0-9a-f]{12}$/i;

export function looksLikeSyntheticConceptLabel(value: string): boolean {
	const label = value.trim();
	return DERIVED_CONCEPT_ID.test(label) || DERIVED_CONCEPT_TITLE.test(label);
}

/**
 * A label is safe to prefill only when it is real text, not a hash, and not a
 * copy of the identifier itself (curated ids like `agents.function-calling` are
 * identifiers too).
 */
export function trustedConceptLabel(conceptId: string, conceptName: string | undefined): string | undefined {
	const label = conceptName?.trim();
	if (!label) return undefined;
	if (looksLikeSyntheticConceptLabel(label)) return undefined;
	if (label === conceptId.trim()) return undefined;
	return label;
}
