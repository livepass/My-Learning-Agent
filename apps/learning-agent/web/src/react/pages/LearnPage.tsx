import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Archive, ArrowLeft, BookOpen, ChevronDown, ChevronRight, FolderOpen, Lightbulb, Loader2,
	MoreHorizontal, PanelRightClose, PanelRightOpen, Pause, PencilLine, Play, Plus, Repeat, RotateCcw, Trash2,
	type LucideIcon,
} from "lucide-react";
import { appStore } from "../../stores/app-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore } from "../../stores/courses-store.js";
import { learnWorkbenchStore } from "../../stores/learn-workbench-store.js";
import { useStoreSnapshot } from "../hooks.js";
import {
	Button, Dialog, DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuSeparator,
	DropdownMenuTrigger, IconButton, Input,
} from "../ui/index.js";
import { LearningWorkspace, type LearningBlock, type LearningReadOnlyReason } from "../LearningWorkspace.js";
import { CourseContextStrip } from "../courses/CourseContextStrip.js";
import { CreateCourseDialog } from "../courses/CreateCourseDialog.js";
import { navigate } from "../shell/navigation.js";
import type {
	LearningCheckpointStatus,
	LearningCheckpointStep,
	LearningRecoveryAction,
	LearningState,
} from "../../api/learning.js";
import type { SessionMeta } from "../../api/sessions.js";
import { isDailyVisible } from "../../utils/session-visibility.js";

/** Plain-language step labels; never imply a score exists. */
const STEP_LABEL_KEY: Record<LearningCheckpointStep, string> = {
	conversation: "learn.status.step.conversation",
	awaiting_answer: "learn.status.step.awaitingAnswer",
	feedback: "learn.status.step.feedback",
};

const STATUS_LABEL_KEY: Record<LearningCheckpointStatus, string> = {
	active: "learn.status.checkpoint.active",
	paused: "learn.status.checkpoint.paused",
	completed: "learn.status.checkpoint.completed",
};

/**
 * Every recovery action is phrased as "not yet executed": scoring, evidence and
 * profile projection belong to a later package, so the UI must not claim them.
 */
const ACTION_LABEL_KEY: Record<LearningRecoveryAction, string> = {
	evaluate: "learn.status.action.evaluate",
	wait_for_running_evaluation: "learn.status.action.waitForRunningEvaluation",
	await_manual_retry: "learn.status.action.awaitManualRetry",
	mark_retry_limit: "learn.status.action.markRetryLimit",
	publish_saved_evidence: "learn.status.action.publishSavedEvidence",
	project_saved_evidence: "learn.status.action.projectSavedEvidence",
	advance_checkpoint: "learn.status.action.advanceCheckpoint",
	return_saved_result: "learn.status.action.returnSavedResult",
};

/**
 * E4.8b — quick starts on the course welcome screen.
 *
 * Each one only fills the composer with a complete, sendable sentence: the
 * learner stays in control of the first turn, and a conversation is still
 * created exclusively by the first send (`learning/start`), never by a click
 * on this screen.
 */
/**
 * E4.8f — three quick starts on the selected-course home.
 *
 * The list is deliberately short (讲解 / 练习 / 复习). It only fills the
 * composer: no message is sent, no conversation is created, and nothing here
 * claims progress, a review schedule or a mastery estimate the server did not
 * record.
 */
const QUICK_ACTIONS: Array<{
	id: string;
	labelKey: string;
	icon: LucideIcon;
	promptKey: string;
}> = [
	{
		id: "explain",
		labelKey: "learn.quick.explain.label",
		icon: Lightbulb,
		promptKey: "learn.quick.explain.prompt",
	},
	{
		id: "practice",
		labelKey: "learn.quick.practice.label",
		icon: PencilLine,
		promptKey: "learn.quick.practice.prompt",
	},
	{
		id: "review",
		labelKey: "learn.quick.review.label",
		icon: Repeat,
		promptKey: "learn.quick.review.prompt",
	},
];

