import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import type { SessionMeta } from "../../../api/sessions.js";
import type { LearnCourseBarCourse } from "./LearnCourseBar.js";
import { Badge, Button, IconButton } from "../../ui/index.js";

/**
 * E4.9g-P2-4 — the course / conversation rail beside the chat.
 *
 * Extracted from `LearnPage` without changing its markup or behaviour. It is
 * presentation only: opening, renaming, archiving, deleting, switching course
 * and starting a new conversation all stay with the page through callbacks.
 *
 * Two presentations share this one component, because the content is identical
 * and only the frame differs:
 *
 * - ≥1280px: a permanent grid column. Not a dialog, no backdrop, no focus trap.
 * - 901–1279px and ≤900px: a drawer over the chat. It gets a close button,
 *   backdrop, Escape, focus-in on open and focus-back on close — but the
 *   `aria-modal`/`inert` treatment stays in `LearnPage`, because only the page
 *   knows whether the rail is currently a drawer.
 */
export function LearnHistoryRail({
	draggable,
	open,
	course,
	title,
	canStartNew,
	creating,
	conversations,
	conversationCount,
	unclassifiedSessions,
	showUnclassified,
	archiveEntryCount,
	archivedCourseCount,
	hiddenSessionCount,
	actionError,
	renderSessionRow,
	onBack,
	onClose,
	onNewConversation,
	onToggleUnclassified,
	onOpenArchive,
}: {
	/** True when the rail is an overlay drawer (narrow viewport). */
	draggable: boolean;
	/** Drawer visibility; ignored when `draggable` is false. */
	open: boolean;
	course: LearnCourseBarCourse | null;
	title: string;
	/** Same authority as the composer: only an in-progress course may start one. */
	canStartNew: boolean;
	creating: boolean;
	conversations: SessionMeta[];
	/** Total for the course, so "none yet" is never shown while rows exist. */
	conversationCount: number;
	unclassifiedSessions: SessionMeta[];
	showUnclassified: boolean;
	archiveEntryCount: number;
	archivedCourseCount: number;
	hiddenSessionCount: number;
	actionError: string | null;
	renderSessionRow: (session: SessionMeta) => ReactNode;
	onBack: () => void;
	onClose: () => void;
	onNewConversation: () => void;
	onToggleUnclassified: () => void;
	onOpenArchive: () => void;
}) {
	const { t } = useTranslation();
	const railRef = useRef<HTMLElement>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const drawerOpen = draggable && open;

	/**
	 * Drawer focus handling. Focus moves to the rail's first control on open and
	 * returns to whatever had it before on close. The page owns Escape and the
	 * backdrop; this only moves focus, so it cannot drift from those handlers.
	 */
	useEffect(() => {
		if (!drawerOpen) return;
		const rail = railRef.current;
		previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const first = rail?.querySelector<HTMLElement>(
			"button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
		);
		(first ?? rail)?.focus({ preventScroll: true });
		return () => {
			const back = previousFocus.current;
			previousFocus.current = null;
			// Only restore if the trigger still exists (the bar may have unmounted).
			if (back?.isConnected) back.focus({ preventScroll: true });
		};
	}, [drawerOpen]);

	// Escape closes only the drawer; the permanent rail has nothing to close.
	useEffect(() => {
		if (!drawerOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				event.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [drawerOpen, onClose]);

	const unclassifiedExpanded = !course || showUnclassified;

	return (
		<aside
			ref={railRef}
			className="mla-learn-sidebar"
			aria-label={t("learn.sidebar.aria")}
			tabIndex={-1}
			aria-hidden={draggable && !open ? true : undefined}
		>
			<div className="mla-learn-sidebar-head">
				<IconButton size="sm" aria-label={t("learn.sidebar.backToCourses")} onClick={onBack}>
					<ArrowLeft size={16} aria-hidden="true" />
				</IconButton>
				<h2>{title}</h2>
				{course?.status ? (
					<Badge tone={course.status === "in_progress" ? "accent" : "neutral"}>
						{t(`course.status.${course.status}`)}
					</Badge>
				) : null}
				{drawerOpen ? (
					<IconButton
						size="sm"
						className="mla-learn-sidebar-close"
						aria-label={t("learn.sidebar.closeNav")}
						onClick={onClose}
					>
						<X size={16} aria-hidden="true" />
					</IconButton>
				) : null}
			</div>

			{canStartNew ? (
				<Button size="xs" disabled={creating} onClick={onNewConversation}>
					<Plus size={14} aria-hidden="true" />
					{t("learn.sidebar.newConversation")}
				</Button>
			) : null}

			<div className="mla-course-convos">
				{course ? (
					conversationCount === 0 ? (
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{t("learn.sidebar.noConversations")}
						</p>
					) : conversations.map(renderSessionRow)
				) : null}
			</div>

			{/*
			 * Legacy history stays its own, explicitly labelled group: a course
			 * conversation is never listed as if it were unclassified, and the
			 * group is never rebound to the selected course.
			 */}
			{unclassifiedSessions.length > 0 ? (
				<div className="mla-course-nav-item">
					<button
						type="button"
						className="mla-course-nav-toggle mla-course-nav-toggle--loose"
						aria-expanded={unclassifiedExpanded}
						onClick={onToggleUnclassified}
					>
						{unclassifiedExpanded
							? <ChevronDown size={14} aria-hidden="true" />
							: <ChevronRight size={14} aria-hidden="true" />}
						<Archive size={14} aria-hidden="true" />
						<span className="mla-course-nav-title">{t("learn.sidebar.unclassifiedHistory")}</span>
						<Badge>{unclassifiedSessions.length}</Badge>
					</button>
					{unclassifiedExpanded ? (
						<div className="mla-course-convos">{unclassifiedSessions.map(renderSessionRow)}</div>
					) : null}
				</div>
			) : null}

			{/* E4.8f: one entry for the unified archive centre. */}
			{archiveEntryCount > 0 ? (
				<button type="button" className="mla-session-toggle" onClick={onOpenArchive}>
					{t("learn.sidebar.archiveEntry", {
						courses: archivedCourseCount,
						sessions: hiddenSessionCount,
					})}
				</button>
			) : null}

			{actionError ? (
				<p role="alert" className="mla-small" style={{ margin: "8px 0 0", color: "var(--inno-danger)" }}>
					{actionError}
				</p>
			) : null}
		</aside>
	);
}
