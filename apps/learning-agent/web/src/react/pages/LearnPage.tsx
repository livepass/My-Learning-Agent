import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArrowLeft, BookOpen, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { appStore } from "../../stores/app-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { learnWorkbenchStore } from "../../stores/learn-workbench-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Badge, Button, Dialog, IconButton, Input } from "../ui/index.js";
import { LearningWorkspace, type LearningBlock, type LearningReadOnlyReason } from "../LearningWorkspace.js";
import { CourseContextStrip } from "../courses/CourseContextStrip.js";
import { CreateCourseDialog } from "../courses/CreateCourseDialog.js";
import { navigate } from "../shell/navigation.js";
import type { SessionMeta } from "../../api/sessions.js";
import { isDailyVisible } from "../../utils/session-visibility.js";
import { useCourseErrorText } from "../courses/use-course-error-text.js";
import { hasRealCheckpoint, LearnContextPanel } from "./learn/LearnContextPanel.js";
import { LearnSessionRow } from "./learn/LearnSessionRow.js";
import { LearnStartPanel } from "./learn/LearnStartPanel.js";

/**
 * E4.8b — AI learning home is a conversation-style welcome page.
 *
 * Two states, decided only by whether a conversation is actually open:
 *
 * - **welcome** (`currentSessionId === null`): a centred 「你想学习什么？」 home
 *   with the learner's course cards and a bottom composer. No course selected →
 *   the composer stays disabled; a selected course swaps the cards for quick
 *   starts and activates the composer. No course/conversation sidebar is shown
 *   here, so the first screen reads like a chat home, not an admin console.
 * - **conversation**: the course-scoped conversation list, the chat, and the
 *   collapsible learning-status panel.
 *
 * Every conversation still belongs to a course *by server binding*
 * (`session.course`); selecting a course never creates a session, and the first
 * message creates one through `learning/start` (E4.8/E4.8a rules unchanged).
 * Legacy unclassified conversations stay reachable and are never rebound.
 */