/** Starter questions for an empty conversation; they only fill the composer. */
const STARTER_PROMPTS: Array<{ id: string; labelKey: string; promptKey: string }> = [
	{ id: "overview", labelKey: "learn.empty.start.overview.label", promptKey: "learn.empty.start.overview.prompt" },
	{ id: "example", labelKey: "learn.empty.start.example.label", promptKey: "learn.empty.start.example.prompt" },
	{ id: "check", labelKey: "learn.empty.start.check.label", promptKey: "learn.empty.start.check.prompt" },
];

/**
 * E4.8f — a checkpoint that is worth showing.
 *
 * `learning/start` writes a placeholder record at `step: "conversation"` with
 * no questions the moment a conversation is created. That is not learning
 * progress, so the status panel starts collapsed for it; a real step, a question
 * or a saved attempt opens it. Nothing here invents progress — it only decides
 * whether the panel has something to show.
 */
function hasRealCheckpoint(state: LearningState): boolean {
	if (!state.exists || !state.checkpoint) return false;
	const checkpoint = state.checkpoint;
	const hasQuestions = (state.questions?.length ?? 0) > 0;
	const hasAttempts = (state.attempts?.length ?? 0) > 0;
	return checkpoint.step !== "conversation"
		|| hasQuestions
		|| hasAttempts
		|| checkpoint.status !== "active"
		|| checkpoint.revision > 1;
}

