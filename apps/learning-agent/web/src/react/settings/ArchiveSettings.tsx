import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../i18n/index.js";
import {
	Archive, ArchiveRestore, BookOpen, ChevronDown, ChevronRight, ClipboardList, ExternalLink, Loader2,
	MoreHorizontal, Trash2,
} from "lucide-react";
import { Button, Dialog, DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { navigate } from "../shell/navigation.js";
import { DeletionDialog, type DeletionTarget } from "../courses/DeletionDialog.js";
import type { CourseSummary } from "../../api/courses.js";
import type { SessionMeta } from "../../api/sessions.js";

/**
 * E4.8e — the single archive centre.
 *
 * One settings tab lists everything that left the daily pages, grouped by the
 * course it really belongs to (`session.course.course_id`, never a title):
 *
 * - **A** a course that is itself archived: every conversation of the course,
 *   including the ones hidden only because of the course;
 * - **B** a live course with some manually archived conversations: only those;
 * - **C** both: the course card shows every conversation and marks each row
 *   with the reason it is here;
 * - **D** legacy conversations with no course binding, in their own group.
 *
 * A course with nothing archived is not listed at all.
 *
 * The two archive states stay independent: restoring a course never clears a
 * session's own flag, and a child of an archived course cannot be restored on
 * its own (the server refuses too). Everything destructive goes through the
 * existing flows — the shared `DeletionDialog` for a course (E4.8d risk
 * confirmation + cascading cleanup) and the session delete confirmation below.
 */

/** One course group in the list. */
interface ArchiveGroup {
	kind: "course";
	courseId: string;
	title: string;
	/** The course itself is archived (type A/C). */
	courseArchived: boolean;
	/** Conversations listed under the group, newest first. */
	sessions: SessionMeta[];
}

interface UnclassifiedGroup {
	kind: "unclassified";
	sessions: SessionMeta[];
}

type Group = ArchiveGroup | UnclassifiedGroup;

/** Minimal translation surface these helpers need (E4.9b). */
type Translate = (key: string, options?: Record<string, unknown>) => string;

function sessionName(session: SessionMeta, t: Translate): string {
	return session.name || t("archive.session.untitled");
}

/** The reason a conversation is in the archive centre, in display order. */
function archiveReason(session: SessionMeta, t: Translate): { label: string; manual: boolean } {
	if (session.archived === true) {
		return {
			label: session.course?.archived === true
				? t("archive.reason.manualCourseArchived")
				: t("archive.reason.manual"),
			manual: true,
		};
	}
	return { label: t("archive.reason.byCourse"), manual: false };
}

function timeLabel(iso: string): string {
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? new Date(parsed).toLocaleString(currentLocale()) : "";
}

function errorMessage(err: unknown, fallback: string, t: Translate): string {
	const data = (err as { data?: Record<string, unknown> } | undefined)?.data;
	if (typeof data?.message === "string" && data.message) return data.message;
	const status = (err as { status?: number } | undefined)?.status;
	if (status === 409) return t("archive.errors.conflict", { fallback });
	return err instanceof Error
		? t("archive.errors.detail", { fallback, message: err.message })
		: t("archive.errors.retry", { fallback });
}

export function ArchiveSettings() {
	const { t } = useTranslation();
	const sessionsState = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		loading: sessionsStore.isLoading,
		error: sessionsStore.loadError,
	}));
	const coursesState = useStoreSnapshot(coursesStore, () => ({
		courses: coursesStore.courses,
		loading: coursesStore.coursesLoading,
		error: coursesStore.coursesError,
		pendingAction: coursesStore.pendingAction,
	}));

	const [busyId, setBusyId] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
	const [courseTarget, setCourseTarget] = useState<DeletionTarget | null>(null);
	/** Expanded course ids; the learner's own choice survives a data refresh. */
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	useEffect(() => {
		void sessionsStore.load();
		void coursesStore.loadCourses();
	}, []);

	const groups = useMemo(() => buildGroups(coursesState.courses, sessionsState.sessions), [
		coursesState.courses,
		sessionsState.sessions,
	]);

	const totalSessions = groups.reduce((sum, group) => sum + group.sessions.length, 0);
	// "No archive content" must never be painted while a list is still unknown or
	// failed: both keep the loading / error branch instead of the empty state.
	const loading = sessionsState.loading || (coursesState.loading && coursesState.courses.length === 0);
	const loadError = coursesState.error ?? sessionsState.error;

	/** Re-read both owners: course restore changes derived session visibility. */
	const refreshAll = async () => {
		await Promise.all([coursesStore.loadCourses(), sessionsStore.refresh()]);
	};

	const restoreCourse = async (course: CourseSummary) => {
		setBusyId(course.course_id);
		setFeedback(null);
		try {
			const done = await coursesStore.restoreCourse(course.course_id);
			if (!done) {
				setFeedback({ tone: "error", message: coursesStore.feedback?.message ?? t("archive.errors.restoreCourseRetry") });
				return;
			}
			// The course row and every child's derived `daily_visible` /
			// `course.archived` come from the server; the session list must be
			// re-read or the groups keep the old split.
			await sessionsStore.refresh();
			setFeedback({ tone: "success", message: t("archive.feedback.courseRestored", { title: course.title }) });
		} catch (err) {
			setFeedback({ tone: "error", message: errorMessage(err, t("archive.errors.restoreCourse"), t) });
		} finally {
			setBusyId(null);
		}
	};

	const restoreSession = async (session: SessionMeta) => {
		const name = sessionName(session, t);
		setBusyId(session.id);
		setFeedback(null);
		try {
			await sessionsStore.unarchiveSession(session.id);
			await sessionsStore.refresh();
			setFeedback({ tone: "success", message: t("archive.feedback.sessionRestored", { name }) });
		} catch (err) {
			setFeedback({ tone: "error", message: errorMessage(err, t("archive.errors.restoreSession"), t) });
		} finally {
			setBusyId(null);
		}
	};

	const removeSession = async () => {
		if (!deleteTarget) return;
		const { id, name } = deleteTarget;
		setBusyId(id);
		setFeedback(null);
		try {
			// The runtime may still be bound to an archived conversation; the
			// server decides inside its queue whether a blank successor is needed.
			await sessionsStore.deleteSession(id, { createReplacement: true });
			await refreshAll();
			setFeedback({ tone: "success", message: t("archive.feedback.sessionDeleted", { name }) });
		} catch (err) {
			// A failure removes nothing locally; the row stays visible.
			setFeedback({ tone: "error", message: errorMessage(err, t("archive.errors.delete"), t) });
		} finally {
			setBusyId(null);
			setDeleteTarget(null);
		}
	};

	const openHistory = (sessionId: string) => {
		navigate("learn", { history: "push", session: sessionId });
		void sessionsStore.openSession(sessionId, { historyMode: "none" });
	};

	/** Session actions, shared by every group; only what applies is offered. */
	const sessionRow = (session: SessionMeta, courseArchived: boolean) => {
		const name = sessionName(session, t);
		const reason = archiveReason(session, t);
		const busy = busyId === session.id;
		return (
			<div className="mla-archive-session" key={session.id}>
				<div className="mla-archive-session-main">
					<div className="mla-inline" style={{ flexWrap: "wrap", gap: 6 }}>
						<strong className="mla-archive-session-title">{name}</strong>
						<span className={`mla-badge${reason.manual ? " mla-badge--warning" : ""}`}>{reason.label}</span>
						{courseArchived ? <span className="mla-badge">{t("archive.badge.readOnly")}</span> : null}
					</div>
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{timeLabel(session.updatedAt)}
						{session.preview ? ` · ${session.preview}` : ""}
					</p>
				</div>
				<div className="mla-archive-actions">
					<Button size="xs" disabled={busy} onClick={() => openHistory(session.id)}>
						<ExternalLink size={14} aria-hidden="true" />
						{t("archive.actions.viewHistory")}
					</Button>
					{/* A child of an archived course cannot be restored on its own. */}
					<Button
						size="xs"
						disabled={busy || courseArchived}
						title={courseArchived ? t("archive.actions.restoreCourseFirst") : undefined}
						onClick={() => void restoreSession(session)}
					>
						<ArchiveRestore size={14} aria-hidden="true" />
						{t("archive.actions.restoreSession")}
					</Button>
					<Button
						size="xs"
						variant="danger"
						disabled={busy}
						onClick={() => setDeleteTarget({ id: session.id, name })}
					>
						<Trash2 size={14} aria-hidden="true" />
						{t("archive.actions.deleteSession")}
					</Button>
				</div>
			</div>
		);
	};

	const groupCard = (group: Group) => {
		if (group.kind === "unclassified") {
			const expanded = !collapsed.__unclassified;
			return (
				<section className="mla-archive-group" aria-labelledby="archive-unclassified" key="unclassified">
					<button
						type="button"
						className="mla-archive-group-head"
						aria-expanded={expanded}
						onClick={() => setCollapsed((prev) => ({ ...prev, __unclassified: expanded }))}
					>
						{expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
						<span className="mla-archive-group-title" id="archive-unclassified">{t("archive.unclassified.title")}</span>
						<span className="mla-badge">{group.sessions.length}</span>
						<span className="mla-small mla-muted">{t("archive.unclassified.hint")}</span>
					</button>
					{expanded ? (
						<div className="mla-archive-sessions">{group.sessions.map((session) => sessionRow(session, false))}</div>
					) : null}
				</section>
			);
		}

		const course = coursesState.courses.find((row) => row.course_id === group.courseId);
		const expanded = !collapsed[group.courseId];
		const busy = busyId === group.courseId;
		// A binding whose course row is gone has no title; the fallback is a UI
		// string, so it is resolved here instead of inside `buildGroups`.
		const title = group.title || t("archive.unknownCourse");
		return (
			<section className="mla-archive-group" aria-labelledby={`archive-${group.courseId}`} key={group.courseId}>
				<div className="mla-archive-group-head mla-archive-group-head--course">
					<button
						type="button"
						className="mla-archive-group-toggle"
						aria-expanded={expanded}
						onClick={() => setCollapsed((prev) => ({ ...prev, [group.courseId]: expanded }))}
					>
						{expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
						<BookOpen size={16} aria-hidden="true" />
						<span className="mla-archive-group-title" id={`archive-${group.courseId}`}>{title}</span>
						{group.courseArchived ? <span className="mla-badge">{t("archive.badge.archived")}</span> : null}
						<span className="mla-badge">{t("archive.group.sessionCount", { count: group.sessions.length })}</span>
					</button>
					{/* Course-level actions only exist for an archived course. */}
					{group.courseArchived && course ? (
						<>
							<div className="mla-archive-actions mla-archive-actions--course">
								<Button
									size="xs"
									disabled={busy}
									onClick={() => navigate("course", { history: "push", course: { id: course.course_id, view: "overview" } })}
								>
									<BookOpen size={14} aria-hidden="true" />
									{t("archive.actions.courseDetail")}
								</Button>
								<Button
									size="xs"
									disabled={busy}
									onClick={() => navigate("course", { history: "push", course: { id: course.course_id, view: "records" } })}
								>
									<ClipboardList size={14} aria-hidden="true" />
									{t("archive.actions.learningRecords")}
								</Button>
								<Button size="xs" variant="primary" disabled={busy} onClick={() => void restoreCourse(course)}>
									{busy ? <Loader2 size={14} className="mla-spin" /> : <ArchiveRestore size={14} aria-hidden="true" />}
									{t("archive.actions.restoreCourse")}
								</Button>
								<Button
									size="xs"
									variant="danger"
									disabled={busy}
									onClick={() => setCourseTarget({ kind: "course", courseId: course.course_id, title: course.title })}
								>
									<Trash2 size={14} aria-hidden="true" />
									{t("archive.actions.deleteCourse")}
								</Button>
							</div>
							{/* Phones: the same actions in a menu, so nothing overflows. */}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button size="xs" className="mla-archive-actions-menu" aria-label={t("archive.actions.courseMenu", { title })}>
										<MoreHorizontal size={14} aria-hidden="true" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuActionItem
										icon={<BookOpen size={14} />}
										label={t("archive.actions.courseDetail")}
										onSelect={() => navigate("course", { history: "push", course: { id: course.course_id, view: "overview" } })}
									/>
									<DropdownMenuActionItem
										icon={<ClipboardList size={14} />}
										label={t("archive.actions.learningRecords")}
										onSelect={() => navigate("course", { history: "push", course: { id: course.course_id, view: "records" } })}
									/>
									<DropdownMenuActionItem
										icon={<ArchiveRestore size={14} />}
										label={t("archive.actions.restoreCourse")}
										onSelect={() => void restoreCourse(course)}
									/>
									<DropdownMenuActionItem
										variant="danger"
										icon={<Trash2 size={14} />}
										label={t("archive.actions.deleteCourse")}
										onSelect={() => setCourseTarget({ kind: "course", courseId: course.course_id, title: course.title })}
									/>
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					) : (
						<span className="mla-small mla-muted mla-archive-group-hint">
							{t("archive.group.manualArchivedCount", { count: group.sessions.length })}
						</span>
					)}
				</div>
				{expanded ? (
					<div className="mla-archive-sessions">
						{group.sessions.map((session) => sessionRow(session, group.courseArchived))}
					</div>
				) : null}
			</section>
		);
	};

	return (
		<section className="mla-card" aria-labelledby="settings-archive">
			<div className="mla-card-header">
				<div>
					<h2 id="settings-archive">{t("archive.title")}</h2>
					<span className="mla-small mla-muted">
						{t("archive.description")}
					</span>
				</div>
				<span className="mla-badge">{t("archive.summary", { groups: groups.length, sessions: totalSessions })}</span>
			</div>

			{feedback ? (
				<p role={feedback.tone === "success" ? "status" : "alert"} className={`mla-notice mla-notice--${feedback.tone}`}>
					{feedback.message}
				</p>
			) : null}

			{loading ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					{t("archive.loading")}
				</p>
			) : loadError ? (
				<div>
					<p role="alert" className="mla-notice mla-notice--error">
						{t("archive.loadFailed", { message: loadError })}
					</p>
					<Button size="xs" onClick={() => void refreshAll()}>{t("archive.retry")}</Button>
				</div>
			) : groups.length === 0 ? (
				<div className="mla-empty">
					<Archive size={26} aria-hidden="true" />
					<strong>{t("archive.empty.title")}</strong>
					<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
						{t("archive.empty.hint")}
					</p>
				</div>
			) : (
				<div className="mla-archive-groups">{groups.map(groupCard)}</div>
			)}

			{deleteTarget ? (
				<Dialog label={t("archive.deleteDialog.label")} className="mla-dialog" onClose={() => setDeleteTarget(null)}>
					<div className="mla-dialog-body">
						<h2>{t("archive.deleteDialog.title", { name: deleteTarget.name })}</h2>
						<p className="mla-text" style={{ margin: 0 }}>
							{t("archive.deleteDialog.body")}
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{t("archive.deleteDialog.evidenceNote")}
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{t("archive.deleteDialog.runtimeNote")}
						</p>
						<div className="mla-dialog-actions">
							<Button onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</Button>
							<Button variant="danger" disabled={busyId === deleteTarget.id} onClick={() => void removeSession()}>
								<Trash2 size={14} aria-hidden="true" />
								{t("archive.deleteDialog.confirm")}
							</Button>
						</div>
					</div>
				</Dialog>
			) : null}

			{/* E4.8d: the shared course dialog keeps its risk summary and cascade. */}
			<DeletionDialog
				target={courseTarget}
				onClose={() => setCourseTarget(null)}
				onDeleted={() => {
					// The delete removed the course's conversations too; re-read both.
					void refreshAll();
				}}
			/>
		</section>
	);
}

