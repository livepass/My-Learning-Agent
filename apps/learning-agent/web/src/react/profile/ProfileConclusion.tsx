import { useTranslation } from "react-i18next";
import type { ProfileOverview } from "./profile-overview.js";

/**
 * 学习概览结论 (E4.9i-P2-3).
 *
 * Two layers, both derived from `ProfileOverview` and nothing else:
 *
 * 1. what the profile records — how many states, how many need attention, how
 *    many are stable, how many have no usable label;
 * 2. what to look at next — the review-due *classification* (never a verdict),
 *    misconception states and unresolved misconception records (counted apart),
 *    and a pointer to the section that already lists the stored next actions.
 *
 * It is a pure renderer: no store, no request, no clock. Every number comes in
 * through `overview`, so this text can never disagree with the tiles beside it.
 * It never claims mastery, accuracy or a due review — the profile has no
 * authoritative data for any of those, and saying so is the point of the
 * source line.
 *
 * The fact sentence is assembled from optional clauses rather than separate
 * sentences: Chinese joins them with 「，」 and English with 「,」, and a clause
 * is omitted entirely when its count is zero, so neither language reads a
 * dangling "0".
 */
export function ProfileConclusion({ overview }: { overview: ProfileOverview }) {
	const { t } = useTranslation();

	/**
	 * F01 (E4.9i-P2-3-R1): unresolved misconception *records* are their own data
	 * set — `misconceptions[]` — and are not a property of the knowledge list.
	 * They used to print only inside the `weakCount > 0` branch, and the
	 * `totalConcepts === 0` early return skipped them entirely, so a profile
	 * whose records outlived its knowledge states (or never had one) silently
	 * dropped them. The line now renders whenever the count is positive, however
	 * many concepts exist and however they classify. It stays a separate count:
	 * it is never added to, or merged with, the `misconception` state count.
	 */
	const openMisconceptionLine = overview.openMisconceptions > 0 ? (
		<p className="m-0 text-xs leading-relaxed text-[var(--inno-text-muted)]">
			{t("profile.conclusion.openMisconceptions", { count: overview.openMisconceptions })}
		</p>
	) : null;

	if (overview.totalConcepts === 0) {
		return (
			<div className="mb-3.5">
				<p className="m-0 text-sm leading-relaxed text-[var(--inno-text)]">{t("profile.conclusion.emptyLead")}</p>
				<p className="m-0 mt-1 text-xs leading-relaxed text-[var(--inno-text-muted)]">{t("profile.conclusion.emptyHint")}</p>
				{openMisconceptionLine ? (
					<div className="mt-1 flex flex-col gap-0.5">{openMisconceptionLine}</div>
				) : null}
				<p className="m-0 mt-2 text-[11px] leading-snug text-[var(--inno-text-subtle)]">{t("profile.conclusion.source")}</p>
			</div>
		);
	}

	const fact = t("profile.conclusion.fact", {
		// `count` drives English plural selection ("1 concept" / "2 concepts");
		// `total` is the placeholder the Chinese sentence reads.
		count: overview.totalConcepts,
		total: overview.totalConcepts,
		weak: overview.weakCount > 0 ? t("profile.conclusion.weakClause", { count: overview.weakCount }) : "",
		stable: overview.stableCount > 0 ? t("profile.conclusion.stableClause", { count: overview.stableCount }) : "",
		unknown: overview.unknownCount > 0 ? t("profile.conclusion.unknownClause", { count: overview.unknownCount }) : "",
	});

	/** No weak state and nothing stable: the only honest statement is "unknown". */
	const onlyUnknown = overview.weakCount === 0 && overview.stableCount === 0 && overview.unknownCount > 0;

	return (
		<div className="mb-3.5">
			<p className="m-0 text-sm leading-relaxed text-[var(--inno-text)]">{fact}</p>

			<div className="mt-1 flex flex-col gap-0.5">
				{overview.weakCount === 0 ? (
					<>
						<p className="m-0 text-xs leading-relaxed text-[var(--inno-text-muted)]">
							{onlyUnknown ? t("profile.conclusion.onlyUnknown") : t("profile.conclusion.noWeak")}
						</p>
						{openMisconceptionLine}
					</>
				) : (
					<>
						{overview.reviewDueStates > 0 ? (
							<p className="m-0 text-xs leading-relaxed text-[var(--inno-text-muted)]">
								{t("profile.conclusion.reviewDue", { count: overview.reviewDueStates })}
							</p>
						) : null}
						{overview.misconceptionStateCount > 0 ? (
							<p className="m-0 text-xs leading-relaxed text-[var(--inno-text-muted)]">
								{t("profile.conclusion.misconceptionStates", { count: overview.misconceptionStateCount })}
							</p>
						) : null}
						{openMisconceptionLine}
						<p className="m-0 text-xs leading-relaxed text-[var(--inno-text-muted)]">{t("profile.conclusion.weakPointer")}</p>
					</>
				)}
			</div>

			<p className="m-0 mt-2 text-[11px] leading-snug text-[var(--inno-text-subtle)]">{t("profile.conclusion.source")}</p>
		</div>
	);
}
