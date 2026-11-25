import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { KnowledgeState } from "../../types/learner.js";
import { KnowledgeStateBadge } from "./KnowledgeStateBadge.js";

/**
 * 需要关注的知识点 (E4.9i-P2-3).
 *
 * Display only. It receives the already-filtered weak states in the server's
 * order and renders, for each: name, domain (when present), the formal state
 * badge, and the first `next_actions` entry the profile already stores. It
 * never computes a state, ranks by mastery, generates a suggestion, writes
 * evidence or touches a store.
 *
 * `next_actions` may be human-maintained, so the empty case says 「暂无记录」
 * rather than inventing advice, and `diagnosis` is never substituted for it —
 * a diagnosis is what is wrong, not what to do next.
 *
 * The list is capped at `LIMIT` for page length. That is a display cut only:
 * the order is the server's, the remainder is announced with its count, and the
 * full list stays in 知识状态 directly above.
 */
export const WEAK_PREVIEW_LIMIT = 3;

export interface WeakKnowledgeSectionProps {
	/** States satisfying `isWeakKnowledgeState`, in the server's order. */
	weakConcepts: KnowledgeState[];
	/** Total recorded states, so an empty result can tell "none" from "no data". */
	totalConcepts: number;
	/** States with no usable label; mentioned when the weak list is empty. */
	unknownCount: number;
}

/** A stored name may be blank or a machine identity; degrade instead of leaking it. */
function displayName(state: KnowledgeState, fallback: string): string {
	const name = state.concept_name?.trim();
	return name ? name : fallback;
}

export function WeakKnowledgeSection({ weakConcepts, totalConcepts, unknownCount }: WeakKnowledgeSectionProps) {
	const { t } = useTranslation();

	if (totalConcepts === 0) {
		return (
			<p className="m-0 rounded-xl border border-dashed border-[var(--inno-border)] px-4 py-3 text-[13px] leading-relaxed text-[var(--inno-text-subtle)]">
				{t("profile.weak.emptyNoData")}
			</p>
		);
	}

	if (weakConcepts.length === 0) {
		return (
			<div className="flex flex-col gap-1">
				<p className="m-0 text-[13px] leading-relaxed text-[var(--inno-text-muted)]">{t("profile.weak.emptyNoWeak")}</p>
				{unknownCount > 0 ? (
					<p className="m-0 text-xs leading-relaxed text-[var(--inno-text-subtle)]">
						{t("profile.weak.emptyUnknown", { count: unknownCount })}
					</p>
				) : null}
			</div>
		);
	}

	const shown = weakConcepts.slice(0, WEAK_PREVIEW_LIMIT);
	const remaining = weakConcepts.length - shown.length;

	return (
		<div className="flex flex-col">
			{shown.map((state) => (
				<div
					key={state.concept_id}
					className="flex flex-col gap-1.5 border-b border-[var(--inno-border)] py-3 first:pt-0 last:border-b-0 last:pb-0"
				>
					<div className="flex flex-wrap items-center gap-2">
						<AlertTriangle size={14} aria-hidden="true" className="shrink-0 text-[var(--inno-warning)]" />
						{/* Long names wrap instead of truncating: the card must never clip content. */}
						<strong className="min-w-0 text-[13.5px] font-medium text-[var(--inno-text)] [overflow-wrap:anywhere]">
							{displayName(state, t("profile.weak.namePending"))}
						</strong>
						<KnowledgeStateBadge stateLabel={state.state_label} />
						{state.domain ? (
							<span className="text-xs text-[var(--inno-text-subtle)]">{state.domain}</span>
						) : null}
					</div>
					{state.next_actions.length > 0 ? (
						<p className="m-0 text-[13px] leading-relaxed text-[var(--inno-text-muted)] [overflow-wrap:anywhere]">
							{t("profile.weak.nextAction", { action: state.next_actions[0] })}
						</p>
					) : (
						<p className="m-0 text-xs leading-relaxed text-[var(--inno-text-subtle)]">{t("profile.weak.noNextAction")}</p>
					)}
				</div>
			))}
			{remaining > 0 ? (
				<p className="m-0 mt-2 text-xs leading-relaxed text-[var(--inno-text-subtle)]">
					{t("profile.weak.remaining", { count: remaining })}
				</p>
			) : null}
		</div>
	);
}
