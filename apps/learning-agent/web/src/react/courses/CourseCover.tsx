import { BookMarked } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CourseSummary } from "../../api/courses.js";

/**
 * Course identity for the today page (E4.9f / direction B).
 *
 * The course payload has no cover image and no colour field, so the cover is
 * derived from the course id: a stable palette index.
 *
 * UI-C01: the tile used to show the title's first character. The course name is
 * always written next to the tile, so that character added no identity, and it
 * split Chinese and Latin courses into two different visual languages (`同`,
 * `机` vs `P`, `D`). Every course now shares one `BookMarked` glyph; only the
 * palette index still varies per course.
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

/** Small square used in the course list and the course bar. */
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
			<BookMarked size={size === "sm" ? 14 : 18} strokeWidth={1.75} />
		</span>
	);
}

/**
 * Wide cover for a task card. The kicker is the server's stage title; the pill
 * is the task's estimated minutes. Both are real payload fields.
 *
 * UI-C01: the card body names the course, so the cover must not fall back to the
 * course title when the server has no stage — that showed the same name twice.
 * A stage that happens to equal the course title is skipped for the same reason;
 * no stage is ever invented.
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
	const kicker = stage && stage !== course.title ? stage : null;
	return (
		<div className={`mla-today-cover ${coverClass(course)}`} aria-hidden="true">
			{kicker ? <span className="mla-today-cover-kicker">{kicker}</span> : null}
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
