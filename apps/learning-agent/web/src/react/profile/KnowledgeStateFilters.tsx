import { useTranslation } from "react-i18next";
import { KNOWLEDGE_FILTERS, type KnowledgeFilter, type KnowledgeFilterCounts } from "./knowledge-filter.js";

/**
 * The six knowledge-state filters (E4.9i-P2-4).
 *
 * A controlled, presentational row: it renders the counts it is given and
 * reports the chosen filter. It does not read a store, filter anything itself,
 * or decide whether the switch may proceed — the container owns that, because
 * only the container can ask `KnowledgeDraftGuard`.
 *
 * Each option is a real `button` with `aria-pressed`, so Tab/Enter/Space and
 * screen-reader state work without extra handling. A zero count is still
 * selectable: choosing it is how the learner confirms the group is empty.
 */
const FILTER_LABEL_KEY: Record<KnowledgeFilter, string> = {
	all: "profile.knowledge.filters.all",
	needs_attention: "profile.knowledge.filters.needsAttention",
	review_due: "profile.knowledge.filters.reviewDue",
	misconception: "profile.knowledge.filters.misconception",
	stable: "profile.knowledge.filters.stable",
	unknown: "profile.knowledge.filters.unknown",
};

export interface KnowledgeStateFiltersProps {
	value: KnowledgeFilter;
	counts: KnowledgeFilterCounts;
	onChange: (value: KnowledgeFilter) => void;
}

export function KnowledgeStateFilters({ value, counts, onChange }: KnowledgeStateFiltersProps) {
	const { t } = useTranslation();

	return (
		<div className="flex flex-col gap-1.5">
			<div
				role="group"
				aria-label={t("profile.knowledge.filters.label")}
				className="flex flex-wrap items-center gap-1.5"
			>
				{KNOWLEDGE_FILTERS.map((filter) => {
					const active = filter === value;
					return (
						<button
							key={filter}
							type="button"
							aria-pressed={active}
							onClick={() => onChange(filter)}
							// The visible label plus its count is the accessible name, so
							// a screen reader reads "待复习 2" rather than a bare number.
							className={`inline-flex min-h-[28px] max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs transition-colors ${
								active
									? "border-[color-mix(in_srgb,var(--inno-accent)_40%,var(--inno-border))] bg-[var(--inno-accent-soft)] font-semibold text-[var(--inno-accent)]"
									: "border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text-muted)] hover:border-[var(--inno-border-strong)] hover:text-[var(--inno-text)]"
							}`}
						>
							<span>{t(FILTER_LABEL_KEY[filter])}</span>
							<span className="tabular-nums opacity-80">{counts[filter]}</span>
						</button>
					);
				})}
			</div>
			{/*
			 * Says once what 「待复习」 counts. The number is the server's state
			 * classification; whether a review is actually due is decided in the
			 * daily plan, and this row must not be read as today's due list.
			 */}
			<p className="m-0 text-[11px] leading-snug text-[var(--inno-text-subtle)]">
				{t("profile.knowledge.filters.reviewDueHint")}
			</p>
		</div>
	);
}
