import type { HTMLAttributes, ReactNode } from "react";

/**
 * Content surface.
 *
 * E4.9c: the learning pages had six card classes (`.mla-card`,
 * `.mla-practice-card`, `.mla-archive-group`, `.mla-course-card`,
 * `.mla-course-pick`, `.mla-quick-card`) that each re-declared the same border,
 * radius and surface. They now share this base and differ only by *variant*:
 *
 * - `default`    — ordinary content card (stats, lists, settings);
 * - `practice`   — the single practice card (slightly larger inset);
 * - `group`      — an expandable archive group with a header and child list;
 * - `selectable` — a card that is itself a button (course tiles, quick starts).
 *
 * Layout inside the card stays with the caller: this component never forces a
 * grid, so cards with different content still look like themselves.
 */
export type CardVariant = "default" | "practice" | "group" | "selectable";

const VARIANT_CLASS: Record<CardVariant, string> = {
	default: "mla-card",
	practice: "mla-practice-card",
	group: "mla-archive-group",
	selectable: "mla-course-pick",
};

export interface CardProps extends HTMLAttributes<HTMLElement> {
	variant?: CardVariant;
	children: ReactNode;
	/** Render as `<section>` (default), `<article>` or `<div>`. */
	as?: "section" | "article" | "div";
}

export function Card({ variant = "default", as = "section", className = "", children, ...props }: CardProps) {
	const Tag = as;
	return (
		<Tag className={`${VARIANT_CLASS[variant]}${className ? ` ${className}` : ""}`} {...props}>
			{children}
		</Tag>
	);
}
