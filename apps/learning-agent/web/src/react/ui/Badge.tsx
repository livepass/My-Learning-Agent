import type { HTMLAttributes, ReactNode } from "react";

/**
 * Status / metadata badge.
 *
 * E4.9c: the learning pages had 118 hand-written `mla-badge` spans with the
 * tone chosen inline (`cond ? " mla-badge--accent" : ""`), so the same status
 * could be painted differently on two pages. This component owns the surface
 * and the tones; callers pass the text, which they already translate.
 *
 * Tone is a *meaning*, never a colour: `accent` = current/selected,
 * `success` / `warning` / `danger` = a real state, `neutral` = plain metadata.
 * Nothing here depends on a store or an API.
 */
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_CLASS: Record<BadgeTone, string> = {
	neutral: "",
	accent: " mla-badge--accent",
	success: " mla-badge--success",
	warning: " mla-badge--warning",
	danger: " mla-badge--danger",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
	tone?: BadgeTone;
	children: ReactNode;
}

export function Badge({ tone = "neutral", className = "", children, ...props }: BadgeProps) {
	return (
		<span className={`mla-badge${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`} {...props}>
			{children}
		</span>
	);
}

/**
 * A badge whose tone is derived from a status value.
 *
 * The caller supplies the already-translated label and the status it came
 * from; the mapping from status to tone lives with the product, not here, so
 * this component stays free of course/learning vocabulary.
 */
export interface StatusBadgeProps extends Omit<BadgeProps, "tone"> {
	/** The tone to use; usually computed by the page from its status value. */
	tone: BadgeTone;
}

export function StatusBadge({ tone, ...props }: StatusBadgeProps) {
	return <Badge tone={tone} {...props} />;
}
