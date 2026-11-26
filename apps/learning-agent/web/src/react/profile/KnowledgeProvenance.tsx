import { useTranslation } from "react-i18next";
import { Badge } from "../ui/index.js";
import { describeEvidenceCount, describeProvenance } from "./knowledge-provenance.js";

/**
 * The two caveat lines, shown once per knowledge region (E4.9i-P2-6-R1, F02).
 *
 * The compact course rows show the source label and the identifier count
 * without a paragraph each — repeating two sentences under every row would
 * bury the list. But leaving them out entirely made the course view the one
 * place where a source label could read as a quality mark and a count as a
 * number of practice sessions. This renders both sentences once, at the top of
 * the region, from the same keys the reading view uses.
 */
export function ProvenanceRegionNotes({ className = "" }: { className?: string }) {
	const { t } = useTranslation();
	return (
		<div className={`mla-provenance__region-notes ${className}`.trim()}>
			<p className="mla-provenance__hint">{t("profile.knowledge.provenance.originNote")}</p>
			<p className="mla-provenance__hint">{t("profile.knowledge.provenance.evidenceNote")}</p>
		</div>
	);
}

/**
 * Record source and evidence count for one knowledge record (E4.9i-P2-6, T01/T02).
 *
 * Shared by the all-courses reading view and the course-scoped list, so the two
 * views cannot explain provenance differently. It renders only what the server
 * stored and never computes a trust score:
 *
 *   - the origin label comes from `origin` alone (see `knowledge-provenance.ts`);
 *   - 「来源不明」 is a separate line driven by `provenance_unknown`, so both can
 *     appear together without either replacing the other;
 *   - a string-only array is counted at its original length; malformed
 *     arrays show unavailable instead of a misleading count.
 *
 * Optional `originNote` / `evidenceNote` text clarifies that a source label
 * is not a quality certification and identifiers do not count sessions.
 */
export interface KnowledgeProvenanceProps {
	origin?: string | null;
	provenance_unknown?: boolean | null;
	evidenceIds: unknown;
	/**
	 * Render explanatory notes when requested by a surrounding view.
	 */
	withNotes?: boolean;
	/** Extra class for the wrapper, so each view can place it. */
	className?: string;
}

export function KnowledgeProvenance({
	origin,
	provenance_unknown,
	evidenceIds,
	withNotes = false,
	className = "",
}: KnowledgeProvenanceProps) {
	const { t } = useTranslation();
	const provenance = describeProvenance({ origin, provenance_unknown });
	const evidence = describeEvidenceCount(evidenceIds);

	return (
		<div className={`mla-provenance ${className}`.trim()}>
			<div className="mla-provenance__row">
				<span className="mla-provenance__label">{t("profile.knowledge.provenance.label")}</span>
				<span className="mla-provenance__value" data-provenance-origin={provenance.origin ?? ""}>
					{t(provenance.labelKey)}
				</span>
				{/* Independent of the label: both fields are shown when both apply. */}
				{provenance.provenanceUnknown ? (
					<Badge tone="warning" className="mla-provenance__unknown">
						{t("profile.knowledge.provenance.unknownBadge")}
					</Badge>
				) : null}
			</div>
			{provenance.provenanceUnknown ? (
				<p className="mla-provenance__hint">{t("profile.knowledge.provenance.unknownHint")}</p>
			) : null}
			{withNotes ? (
				<p className="mla-provenance__hint">{t("profile.knowledge.provenance.originNote")}</p>
			) : null}

			{/*
			 * No label span here, unlike the source row above: the value is a
			 * complete phrase (「证据标识 3 个」 / 「证据标识数量不可用」), so a label
			 * would read 「证据标识 证据标识 3 个」. The task book fixes that wording,
			 * so the phrase is the row.
			 */}
			<div className="mla-provenance__row">
				<span
					className="mla-provenance__value"
					data-evidence-count={evidence.available ? String(evidence.count) : "unavailable"}
				>
					{evidence.available
						? t("profile.knowledge.provenance.evidenceCount", { count: evidence.count })
						: t("profile.knowledge.provenance.evidenceUnavailable")}
				</span>
			</div>
			{withNotes ? (
				<p className="mla-provenance__hint">{t("profile.knowledge.provenance.evidenceNote")}</p>
			) : null}
		</div>
	);
}