/**
 * Group the archive centre from server state.
 *
 * Ordering: archived courses first (they are the most consequential), then
 * live courses that only lost conversations, then legacy unclassified rows.
 * Inside a group the newest activity comes first.
 */
export function buildGroups(courses: readonly CourseSummary[], sessions: readonly SessionMeta[]): Group[] {
	const courseById = new Map(courses.map((course) => [course.course_id, course]));
	const byCourse = new Map<string, SessionMeta[]>();
	const unclassified: SessionMeta[] = [];

	for (const session of sessions) {
		const courseId = session.course?.course_id ?? null;
		if (!courseId) {
			// Type D: only conversations that are actually archived, and only when
			// they truly have no binding — never guessed into a course.
			if (session.archived === true) unclassified.push(session);
			continue;
		}
		const course = courseById.get(courseId);
		const courseArchived = course?.status === "archived" || session.course?.archived === true;
		// A live course contributes only its manually archived conversations.
		// An archived course contributes all of them.
		if (!courseArchived && session.archived !== true) continue;
		const rows = byCourse.get(courseId) ?? [];
		rows.push(session);
		byCourse.set(courseId, rows);
	}

	// An archived course with no conversations still gets a group: the learner
	// must be able to restore or delete it.
	for (const course of courses) {
		if (course.status === "archived" && !byCourse.has(course.course_id)) {
			byCourse.set(course.course_id, []);
		}
	}

	const newest = (a: SessionMeta, b: SessionMeta) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
	const groups: Group[] = [];
	for (const [courseId, rows] of byCourse) {
		const course = courseById.get(courseId);
		groups.push({
			kind: "course",
			courseId,
			// A binding whose course row is gone still names its title; the group
			// is keyed by the real id either way. The missing-title fallback is a
			// UI string and stays empty here so this pure helper needs no `t()`.
			title: course?.title ?? rows[0]?.course?.title ?? "",
			courseArchived: course?.status === "archived" || rows.some((row) => row.course?.archived === true),
			sessions: [...rows].sort(newest),
		});
	}
	groups.sort((a, b) => {
		if (a.kind !== "course" || b.kind !== "course") return a.kind === "course" ? -1 : 1;
		if (a.courseArchived !== b.courseArchived) return a.courseArchived ? -1 : 1;
		// A group whose course row is gone has no title; it sorts last and its
		// visible label is resolved at the render site.
		if (!a.title || !b.title) return Number(!a.title) - Number(!b.title);
		return a.title.localeCompare(b.title, currentLocale());
	});
	if (unclassified.length > 0) {
		groups.push({ kind: "unclassified", sessions: [...unclassified].sort(newest) });
	}
	return groups;
}
