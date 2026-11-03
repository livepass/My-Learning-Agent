/**
 * Machine-minted concept identities versus human-written topic names.
 *
 * `deriveConceptId()` in the learning layer hashes a free-text topic into
 * `concept_<12 hex chars>`. That id is a stable key, not a name: title-casing it
 * ("concept 45125622e640") invents a pseudo-topic, and feeding that back as the
 * generation topic would replace the learner's words with a hash. Both the L1
 * projection and the UI therefore treat such strings as identifiers, never as
 * labels.
 */

const DERIVED_CONCEPT_ID = /^concept_[0-9a-f]{12}$/i;
const DERIVED_CONCEPT_TITLE = /^concept[ _-][0-9a-f]{12}$/i;

/** True for the id shape produced by `deriveConceptId()`. */
export function isDerivedConceptId(value: string): boolean {
	return DERIVED_CONCEPT_ID.test(value.trim());
}

/**
 * True when a string is a machine identity rather than a topic name.
 *
 * Covers the id itself and the title-cased form older projections produced,
 * so profiles written before this guard was added are still recognised.
 */
export function looksLikeSyntheticConceptLabel(value: string): boolean {
	const label = value.trim();
	return DERIVED_CONCEPT_ID.test(label) || DERIVED_CONCEPT_TITLE.test(label);
}