function shortDate(time: string, locale: string): string | null {
	const parsed = Date.parse(time);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed).toLocaleDateString(locale, { month: "long", day: "numeric" });
}

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
	const { t, i18n } = useTranslation();
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
	const question = useMemo(() => {
		const ref = checkpoint?.question;
		if (!ref) return undefined;
		return learning.state?.questions?.find(
			(item) => item.question_id === ref.question_id && item.question_version === ref.question_version,
		);
	}, [checkpoint, learning.state]);

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

	/** One conversation row: select, plus a menu for rename / archive / delete. */
	const conversationRow = (session: SessionMeta) => {
		const name = session.name || t("learn.history.unnamed");
		const busy = Boolean(openingSessionId) || busySessionId === session.id;
		const isFree = !session.course?.task_id;
		return (
			<div className="mla-session-row" key={session.id}>
				<button
					type="button"
					className="mla-session-item"
					aria-current={session.id === currentSessionId ? "true" : undefined}
					disabled={busy}
					onClick={() => openConversation(session)}
				>
					<span className="mla-session-item-head">
						<strong>{name}</strong>
						{session.archived ? <span className="mla-badge">{t("learn.history.archived")}</span> : null}
					</span>
					<span className="mla-session-item-preview">
						{session.preview || (session.messageCount > 0
							? t("learn.history.messageCount", { count: session.messageCount })
							: t("learn.history.noMessages"))}
					</span>
					<span className="mla-session-item-meta">
						{isFree ? t("learn.history.free") : t("learn.history.courseTask")}
						{!session.course && unclassifiedSessions.some((row) => row.id === session.id)
							? t("learn.history.unclassifiedSuffix")
							: ""}
					</span>
				</button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="mla-session-more"
							aria-label={t("learn.history.actions", { name })}
							disabled={busy}
						>
							{busySessionId === session.id
								? <Loader2 size={16} className="mla-spin" aria-hidden="true" />
								: <MoreHorizontal size={16} aria-hidden="true" />}
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="mla-session-menu">
						<DropdownMenuActionItem
							icon={<BookOpen size={14} />}
							label={t("learn.history.rename")}
							onSelect={() => setRenaming({ session, name })}
						/>
						<DropdownMenuActionItem
							icon={<Archive size={14} />}
							label={t("learn.history.archive.label")}
							onSelect={() => void archiveOne(session.id)}
						/>
						<DropdownMenuSeparator />
						<DropdownMenuActionItem
							variant="danger"
							icon={<Trash2 size={14} />}
							label={t("learn.history.delete.label")}
							onSelect={() => void removeSession(session.id, name)}
						/>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	};

	/** One course card on the welcome home. Selecting never starts a chat. */
	const coursePickCard = (course: (typeof courseState.courses)[number]) => {
		const lastStudied = sessions.reduce<string | null>((latest, session) => {
			if (session.course?.course_id !== course.course_id || !isDailyVisible(session)) return latest;
			const parsed = Date.parse(session.updatedAt);
			if (!Number.isFinite(parsed)) return latest;
			if (!latest || parsed > Date.parse(latest)) return session.updatedAt;
			return latest;
		}, null);
		const last = lastStudied ? shortDate(lastStudied, i18n.language) : null;
		return (
			<button
				type="button"
				className="mla-course-pick"
				key={course.course_id}
				aria-label={t("learn.welcome.selectCourse", { title: course.title })}
				onClick={() => chooseCourse(course.course_id)}
			>
				<span className="mla-course-pick-title">
					<BookOpen size={16} aria-hidden="true" />
					<strong>{course.title}</strong>
				</span>
				<span className="mla-course-pick-meta">
					<span className={`mla-badge${course.status === "in_progress" ? " mla-badge--accent" : ""}`}>
						{t(`course.status.${course.status}`)}
					</span>
					<span>{t("learn.welcome.conversationCount", { count: course.counts.sessions })}</span>
					{last ? <span>{t("learn.welcome.lastStudied", { date: last })}</span> : null}
				</span>
				<span className="mla-course-pick-hint">
					{course.status === "paused"
						? t("learn.welcome.hint.paused")
						: course.status === "completed"
							? t("learn.welcome.hint.completed")
							: t("learn.welcome.hint.active")}
				</span>
			</button>
		);
	};

	const loadingCourses = courseState.loading && courseState.courses.length === 0;
	const composerActive = welcomeCourse?.status === "in_progress";

	const coursePicker = (
		<div className="mla-welcome-courses">
			{loadingCourses ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					{t("learn.welcome.loadingCourses")}
				</p>
			) : null}
			{!loadingCourses && courseState.error ? (
				<div className="mla-welcome-error">
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
						{t("learn.welcome.courseError", { message: courseState.error })}
					</p>
					<Button size="xs" onClick={() => void coursesStore.loadCourses()}>
						<RotateCcw size={14} aria-hidden="true" />
						{t("learn.welcome.retry")}
					</Button>
				</div>
			) : null}
			{!loadingCourses ? (
				<div className="mla-course-picker">
					{activeCourses.map(coursePickCard)}
					<button
						type="button"
						className="mla-course-pick mla-course-pick--create"
						onClick={() => setCreateOpen(true)}
					>
						<span className="mla-course-pick-title">
							<Plus size={16} aria-hidden="true" />
							<strong>{t("learn.welcome.createCourse")}</strong>
						</span>
						<span className="mla-course-pick-hint">{t("learn.welcome.createCourseHint")}</span>
					</button>
				</div>
			) : null}
			{!loadingCourses && !courseState.error && activeCourses.length === 0 ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{archivedCourses.length > 0
						? t("learn.welcome.emptyAllArchived")
						: t("learn.welcome.emptyNoCourses")}
				</p>
			) : null}
		</div>
	);

	/**
	 * E4.8f: one archive entry, not two. Both archived courses and archived
	 * sessions live in the same settings page, so separate buttons pointed at
	 * the same destination and only made the footer look like a menu.
	 */
	const archiveEntryCount = archivedCourses.length + hiddenSessionCount;
	const welcomeFooter = (
		<footer className="mla-welcome-footer">
			{welcomeCourse ? (
				<Button variant="ghost" size="xs" onClick={goHome}>
					<ArrowLeft size={14} aria-hidden="true" />
					{t("learn.welcome.switchCourse")}
				</Button>
			) : null}
			{unclassifiedSessions.length > 0 ? (
				<Button
					variant="ghost"
					size="xs"
					aria-expanded={showUnclassified}
					onClick={() => setShowUnclassified((value) => !value)}
				>
					<Archive size={14} aria-hidden="true" />
					{t("learn.welcome.unclassifiedHistory", { count: unclassifiedSessions.length })}
				</Button>
			) : null}
			{archiveEntryCount > 0 ? (
				<Button variant="ghost" size="xs" onClick={openArchive}>
					<FolderOpen size={14} aria-hidden="true" />
					{t("learn.welcome.viewArchive")}
				</Button>
			) : null}
		</footer>
	);

	const welcomeContent = (
		<div className="mla-welcome">
			<header className="mla-welcome-hero">
				<h1>
					{welcomeCourse
						? t("learn.welcome.titleWithCourse", { title: welcomeCourse.title })
						: t("learn.welcome.title")}
				</h1>
				{welcomeCourse ? (
					// E4.8f: name the course and its status under the greeting, so the
					// learner sees which course the composer belongs to.
					<p className="mla-welcome-course-meta">
						<span>{welcomeCourse.title}</span>
						<span className={`mla-badge${welcomeCourse.status === "in_progress" ? " mla-badge--accent" : ""}`}>
							{t(`course.status.${welcomeCourse.status}`)}
						</span>
						<span>{t("learn.welcome.chooseStart")}</span>
					</p>
				) : (
					<p>{t("learn.welcome.selectFirst")}</p>
				)}
			</header>

			{welcomeCourse ? (
				<>
					{composerActive ? (
						<div className="mla-quick-grid" role="group" aria-label={t("learn.quick.group")}>
							{QUICK_ACTIONS.map((action) => {
								const Icon = action.icon;
								return (
									<button
										type="button"
										className="mla-quick-card"
										key={action.id}
										onClick={() => appStore.setChatDraft(
											t(action.promptKey, { title: welcomeCourse.title }),
										)}
									>
										<Icon size={18} aria-hidden="true" />
										<span>{t(action.labelKey)}</span>
									</button>
								);
							})}
						</div>
					) : null}
					{courseConversations.length > 0 ? (
						<div className="mla-welcome-history">
							<Button
								variant="ghost"
								size="xs"
								aria-expanded={showHistory}
								onClick={() => setShowHistory((value) => !value)}
							>
								{showHistory
									? <ChevronDown size={14} aria-hidden="true" />
									: <ChevronRight size={14} aria-hidden="true" />}
								{t("learn.welcome.continuePrevious", { count: courseConversations.length })}
							</Button>
							{showHistory ? (
								<div className="mla-welcome-history-list">{courseConversations.map(conversationRow)}</div>
							) : null}
						</div>
					) : null}
				</>
			) : (
				coursePicker
			)}

			{welcomeFooter}

			{showUnclassified ? (
				<div className="mla-welcome-history-list">{unclassifiedSessions.map(conversationRow)}</div>
			) : null}
		</div>
	);

	const createDialog = (
		<CreateCourseDialog
			open={createOpen}
			pending={courseState.pendingAction === "create_course"}
			error={courseState.error}
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
		<div className="mla-empty-starters">
			<div className="mla-empty-starters-head">
				<strong>
					{emptyConversationCourse
						? t("learn.empty.titleWithCourse", { title: emptyConversationCourse.title })
						: t("learn.empty.title")}
				</strong>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{emptyConversationCourse
						? t("learn.empty.descriptionWithCourse")
						: t("learn.empty.description")}
				</p>
			</div>
			<div className="mla-empty-starter-list" role="group" aria-label={t("learn.empty.group")}>
				{STARTER_PROMPTS.map((starter) => (
					<button
						type="button"
						key={starter.id}
						className="mla-empty-starter"
						onClick={() => appStore.setChatDraft(
							t(starter.promptKey, {
								title: emptyConversationCourse?.title ?? t("learn.empty.thisCourse"),
							}),
						)}
					>
						{t(starter.labelKey)}
					</button>
				))}
			</div>
		</div>
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
						<span className={`mla-badge${selectedCourse.status === "in_progress" ? " mla-badge--accent" : ""}`}>
							{t(`course.status.${selectedCourse.status}`)}
						</span>
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
						) : courseConversations.map(conversationRow)
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
							<span className="mla-badge">{unclassifiedSessions.length}</span>
						</button>
						{!selectedCourse || showUnclassified ? (
							<div className="mla-course-convos">{unclassifiedSessions.map(conversationRow)}</div>
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
							<span className={`mla-badge${selectedCourse.status === "in_progress" ? " mla-badge--accent" : ""}`}>
								{t(`course.status.${selectedCourse.status}`)}
							</span>
						) : null}
						{currentSession && !currentSession.course
							? <span className="mla-badge">{t("learn.sidebar.unclassified")}</span>
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

			<aside
				className={`mla-learn-status${statusOpen ? "" : " mla-learn-status--collapsed"}`}
				aria-label={t("learn.status.aria")}
			>
				<IconButton
					size="sm"
					className="mla-learn-status-toggle"
					aria-expanded={statusOpen}
					aria-label={statusOpen ? t("learn.status.collapse") : t("learn.status.expand")}
					onClick={() => {
						setStatusChosenByLearner(true);
						setStatusOpen((value) => !value);
					}}
				>
					{statusOpen ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
				</IconButton>
				{statusOpen ? (
					<section className="mla-card" aria-labelledby="learn-checkpoint">
						<div className="mla-card-header">
							<h2 id="learn-checkpoint">{t("learn.status.title")}</h2>
							{checkpoint ? (
								<span className={`mla-badge ${checkpoint.status === "active" ? "mla-badge--accent" : ""}`}>
									{t(STATUS_LABEL_KEY[checkpoint.status])}
								</span>
							) : null}
						</div>

						{!currentSessionId ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{t("learn.status.noSession")}
							</p>
						) : learning.isLoading ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								{t("learn.status.loading")}
							</p>
						) : learning.error ? (
							<div>
								<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{learning.error}</p>
								<Button
									className="mla-inline"
									style={{ marginTop: 8 }}
									onClick={() => void learningStore.load(currentSessionId)}
								>
									<RotateCcw size={14} />
									{t("learn.status.retry")}
								</Button>
							</div>
						) : !learning.state?.exists ? (
							<div className="mla-stack" style={{ gap: 10 }}>
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									{readOnlySession
										? t("learn.status.noCheckpointReadOnly")
										: t("learn.status.noCheckpoint")}
								</p>
								{readOnlySession ? null : (
									<Button
										variant="primary"
										disabled={learning.isSaving}
										onClick={() => void learningStore.init()}
									>
										{t("learn.status.initialize")}
									</Button>
								)}
							</div>
						) : checkpoint ? (
							<div className="mla-stack" style={{ gap: 12 }}>
								<dl className="mla-definition">
									<div>
										<dt>{t("learn.status.stepLabel")}</dt>
										<dd>{t(STEP_LABEL_KEY[checkpoint.step])}</dd>
									</div>
									<div>
										<dt>{t("learn.status.revision")}</dt>
										<dd>#{checkpoint.revision}</dd>
									</div>
								</dl>

								{question ? (
									<div>
										<span className="mla-overline">{t("learn.status.currentQuestion")}</span>
										<p className="mla-text" style={{ margin: "6px 0 0" }}>{question.prompt}</p>
										<span className="mla-small mla-muted">
											{t("learn.status.questionMeta", {
												id: question.question_id,
												version: question.question_version,
											})}
										</span>
									</div>
								) : (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{t("learn.status.noQuestion")}
									</p>
								)}

								{learning.state.pending_action ? (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{t(ACTION_LABEL_KEY[learning.state.pending_action])}
									</p>
								) : null}

								<div className="mla-inline">
									{canPause ? (
										<Button disabled={learning.isSaving} onClick={() => void learningStore.pause()}>
											<Pause size={14} />
											{t("learn.status.pause")}
										</Button>
									) : null}
									{canResume ? (
										<Button variant="primary" disabled={learning.isSaving} onClick={() => void learningStore.resume()}>
											<Play size={14} />
											{t("learn.status.resume")}
										</Button>
									) : null}
									{checkpoint.status === "completed" ? (
										<span className="mla-small mla-muted">{t("learn.status.completedLocked")}</span>
									) : null}
								</div>
							</div>
						) : null}
					</section>
				) : null}
			</aside>

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