export function LearnPage() {
	const courseErrorText = useCourseErrorText();
	const { t } = useTranslation();
	const sessionState = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
		sessions: sessionsStore.sessions,
		openingSessionId: sessionsStore.openingSessionId,
	}));
	const courseState = useStoreSnapshot(coursesStore, () => ({
		courses: coursesStore.courses,
		loading: coursesStore.coursesLoading,
		error: coursesStore.coursesError,
		pendingAction: coursesStore.pendingAction,
	}));
	const workbench = useStoreSnapshot(learnWorkbenchStore, () => ({
		courseId: learnWorkbenchStore.courseId,
		creating: learnWorkbenchStore.creating,
		error: learnWorkbenchStore.error,
	}));
	const learning = useStoreSnapshot(learningStore, () => ({
		sessionId: learningStore.sessionId,
		state: learningStore.state,
		isLoading: learningStore.isLoading,
		isSaving: learningStore.isSaving,
		error: learningStore.error,
	}));

	const [createOpen, setCreateOpen] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [showUnclassified, setShowUnclassified] = useState(false);
	const [statusOpen, setStatusOpen] = useState(true);
	/**
	 * E4.8f: a conversation with no real checkpoint starts with the status panel
	 * collapsed (the panel would only say "还没有学习检查点"). Once the learner
	 * opens it themselves, that choice wins for the rest of the visit.
	 */
	const [statusChosenByLearner, setStatusChosenByLearner] = useState(false);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [busySessionId, setBusySessionId] = useState<string | null>(null);
	const [sessionActionError, setSessionActionError] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<{ session: SessionMeta; name: string } | null>(null);

	const { currentSessionId, sessions, openingSessionId } = sessionState;
	const courseId = workbench.courseId;
	/** A conversation is the only thing that switches to the course layout. */
	const conversationMode = Boolean(currentSessionId);

	useEffect(() => {
		void sessionsStore.load();
	}, []);

	useEffect(() => {
		if (coursesStore.courses.length > 0 || coursesStore.coursesLoading) return;
		void coursesStore.loadCourses();
	}, []);

	// The URL is the source of truth: refresh, direct links and Back/Forward all
	// restore the course, and a URL without `?session=` shows the welcome home
	// instead of silently reopening the previous conversation.
	useEffect(() => {
		const apply = () => learnWorkbenchStore.applyLocation();
		apply();
		window.addEventListener("popstate", apply);
		return () => window.removeEventListener("popstate", apply);
	}, []);

	// A conversation's course comes from its server binding — never from the
	// dropdown that happened to be selected when it was opened.
	useEffect(() => {
		if (!currentSessionId) return;
		const meta = sessions.find((session) => session.id === currentSessionId);
		if (!meta) return;
		learnWorkbenchStore.adoptCourse(meta.course?.course_id ?? null);
	}, [currentSessionId, sessions]);

	// Read-only refresh whenever the open session changes. Never initialises.
	useEffect(() => {
		if (!currentSessionId) {
			learningStore.clear();
			return;
		}
		void learningStore.load(currentSessionId);
	}, [currentSessionId]);

	const checkpoint = learning.state?.checkpoint;
	useEffect(() => {
		if (statusChosenByLearner) return;
		// No record loaded yet (or still loading) is not "no checkpoint": keep the
		// panel as it is until the state is known, so it does not flicker.
		if (!currentSessionId || learning.isLoading || learning.error || !learning.state) return;
		setStatusOpen(hasRealCheckpoint(learning.state));
	}, [currentSessionId, learning.isLoading, learning.error, learning.state, statusChosenByLearner]);

	const activeCourses = useMemo(
		() => courseState.courses.filter((course) => course.status !== "archived"),
		[courseState.courses],
	);
	const archivedCourses = useMemo(
		() => courseState.courses.filter((course) => course.status === "archived"),
		[courseState.courses],
	);
	const selectedCourse = courseState.courses.find((course) => course.course_id === courseId) ?? null;
	/** Archived courses never lead the welcome home; they are read-only history. */
	const welcomeCourse = selectedCourse && selectedCourse.status !== "archived" ? selectedCourse : null;

	/** Legacy conversations without a course. Shown, never rebound. */
	const unclassifiedSessions = useMemo(
		() => sessions.filter((session) => !session.course && isDailyVisible(session)),
		[sessions],
	);
	const hiddenSessionCount = sessions.length - sessions.filter(isDailyVisible).length;

	const currentSession = sessions.find((session) => session.id === currentSessionId);
	const sessionContext = useStoreSnapshot(coursesStore, () => coursesStore.sessionContext(currentSessionId));
	/**
	 * E4.8a: a Web conversation with no course binding is legacy history. It stays
	 * readable, but the workbench cannot continue it — the server refuses the turn
	 * as well, so the banner is not the only thing stopping a send.
	 */
	const unclassifiedSession = currentSession
		? !currentSession.course
		: sessionContext?.context.unclassified === true;
	const readOnlySession: LearningReadOnlyReason | false = currentSession?.archived === true
		? "session"
		: currentSession?.course?.archived === true || sessionContext?.context.course?.status === "archived"
			? "course"
			: unclassifiedSession
				? "unclassified"
				: false;
	const canPause = checkpoint?.status === "active" && !learning.isSaving && !readOnlySession;
	const canResume = checkpoint?.status === "paused" && !learning.isSaving && !readOnlySession;

	/** The selected course's conversations (daily-visible, or the open one). */
	const courseConversations = useMemo(
		() => (selectedCourse
			? sessions.filter((session) => session.course?.course_id === selectedCourse.course_id
				&& (isDailyVisible(session) || session.id === currentSessionId))
			: []),
		[selectedCourse, sessions, currentSessionId],
	);

	/**
	 * Why the composer is unavailable. Loading and read failures are their own
	 * states: "no courses" must never be painted while the list is unknown.
	 *
	 * "No course selected" is *not* a block any more: the welcome home keeps a
	 * disabled composer so the learner sees where the question will go.
	 */
	const blocked: LearningBlock | null = (() => {
		// A list that has not loaded (or failed to) is not "no courses": both must
		// keep the composer closed instead of offering a chat with no course.
		if (courseState.loading && courseState.courses.length === 0) {
			return {
				title: t("learn.blocked.loading.title"),
				description: t("learn.blocked.loading.description"),
			};
		}
		if (courseState.error) {
			return {
				title: t("learn.blocked.error.title"),
				description: `${t("learn.blocked.error.description")}${courseState.error}`,
				actionLabel: t("learn.blocked.error.retry"),
				onAction: () => void coursesStore.loadCourses(),
			};
		}
		if (!courseId) return null;
		if (!selectedCourse) {
			return {
				title: t("learn.blocked.unavailable.title"),
				description: t("learn.blocked.unavailable.description"),
				actionLabel: t("learn.blocked.unavailable.action"),
				onAction: () => learnWorkbenchStore.selectCourse(null),
			};
		}
		if (selectedCourse.status === "archived") {
			return {
				title: t("learn.blocked.archived.title"),
				description: t("learn.blocked.archived.description"),
				actionLabel: t("learn.blocked.archived.action"),
				onAction: () => navigate("settings", { history: "push", settingsTab: "archive" }),
			};
		}
		if (selectedCourse.status === "paused") {
			return {
				title: t("learn.blocked.paused.title"),
				description: t("learn.blocked.paused.description"),
				actionLabel: courseState.pendingAction === "resume_course" ? undefined : t("learn.blocked.paused.action"),
				onAction: () => void coursesStore.resumeCourse(selectedCourse.course_id),
			};
		}
		if (selectedCourse.status === "completed") {
			return {
				title: t("learn.blocked.completed.title"),
				description: t("learn.blocked.completed.description"),
			};
		}
		return null;
	})();

	const runSessionAction = async (id: string, action: () => Promise<void>, failure: string) => {
		setSessionActionError(null);
		setBusySessionId(id);
		try {
			await action();
		} catch (err) {
			const message = err instanceof Error ? err.message : t("learn.history.error.retry", { failure });
			setSessionActionError((err as { partial?: boolean } | undefined)?.partial === true
				? message
				: err instanceof Error ? t("learn.history.error.prefix", { failure, message }) : message);
		} finally {
			setBusySessionId(null);
		}
	};

	const archiveOne = (id: string) =>
		runSessionAction(id, async () => {
			try {
				await sessionsStore.archiveSession(id);
			} catch (err) {
				const status = (err as { status?: number } | undefined)?.status;
				throw new Error(status === 409
					? t("learn.history.archive.busy")
					: err instanceof Error ? err.message : t("learn.history.archive.networkError"));
			}
		}, t("learn.history.archive.failed"));

	/**
	 * Permanently delete one conversation after an explicit confirmation.
	 *
	 * The server removes the chat file, its B2 record (questions, attempts,
	 * checkpoint) and the session sidecars. Evidence already projected into the
	 * learner profile is not rewritten, so the copy must describe both halves:
	 * the transcript is gone, the long-term evidence is not.
	 */
	const removeSession = async (id: string, name: string) => {
		const isCurrent = id === currentSessionId;
		const hasOtherVisible = sessions.some((session) => session.id !== id && isDailyVisible(session));
		const createReplacement = isCurrent;
		const copy = [
			t("learn.history.delete.confirm", { name }),
			"",
			t("learn.history.delete.body"),
			"",
			t("learn.history.delete.evidence"),
			"",
			t("learn.history.delete.scope"),
			...(isCurrent
				? [hasOtherVisible
					? t("learn.history.delete.switch")
					: t("learn.history.delete.only")]
					.map((line) => `\n${line}`)
				: []),
		].join("\n");
		if (typeof window !== "undefined" && !window.confirm(copy)) return;
		await runSessionAction(id, async () => {
			try {
				await sessionsStore.deleteSession(id, { createReplacement });
			} catch (err) {
				const data = (err as { data?: Record<string, unknown> } | undefined)?.data;
				if (data?.error === "no_replacement_session") {
					throw new Error(t("learn.history.delete.noReplacement"));
				}
				if (data?.error === "replacement_create_failed") {
					throw new Error(t("learn.history.delete.createFailed"));
				}
				if (data?.error === "replacement_unavailable") {
					throw new Error(t("learn.history.delete.unavailable"));
				}
				if (data?.error === "session_deleting") {
					throw new Error(t("learn.history.delete.deleting"));
				}
				throw err;
			}
		}, t("learn.history.delete.failed"));
	};

	/** Open a conversation; its course is adopted from the binding, not from us. */
	const openConversation = (session: SessionMeta) => {
		setMobileNavOpen(false);
		void sessionsStore.openSession(session.id);
	};

	const startConversation = (targetCourseId: string) => {
		if (learnWorkbenchStore.courseId !== targetCourseId) {
			learnWorkbenchStore.selectCourse(targetCourseId, { history: "replace" });
		}
		learnWorkbenchStore.beginConversation();
		setMobileNavOpen(false);
	};

	/** Back to the course picker; closes the open conversation without deleting it. */
	const goHome = () => {
		setMobileNavOpen(false);
		setShowHistory(false);
		if (learnWorkbenchStore.courseId) learnWorkbenchStore.selectCourse(null);
		else learnWorkbenchStore.beginConversation();
	};

	const chooseCourse = (targetCourseId: string) => {
		setShowHistory(false);
		learnWorkbenchStore.selectCourse(targetCourseId);
	};

	// E4.8e: one archive centre holds both archived courses and archived sessions.
	// E4.8e/E4.8f: one archive centre, one entry. Archived courses and archived
	// sessions are grouped there, so a second button would only duplicate it.
	const openArchive = () => navigate("settings", { history: "push", settingsTab: "archive" });

	/** One row, shared by the welcome history and the conversation sidebar. */
	const renderSessionRow = (session: SessionMeta) => {
		const name = session.name || t("learn.history.unnamed");
		return (
			<LearnSessionRow
				key={session.id}
				session={session}
				active={session.id === currentSessionId}
				busy={Boolean(openingSessionId) || busySessionId === session.id}
				pending={busySessionId === session.id}
				unclassified={unclassifiedSessions.some((row) => row.id === session.id)}
				onOpen={() => openConversation(session)}
				onRename={() => setRenaming({ session, name })}
				onArchive={() => void archiveOne(session.id)}
				onDelete={() => void removeSession(session.id, name)}
			/>
		);
	};

	/**
	 * E4.8f: one archive entry, not two. Both archived courses and archived
	 * sessions live in the same settings page, so separate buttons pointed at
	 * the same destination and only made the footer look like a menu.
	 */
	const archiveEntryCount = archivedCourses.length + hiddenSessionCount;

	/** The composer only unlocks for a course that can actually start now. */
	const composerActive = welcomeCourse?.status === "in_progress";

	const welcomeContent = (
		<LearnStartPanel
			mode="welcome"
			course={welcomeCourse}
			coursesLoading={courseState.loading}
			coursesError={courseState.error}
			activeCourses={activeCourses}
			archivedCourses={archivedCourses}
			sessions={sessions}
			courseConversations={courseConversations}
			unclassifiedSessions={unclassifiedSessions}
			showHistory={showHistory}
			showUnclassified={showUnclassified}
			archiveEntryCount={archiveEntryCount}
			onSelectCourse={chooseCourse}
			onCreateCourse={() => setCreateOpen(true)}
			onRetryCourses={() => void coursesStore.loadCourses()}
			onToggleHistory={() => setShowHistory((value) => !value)}
			onToggleUnclassified={() => setShowUnclassified((value) => !value)}
			onOpenArchive={openArchive}
			onSwitchCourse={goHome}
			onFillDraft={(text) => appStore.setChatDraft(text)}
			renderSessionRow={renderSessionRow}
		/>
	);

	const createDialog = (
		<CreateCourseDialog
			open={createOpen}
			pending={courseState.pendingAction === "create_course"}
			error={courseErrorText(courseState.error)}
			onClose={() => setCreateOpen(false)}
			onCreate={async (input) => {
				const created = await coursesStore.createCourse(input);
				if (!created) return false;
				setCreateOpen(false);
				// Selecting the new course is not the same as starting a
				// conversation: the welcome home opens and the first message
				// creates the session.
				chooseCourse(created.course_id);
				return true;
			}}
		/>
	);

	if (!conversationMode) {
		return (
			<div className="mla-learn mla-learn--welcome">
				<section className="mla-chat-card mla-chat-card--welcome" aria-label={t("learn.welcome.aria")}>
					<LearningWorkspace
						blocked={blocked}
						creating={workbench.creating}
						createError={workbench.error}
						createConversation={() => learnWorkbenchStore.ensureConversation()}
						welcome={welcomeContent}
						composerPlaceholder={welcomeCourse
							? t("learn.welcome.composerPlaceholder", { title: welcomeCourse.title })
							: t("learn.welcome.composerDisabledPlaceholder")}
						composerDisabled={!composerActive}
					/>
				</section>
				{createDialog}
			</div>
		);
	}

	/**
	 * E4.8f — an empty conversation is not a blank page.
	 *
	 * The hint names the course (or the unclassified history), and the starters
	 * only fill the composer. Nothing here claims progress or a review plan.
	 */
	const emptyConversationCourse = selectedCourse
		?? (currentSession?.course
			? { course_id: currentSession.course.course_id, title: currentSession.course.title }
			: null);
	const emptyState = !blocked && !readOnlySession ? (
		<LearnStartPanel
			mode="empty"
			courseTitle={emptyConversationCourse?.title ?? null}
			onFillDraft={(text) => appStore.setChatDraft(text)}
		/>
	) : null;

	const chatTitle = selectedCourse?.title
		?? sessionContext?.context.course?.title
		?? (currentSessionId ? t("learn.sidebar.unclassifiedChat") : t("nav.learn.label"));
	const sidebarTitle = selectedCourse?.title
		?? currentSession?.course?.title
		?? t("learn.sidebar.unclassifiedHistory");

	return (
		<div className={`mla-learn${statusOpen ? "" : " mla-learn--status-collapsed"}${mobileNavOpen ? " mla-learn--nav-open" : ""}`}>
			<button
				type="button"
				className="mla-learn-nav-backdrop"
				aria-label={t("learn.sidebar.closeNav")}
				onClick={() => setMobileNavOpen(false)}
			/>

			<aside className="mla-learn-sidebar" aria-label={t("learn.sidebar.aria")}>
				<div className="mla-learn-sidebar-head">
					<IconButton size="sm" aria-label={t("learn.sidebar.backToCourses")} onClick={goHome}>
						<ArrowLeft size={16} aria-hidden="true" />
					</IconButton>
					<h2>{sidebarTitle}</h2>
					{selectedCourse ? (
						<Badge tone={selectedCourse.status === "in_progress" ? "accent" : "neutral"}>
							{t(`course.status.${selectedCourse.status}`)}
						</Badge>
					) : null}
				</div>

				{selectedCourse && selectedCourse.status === "in_progress" ? (
					<Button size="xs" disabled={workbench.creating} onClick={() => startConversation(selectedCourse.course_id)}>
						<Plus size={14} aria-hidden="true" />
						{t("learn.sidebar.newConversation")}
					</Button>
				) : null}

				<div className="mla-course-convos">
					{selectedCourse ? (
						courseConversations.length === 0 ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{t("learn.sidebar.noConversations")}
							</p>
						) : courseConversations.map(renderSessionRow)
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
							aria-expanded={!selectedCourse || showUnclassified}
							onClick={() => setShowUnclassified((value) => !value)}
						>
							{!selectedCourse || showUnclassified
								? <ChevronDown size={14} aria-hidden="true" />
								: <ChevronRight size={14} aria-hidden="true" />}
							<Archive size={14} aria-hidden="true" />
							<span className="mla-course-nav-title">{t("learn.sidebar.unclassifiedHistory")}</span>
							<Badge>{unclassifiedSessions.length}</Badge>
						</button>
						{!selectedCourse || showUnclassified ? (
							<div className="mla-course-convos">{unclassifiedSessions.map(renderSessionRow)}</div>
						) : null}
					</div>
				) : null}

				{/* E4.8f: one entry for the unified archive centre. */}
				{archiveEntryCount > 0 ? (
					<button type="button" className="mla-session-toggle" onClick={openArchive}>
						{t("learn.sidebar.archiveEntry", {
							courses: archivedCourses.length,
							sessions: hiddenSessionCount,
						})}
					</button>
				) : null}
				{sessionActionError ? (
					<p role="alert" className="mla-small" style={{ margin: "8px 0 0", color: "var(--inno-danger)" }}>
						{sessionActionError}
					</p>
				) : null}
			</aside>

			<section className="mla-chat-card" aria-label={t("learn.sidebar.chatAria")}>
				<header className="mla-learn-chat-head">
					<IconButton
						size="sm"
						className="mla-learn-nav-toggle"
						aria-label={t("learn.sidebar.openNav")}
						aria-expanded={mobileNavOpen}
						onClick={() => setMobileNavOpen(true)}
					>
						<BookOpen size={16} aria-hidden="true" />
					</IconButton>
					<div className="mla-learn-chat-title">
						<strong>{chatTitle}</strong>
						{selectedCourse ? (
							<Badge tone={selectedCourse.status === "in_progress" ? "accent" : "neutral"}>
								{t(`course.status.${selectedCourse.status}`)}
							</Badge>
						) : null}
						{currentSession && !currentSession.course
							? <Badge>{t("learn.sidebar.unclassified")}</Badge>
							: null}
					</div>
				</header>
				<CourseContextStrip sessionId={currentSessionId} />
				<LearningWorkspace
					readOnly={blocked ? false : readOnlySession}
					blocked={blocked}
					creating={workbench.creating}
					createError={workbench.error}
					createConversation={() => learnWorkbenchStore.ensureConversation()}
					emptyState={emptyState}
				/>
			</section>

			<LearnContextPanel
				open={statusOpen}
				currentSessionId={currentSessionId}
				learning={learning}
				readOnlySession={readOnlySession}
				canPause={canPause}
				canResume={canResume}
				onToggle={() => {
					setStatusChosenByLearner(true);
					setStatusOpen((value) => !value);
				}}
				onRetry={() => {
					if (currentSessionId) void learningStore.load(currentSessionId);
				}}
				onInit={() => void learningStore.init()}
				onPause={() => void learningStore.pause()}
				onResume={() => void learningStore.resume()}
			/>

			{createDialog}

			{renaming ? (
				<Dialog
					label={t("learn.history.renameDialog.title")}
					className="mla-dialog"
					onClose={() => setRenaming(null)}
				>
					<div className="mla-dialog-body">
						<h2>{t("learn.history.renameDialog.title")}</h2>
						<label className="mla-field">
							<span>{t("learn.history.renameDialog.field")}</span>
							<Input
								value={renaming.name}
								autoFocus
								maxLength={80}
								onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
							/>
						</label>
						<div className="mla-dialog-actions">
							<Button onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
							<Button
								variant="primary"
								disabled={!renaming.name.trim() || busySessionId === renaming.session.id}
								onClick={() => {
									const target = renaming;
									void runSessionAction(target.session.id, async () => {
										await sessionsStore.renameSession(target.session.id, target.name.trim());
									}, t("learn.history.renameFailed")).then(() => setRenaming(null));
								}}
							>
								{t("common.save")}
							</Button>
						</div>
					</div>
				</Dialog>
			) : null}
		</div>
	);
}
