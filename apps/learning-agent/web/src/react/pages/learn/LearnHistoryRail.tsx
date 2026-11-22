import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import type { SessionMeta } from "../../../api/sessions.js";
import type { LearnCourseBarCourse } from "./LearnCourseBar.js";
import { Badge, Button, IconButton } from "../../ui/index.js";
import { hasOpenOverlay, useModalLayer } from "../../ui/modal-layer.js";

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
 * - 901–1279px and ≤900px: a drawer over the chat, with real modal semantics.
 *
 * E4.9g-P2-4-R1 — why the drawer is now `role="dialog" aria-modal="true"`:
 * before this, `aria-hidden` was the only hiding mechanism while closed, which
 * takes the rail out of the accessibility tree but *not* out of the Tab order.
 * A keyboard could land on the off-screen "new conversation" button, and on
 * phones the `transform`-based hiding left the same buttons focusable. The
 * drawer now applies native `inert` while closed and a proper modal layer
 * (`useModalLayer`: background inert, scroll lock, Tab loop, focus restore)
 * while open. The permanent column never gets either.
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
	const drawerOpen = draggable && open;

	/**
	 * The drawer trigger lives in the course bar. On close the previous focus
	 * target is usually still there; when a viewport change removed it (the
	 * permanent rail has no drawer button), focus falls back to the first
	 * control of the chat region rather than to `<body>`.
	 */
	const fallbackFocus = useCallback((): HTMLElement | null => {
		const bar = document.querySelector<HTMLElement>(".mla-course-bar");
		return bar?.querySelector<HTMLElement>("button:not([disabled])") ?? bar;
	}, []);

	/**
	 * Closed drawer: `inert` removes every control from the Tab order and from
	 * the accessibility tree, in both drawer layouts. This is deliberately tied
	 * to `draggable` — the permanent column must stay fully interactive.
	 *
	 * Declared *before* `useModalLayer` on purpose: effects run in order, and a
	 * browser refuses to move focus into an `inert` subtree. Opening the drawer
	 * must clear `inert` first, or the modal layer's initial focus silently
	 * stays on `<body>`.
	 */
	useEffect(() => {
		const rail = railRef.current;
		if (!rail) return;
		rail.inert = draggable && !open;
	}, [draggable, open]);

	/**
	 * Modal layer while the drawer is open. `useModalLayer` skips overlay
	 * portals, so a Radix menu opened from a session row keeps working.
	 */
	useModalLayer(railRef, { active: drawerOpen, fallbackFocus });

	// Escape closes only the drawer, and only when no menu/dialog inside it is
	// open — those own their own Escape (Radix closes them first).
	useEffect(() => {
		if (!drawerOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (hasOpenOverlay()) return;
			event.preventDefault();
			onClose();
		};
		// Capture: the layer must see Escape before a nested widget swallows it,
		// but after Radix's own handlers have marked theirs as handled.
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
			// Drawer: a real modal dialog. Permanent column: a plain labelled region.
			role={draggable ? "dialog" : undefined}
			aria-modal={draggable && open ? true : undefined}
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
