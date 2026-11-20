import { useTranslation } from "react-i18next";
import type { CourseSummary } from "../../api/courses.js";

/**
 * Course identity for the today page (E4.9f / direction B).
 *
 * The course payload has no cover image and no colour field, so the cover is
 * derived from the course id: a stable palette index plus the first character
 * of the title. Nothing here invents a course code, stage or subject — the
 * banner copy comes from the daily plan, and the tile only carries the title's
 * first character.
 *
 * The three cover colours are decorative tokens (`--inno-cover-1..3`); they are
 * never used for status, actions or text outside the cover.
 */

export type CoverSize = "sm" | "md";

type CoverCourse = Pick<CourseSummary, "course_id" | "title">;

/** Stable 1..3 palette index; the same course keeps its cover across reloads. */
export function coverVariant(course: CoverCourse): 1 | 2 | 3 {
	let hash = 0;
	for (const char of course.course_id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return ((hash % 3) + 1) as 1 | 2 | 3;
}

export function coverClass(course: CoverCourse): string {
	return `is-cover-${coverVariant(course)}`;
}

function initialOf(title: string): string {
	const first = Array.from(title.trim())[0] ?? "#";
	return first.toUpperCase();
}

/** Small square used in the course list and sidebar-free rows. */
export function CourseCover({
	course,
	size = "md",
	className = "",
}: {
	course: CoverCourse;
	size?: CoverSize;
	className?: string;
}) {
	return (
		<span
			className={`mla-today-cover mla-today-cover--${size} ${coverClass(course)}${className ? ` ${className}` : ""}`}
			aria-hidden="true"
		>
			<span className="mla-today-cover-initial">{initialOf(course.title)}</span>
		</span>
	);
}

/**
 * Wide cover for a task card. The kicker is the server's stage title (or the
 * plan title when a stage is absent); the pill is the task's estimated minutes.
 * Both are real payload fields; no course code is fabricated.
 */
export function TaskCover({
	course,
	stage,
	minutes,
}: {
	course: CoverCourse;
	stage?: string;
	minutes: number;
}) {
	const { t } = useTranslation();
	const variant = coverVariant(course);
	return (
		<div className={`mla-today-cover ${coverClass(course)}`} aria-hidden="true">
			<span className="mla-today-cover-kicker">{stage ?? course.title}</span>
			<span className="mla-today-cover-minutes">{t("course.card.minutes", { count: minutes })}</span>
			<Motif variant={variant} />
		</div>
	);
}

function Motif({ variant }: { variant: 1 | 2 | 3 }) {
	if (variant === 2) {
		return (
			<svg className="mla-today-cover-motif" viewBox="0 0 100 60" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
				<path d="M6 14h64M6 24h76M6 34h52M6 44h68" />
			</svg>
		);
	}
	if (variant === 3) {
		return (
			<svg className="mla-today-cover-motif" viewBox="0 0 100 60" fill="none" stroke="currentColor" strokeWidth="1.4">
				<circle cx="22" cy="16" r="5" /><circle cx="50" cy="30" r="5" /><circle cx="78" cy="16" r="5" />
				<circle cx="30" cy="46" r="5" /><circle cx="70" cy="46" r="5" />
				<path d="M27 19l18 8M45 27l28-8M26 21l2 20M54 33l12 9M73 20l-2 21" />
			</svg>
		);
	}
	return (
		<svg className="mla-today-cover-motif" viewBox="0 0 100 60" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
			<path d="M6 42c14-2 16-22 30-24 12-2 14 20 26 22 10 2 14-12 30-14" />
			<path d="M6 50h88" strokeOpacity=".3" />
		</svg>
	);
}
