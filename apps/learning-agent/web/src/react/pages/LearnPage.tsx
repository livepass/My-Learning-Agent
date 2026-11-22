import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { appStore } from "../../stores/app-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { learnWorkbenchStore } from "../../stores/learn-workbench-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Badge, Button, Dialog, IconButton, Input } from "../ui/index.js";
import { LearningWorkspace, type LearningBlock, type LearningReadOnlyReason } from "../LearningWorkspace.js";
import { CreateCourseDialog } from "../courses/CreateCourseDialog.js";
import { navigate } from "../shell/navigation.js";
import type { SessionMeta } from "../../api/sessions.js";
import { isDailyVisible } from "../../utils/session-visibility.js";
import { useCourseErrorText } from "../courses/use-course-error-text.js";
import { LearnContextSheet } from "./learn/LearnContextSheet.js";
import { LearnCourseBar, type LearnCourseBarCourse } from "./learn/LearnCourseBar.js";
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
	/** The server's answer for the open conversation (course, task, warnings). */
	const sessionContext = useStoreSnapshot(coursesStore, () => coursesStore.sessionContext(sessionsStore.currentSessionId));

	const [createOpen, setCreateOpen] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [showUnclassified, setShowUnclassified] = useState(false);
	/**
	 * E4.9g-P2-3: whether the learning-context sheet is open.
	 *
	 * This used to be the third grid column's expanded state, defaulting to open
	 * when a real checkpoint existed. An overlay that appears on arrival would
	 * cover the chat the learner came to read, so the sheet always starts closed
	 * and only a click (the course bar's 「学习状态」) opens it.
	 */
	const [contextOpen, setContextOpen] = useState(false);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [busySessionId, setBusySessionId] = useState<string | null>(null);
	const [sessionActionError, setSessionActionError] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<{ session: SessionMeta; name: string } | null>(null);
	/**
	 * E4.9g-P2-2-R2: the conversation whose server context read has finished.
	 * `null` = no read finished for the open conversation yet, so no write may
	 * be offered on a cached binding alone.
	 */
	const [contextSettledFor, setContextSettledFor] = useState<string | null>(null);

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
	//
	// E4.9g-P2-2-R2: once the server has answered for this conversation, its
	// answer (including "unclassified") owns the workbench. A later refresh of
	// the cached list must not re-adopt a stale course, and a cached row that
	// disagrees with the server must not leave the sidebar's course actions
	// pointing at the wrong course.
	useEffect(() => {
		if (!currentSessionId) return;
		if (sessionContext) {
			const serverCourseId = sessionContext.context.unclassified
				? null
				: sessionContext.context.course?.course_id ?? null;
			// `adoptCourse` only rewrites the URL and the in-memory selection; it
			// never writes a binding, and it is a no-op when they already agree.
			if (learnWorkbenchStore.courseId !== serverCourseId) {
				learnWorkbenchStore.adoptCourse(serverCourseId);
			}
			return;
		}
		const meta = sessions.find((session) => session.id === currentSessionId);
		if (!meta) return;
		learnWorkbenchStore.adoptCourse(meta.course?.course_id ?? null);
	}, [currentSessionId, sessions, sessionContext]);

	// Read-only refresh whenever the open session changes. Never initialises.
	useEffect(() => {
		if (!currentSessionId) {
			learningStore.clear();
			return;
		}
		void learningStore.load(currentSessionId);
	}, [currentSessionId]);

	// The course bar reads the server binding. This replaces the read that used
	// to live inside CourseContextStrip; it never writes a binding or a task.
	//
	// E4.9g-P2-2-R2: the page also records when the answer for this conversation
	// has settled. Until then a write stays closed ("confirming"); a settled
	// read that produced no entry (an error the store swallows) falls back to
	// the conversation's own binding by exact `course_id`.
	useEffect(() => {
		if (!currentSessionId) {
			setContextSettledFor(null);
			return;
		}
		if (coursesStore.sessionContext(currentSessionId)) {
			setContextSettledFor(currentSessionId);
			return;
		}
		let live = true;
		void coursesStore.loadSessionContext(currentSessionId).finally(() => {
			if (live) setContextSettledFor(currentSessionId);
		});
		return () => {
			live = false;
		};
	}, [currentSessionId]);

	const checkpoint = learning.state?.checkpoint;
	/**
	 * E4.9g-P2-3: the sheet belongs to one conversation. Switching or closing
	 * it must not leave the previous conversation's panel on screen, so the
	 * sheet closes whenever the open conversation changes (and when the page
	 * leaves conversation mode).
	 */
	useEffect(() => {
		setContextOpen(false);
	}, [currentSessionId]);

	/**
	 * E4.9g-P2-3: a narrow viewport makes the sheet modal (bottom sheet with a
	 * backdrop). CSS owns the presentation; this only tells the shared `Sheet`
	 * which interaction semantics to apply, so `aria-modal`, focus trapping and
	 * the scroll lock match what is actually rendered.
	 */
	const [narrowViewport, setNarrowViewport] = useState(() =>
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia("(max-width: 900px)").matches
			: false);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const query = window.matchMedia("(max-width: 900px)");
		const update = () => setNarrowViewport(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

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

	/**
	 * E4.9g-P2-2-R2 — one authority for the open conversation.
	 *
	 * Before this, three places decided independently:
	 *
	 * - the course bar trusted the server `sessionContext`;
	 * - read-only trusted the cached `currentSession.course`;
	 * - the composer trusted `workbench.courseId` + `selectedCourse`.
	 *
	 * A cached session that still said "bound to an in-progress course" could
	 * therefore keep the composer open after the server had already answered
	 * `unclassified`, or after the bound course had been paused. The three
	 * states below are now derived once, in this order:
	 *
	 * 1. an archived conversation is always read-only;
	 * 2. a server `unclassified` answer is final — it never falls back to a
	 *    cached course;
	 * 3. an archived bound course is read-only;
	 * 4. a paused / completed bound course blocks sending;
	 * 5. before the server context arrives, the conversation's *own* metadata
	 *    binding may supply the course, but only by exact `course_id` against
	 *    the course list. If no status can be confirmed, writes stay closed
	 *    with an explicit "confirming" notice instead of opening on a guess.
	 *
	 * The page's `selectedCourse` never participates: it names the workbench,
	 * not the open conversation.
	 */
	const boundContext = sessionContext?.context;
	const metaCourse = currentSession?.course ?? null;
	const metaListed = metaCourse
		? courseState.courses.find((item) => item.course_id === metaCourse.course_id) ?? null
		: null;
	const conversationCourse: LearnCourseBarCourse | null = boundContext
		? boundContext.course
			? {
				course_id: boundContext.course.course_id,
				title: boundContext.course.title,
				status: boundContext.course.status,
			}
			: null
		: metaCourse
			? {
				course_id: metaCourse.course_id,
				title: metaCourse.title,
				status: metaCourse.archived ? "archived" : metaListed?.status ?? null,
			}
			: null;
	/**
	 * Server-unclassified wins even when the cached session still claims a
	 * binding. Without a server answer, "the cached session has no course" is
	 * the same unclassified history the server would report.
	 */
	const conversationUnclassified = boundContext
		? boundContext.unclassified === true
		: Boolean(currentSession && !metaCourse);
	/**
	 * The status the write permission may act on. `null` means neither the
	 * server nor an exact course-list match has confirmed one — writes stay
	 * closed.
	 *
	 * The conversation's own cached binding is only consulted once its context
	 * read has *settled* (a failed read included), and only when it names the
	 * course the workbench has already adopted. Before that the page is either
	 * still asking or mid-switch, and both are windows where a write must not be
	 * offered on a guess.
	 */
	const contextSettled = Boolean(currentSessionId) && contextSettledFor === currentSessionId;
	const metaConfirmed = Boolean(metaCourse && metaListed && courseId === metaCourse.course_id);
	const authorityStatus = conversationUnclassified
		? null
		: sessionContext
			? conversationCourse?.status ?? null
			: contextSettled && metaConfirmed
				? metaListed?.status ?? null
				: null;

	/**
	 * "Archived" is fail-closed: if the server *or* the conversation's own
	 * cached binding says the course is archived, the conversation is read-only.
	 * This only ever removes write access, never grants it, so it cannot
	 * contradict the server-priority rule above — and it is what keeps an
	 * archived course's history from becoming editable when one of the two
	 * reads is stale.
	 */
	const courseArchived = conversationCourse?.status === "archived" || metaCourse?.archived === true;
	const readOnlySession: LearningReadOnlyReason | false = currentSession?.archived === true
		? "session"
		: conversationUnclassified
			? "unclassified"
			: courseArchived
				? "course"
				: false;

	/**
	 * Why the open conversation cannot accept a write. Read-only outranks it:
	 * when `readOnlySession` is set the workspace shows the read-only notice and
	 * this stays null, so a lower-priority block can never re-open the composer.
	 */
	const conversationBlock: LearningBlock | null = (() => {
		if (!conversationMode || readOnlySession) return null;
		if (!conversationCourse || !authorityStatus) {
			// A failed course-list read is not "still loading": say so, and let the
			// learner retry instead of waiting on a notice that never clears.
			if (courseState.error) {
				return {
					title: t("learn.blocked.error.title"),
					description: `${t("learn.blocked.error.description")}${courseState.error}`,
					actionLabel: t("learn.blocked.error.retry"),
					onAction: () => void coursesStore.loadCourses(),
				};
			}
			// Nothing confirmed yet: wait for the server answer instead of opening
			// the composer under the course the page showed before.
			return {
				title: t("learn.blocked.confirming.title"),
				description: t("learn.blocked.confirming.description"),
			};
		}
		if (authorityStatus === "paused") {
			return {
				title: t("learn.blocked.paused.title"),
				description: t("learn.blocked.paused.description"),
				actionLabel: courseState.pendingAction === "resume_course"
					? undefined
					: t("learn.blocked.paused.action"),
				onAction: () => void coursesStore.resumeCourse(conversationCourse.course_id),
			};
		}
		if (authorityStatus === "completed") {
			return {
				title: t("learn.blocked.completed.title"),
				description: t("learn.blocked.completed.description"),
			};
		}
		return null;
	})();
	/** Every checkpoint write obeys the same authority as the composer. */
	const canInitialize = !readOnlySession && !conversationBlock;
	const canPause = checkpoint?.status === "active" && !learning.isSaving && canInitialize;
	const canResume = checkpoint?.status === "paused" && !learning.isSaving && canInitialize;

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
		// A conversation is governed by its own binding, never by the workbench's
		// selected course. Returning here first also means a course-list failure
		// cannot replace the read-only notice of an unclassified / archived
		// conversation with a "list failed" block.
		if (conversationMode) return conversationBlock;
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

	/**
	 * E4.9g-P2-3: the course bar's 「学习状态」 button opens and closes the sheet.
	 * Opening closes the mobile history drawer first, so two overlays can never
	 * be stacked on the same screen.
	 */
	const toggleStatus = () => {
		setMobileNavOpen(false);
		setContextOpen((value) => !value);
	};
	const closeContext = () => setContextOpen(false);

	/** Course plan entry; the course bar is not a completion control. */
	const openCoursePlan = (courseId: string) => {
		navigate("course", { history: "push", course: { id: courseId, view: "plan" } });
	};

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
	 * The bar names the same course the permission rules use (`conversationCourse`
	 * above). Keeping one derivation is the point of R2: the bar must never show
	 * a course the composer is not actually allowed to write into.
	 */
	const barCourse = conversationCourse;
	const barUnclassified = conversationUnclassified;
	const barTask = boundContext?.task ?? null;
	const barStageTitle = sessionContext?.stageTitle ?? null;
	const barWarnings = sessionContext?.warnings ?? [];
	/**
	 * E4.9g-P2-2-R2: the sidebar header names the conversation's own course too.
	 * It used to fall back to the cached session meta, so a conversation the
	 * server had already answered as unclassified still showed the stale course
	 * name above an empty list.
	 */
	const sidebarTitle = conversationUnclassified
		? t("learn.sidebar.unclassifiedHistory")
		: conversationCourse?.title
			?? selectedCourse?.title
			?? t("learn.sidebar.unclassifiedHistory");

	/**
	 * E4.8f — an empty conversation is not a blank page.
	 *
	 * The hint names the course the conversation is actually bound to, never the
	 * course that happened to be selected before the switch; the starters only
	 * fill the composer. Nothing here claims progress or a review plan.
	 */
	const emptyState = !blocked && !readOnlySession ? (
		<LearnStartPanel
			mode="empty"
			courseTitle={barCourse?.title ?? null}
			onFillDraft={(text) => appStore.setChatDraft(text)}
		/>
	) : null;

	return (
		<div className={`mla-learn${mobileNavOpen ? " mla-learn--nav-open" : ""}`}>
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
					{/*
					 * E4.9g-P2-2-R2: the badge names the conversation's own course
					 * status. Reading `selectedCourse` here showed "in progress" above
					 * a conversation the server had already paused.
					 */}
					{conversationCourse?.status ? (
						<Badge tone={conversationCourse.status === "in_progress" ? "accent" : "neutral"}>
							{t(`course.status.${conversationCourse.status}`)}
						</Badge>
					) : null}
				</div>

				{/*
				 * E4.9g-P2-2-R2: starting a conversation is a write inside a course,
				 * so it follows the same authority as the composer. Reading
				 * `selectedCourse` here offered "new conversation" for a course the
				 * server had already paused / completed, or before the binding was
				 * confirmed at all.
				 */}
				{conversationCourse && authorityStatus === "in_progress" && !readOnlySession && !conversationBlock ? (
					<Button size="xs" disabled={workbench.creating} onClick={() => startConversation(conversationCourse.course_id)}>
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
				<LearnCourseBar
					course={barCourse}
					courses={activeCourses}
					task={barTask}
					stageTitle={barStageTitle}
					warnings={barWarnings}
					contextReady={Boolean(sessionContext)}
					unclassified={barUnclassified}
					canStartNew={Boolean(conversationCourse)
						&& authorityStatus === "in_progress"
						&& !readOnlySession
						&& !conversationBlock}
					creating={workbench.creating}
					statusOpen={contextOpen}
					navOpen={mobileNavOpen}
					onOpenNav={() => {
						// E4.9g-P2-3: the history drawer and the context sheet are
						// mutually exclusive overlays.
						setContextOpen(false);
						setMobileNavOpen(true);
					}}
					onSelectCourse={chooseCourse}
					onNewConversation={() => {
						if (barCourse) startConversation(barCourse.course_id);
					}}
					onToggleStatus={toggleStatus}
					onOpenPlan={() => {
						if (barCourse) openCoursePlan(barCourse.course_id);
					}}
				/>
				<LearningWorkspace
					/*
					 * E4.9g-P2-2-R2: read-only is never masked by a block. The
					 * conversation block is already null whenever `readOnlySession`
					 * is set, so the old `blocked ? false : readOnlySession` only
					 * served to hide a higher-priority read-only state behind a
					 * course notice — and with it, the edit controls.
					 */
					readOnly={readOnlySession}
					blocked={blocked}
					creating={workbench.creating}
					createError={workbench.error}
					createConversation={() => learnWorkbenchStore.ensureConversation()}
					emptyState={emptyState}
				/>
			</section>

			{/*
			 * E4.9g-P2-3: the sheet lives inside the chat card, so it overlays the
			 * chat instead of taking a column. It is rendered only while open, so
			 * its buttons leave the Tab order the moment it closes.
			 */}
			<LearnContextSheet
				open={contextOpen}
				modal={narrowViewport}
				currentSessionId={currentSessionId}
				course={conversationCourse}
				taskTitle={barTask?.title ?? null}
				stageTitle={barStageTitle}
				unclassified={conversationUnclassified}
				learning={learning}
				readOnlySession={readOnlySession}
				canInitialize={canInitialize}
				canPause={canPause}
				canResume={canResume}
				onClose={closeContext}
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
