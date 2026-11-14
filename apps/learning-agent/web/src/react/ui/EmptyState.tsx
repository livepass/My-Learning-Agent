import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Empty / zero-content state.
 *
 * E4.9c: 19 places hand-wrote the same `div.mla-empty > svg + strong + p`
 * structure, so the icon size, gap and text hierarchy drifted. This component
 * owns the layout; the copy and any action stay with the page (already
 * translated there).
 *
 * It deliberately does not decide *whether* to show an empty state: a page
 * whose list failed to load must render its error branch instead, never this.
 */
export interface EmptyStateProps {
	icon?: LucideIcon;
	/** Short, translated headline. */
	title: ReactNode;
	/** One or two sentences of guidance. */
	description?: ReactNode;
	/** Optional action (a `Button`), rendered under the text. */
	action?: ReactNode;
	/** Compact variant for narrow panels and inline sections. */
	compact?: boolean;
	className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, compact = false, className = "" }: EmptyStateProps) {
	return (
		<div
			className={`mla-empty${compact ? " mla-empty--compact" : ""}${className ? ` ${className}` : ""}`}
			role="status"
		>
			{Icon ? <Icon size={compact ? 22 : 30} aria-hidden="true" /> : null}
			<strong>{title}</strong>
			{description ? (
				<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
					{description}
				</p>
			) : null}
			{action}
		</div>
	);
}
