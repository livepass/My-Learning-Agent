import { useEffect, useMemo, useState } from "react";
import {
	Archive, BookOpen, ChevronDown, ChevronRight, FolderOpen, Loader2, MoreHorizontal, PanelRightClose,
	PanelRightOpen, Pause, Play, Plus, RotateCcw, Trash2,
} from "lucide-react";
import { learningStore } from "../../stores/learning-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { coursesStore, courseStatusLabel } from "../../stores/courses-store.js";
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
import type { LearningCheckpointStatus, LearningCheckpointStep, LearningRecoveryAction } from "../../api/learning.js";
import type { SessionMeta } from "../../api/sessions.js";
import { isDailyVisible } from "../../utils/session-visibility.js";

/** Plain-language step labels; never imply a score exists. */
const STEP_LABEL: Record<LearningCheckpointStep, string> = {
	conversation: "对话中",
	awaiting_answer: "等待作答",
	feedback: "反馈中",
};

const STATUS_LABEL: Record<LearningCheckpointStatus, string> = {
	active: "进行中",
	paused: "已暂停",
	completed: "已完成",
};

/**
 * Every recovery action is phrased as "not yet executed": scoring, evidence and
 * profile projection belong to a later package, so the UI must not claim them.
 */
const ACTION_LABEL: Record<LearningRecoveryAction, string> = {
	evaluate: "已保存作答，等待评分",
	wait_for_running_evaluation: "评分正在进行",
	await_manual_retry: "评分失败，可以重试",
	mark_retry_limit: "已达评分重试上限",
	publish_saved_evidence: "已评分，等待写入学习证据",
	project_saved_evidence: "证据已记录，等待更新学习画像",
	advance_checkpoint: "检查点可以继续推进",
	return_saved_result: "本次作答已保存，可继续下一题",
};

function conversationName(session: SessionMeta): string {
	return session.name || "未命名对话";
}

/**
 * E4.8 — AI learning workbench: 课程 → 多个学习对话.
 *
 * The page is a three-part layout: a course/conversation sidebar, the chat, and
 * a collapsible learning-status panel. Every conversation shown here belongs to
 * a course *by server binding* (`session.course`); selecting a course never
 * creates a session, and the first message creates one through
 * `learning/start`, so a Web learning conversation can never exist without a
 * course. Legacy unclassified conversations stay reachable under 「未归类历史」
 * and are never rebound to whichever course happens to be selected.
 */
export function LearnPage() {
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
	const [expandedCourseId, setExpandedCourseId] = useState<string | null>(null);
	const [showUnclassified, setShowUnclassified] = useState(false);
	const [statusOpen, setStatusOpen] = useState(true);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [busySessionId, setBusySessionId] = useState<string | null>(null);
	const [sessionActionError, setSessionActionError] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<{ session: SessionMeta; name: string } | null>(null);

	const { currentSessionId, sessions, openingSessionId } = sessionState;
	const courseId = workbench.courseId;

	useEffect(() => {
		void sessionsStore.load();
	}, []);

	useEffect(() => {
		if (coursesStore.courses.length > 0 || coursesStore.coursesLoading) return;
		void coursesStore.loadCourses();
	}, []);

	// The URL is the source of truth: refresh, direct links and Back/Forward all
	// restore the course, and a URL without `?session=` shows the empty
	// workbench instead of silently reopening the previous conversation.
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

	// Keep the expanded course in step with the selection.
	useEffect(() => {
		if (courseId) setExpandedCourseId(courseId);
	}, [courseId]);

	// Read-only refresh whenever the open session changes. Never initialises.
	useEffect(() => {
		if (!currentSessionId) {
			learningStore.clear();
			return;
		}
		void learningStore.load(currentSessionId);
	}, [currentSessionId]);

	const checkpoint = learning.state?.checkpoint;
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

	/**
	 * Why the composer is unavailable. Loading and read failures are their own
	 * states: "no courses" must never be painted while the list is unknown.
	 */
	const blocked: LearningBlock | null = (() => {
		// A list that has not loaded (or failed to) is not "no courses": both must
		// keep the composer closed instead of offering a chat with no course.
		if (courseState.loading && courseState.courses.length === 0) {
			return {
				title: "正在加载课程…",
				description: "课程列表读取完成前不能开始新的学习对话。",
			};
		}
		if (courseState.error) {
			return {
				title: "课程列表读取失败",
				description: `暂时无法确认你有哪些课程，因此不能开始新的学习对话。${courseState.error}`,
				actionLabel: "重试",
				onAction: () => void coursesStore.loadCourses(),
			};
		}
		if (activeCourses.length === 0) {
			return archivedCourses.length > 0
				? {
					title: "课程都在归档中",
					description: "归档的课程不会出现在日常学习。可以先创建一门新课程，或到归档中心恢复原有课程。",
					actionLabel: "查看归档课程",
					onAction: () => navigate("settings", { history: "push", settingsTab: "archived-courses" }),
				}
				: {
					title: "还没有课程",
					description: "所有 AI 学习对话都属于一门课程。先创建第一门课程，再开始学习。",
					actionLabel: "创建课程",
					onAction: () => setCreateOpen(true),
				};
		}
		if (!courseId) {
			// An open unclassified conversation is history: it stays readable, and
			// asking for a course here would hide the conversation's own state.
			if (currentSessionId) return null;
			return {
				title: "先选择一门课程",
				description: "在左侧选择课程后就能开始新的学习对话；这里的每个对话都会归属到该课程。",
			};
		}
		if (!selectedCourse) {
			return {
				title: "课程不可用",
				description: "URL 中的课程不存在或已被删除。请在左侧重新选择一门课程。",
				actionLabel: "选择课程",
				onAction: () => learnWorkbenchStore.selectCourse(null),
			};
		}
		if (selectedCourse.status === "archived") {
			return {
				title: "课程已归档",
				description: "归档课程的历史可以查看，但不能开始新的学习。请先到归档中心恢复课程。",
				actionLabel: "查看归档课程",
				onAction: () => navigate("settings", { history: "push", settingsTab: "archived-courses" }),
			};
		}
		if (selectedCourse.status === "paused") {
			return {
				title: "课程已暂停",
				description: "暂停的课程不会出现在今日学习。继续课程后即可开始新的学习对话。",
				actionLabel: courseState.pendingAction === "resume_course" ? undefined : "继续课程",
				onAction: () => void coursesStore.resumeCourse(selectedCourse.course_id),
			};
		}
		if (selectedCourse.status === "completed") {
			return {
				title: "课程已完成",
				description: "已完成课程只展示历史记录。如需继续学习，请先在课程设置中调整课程状态。",
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
			const message = err instanceof Error ? err.message : `${failure}，请重试。`;
			setSessionActionError((err as { partial?: boolean } | undefined)?.partial === true
				? message
				: err instanceof Error ? `${failure}：${message}` : message);
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
					? "当前会话还有正在生成的回复，请先停止后再归档。"
					: err instanceof Error ? err.message : "网络错误");
			}
		}, "归档失败");

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
			`删除会话「${name}」？`,
			"",
			"删除后，该会话的聊天内容、题目、作答、评分和学习检查点将无法恢复。",
			"",
			"已经写入长期学习档案的学习证据和掌握状态不会自动删除或回滚。",
			"",
			"因此，原始作答可能无法再回查。这不等同于彻底清除个人学习数据。",
			...(isCurrent
				? [hasOtherVisible
					? "这是当前打开的会话；删除后会自动切换到另一个已有会话。"
					: "这是当前唯一的会话。删除后会立即新建一个空白对话并进入其中。"]
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
					throw new Error("这是当前唯一的会话，已保留。请重试并在确认框中选择新建空白对话。");
				}
				if (data?.error === "replacement_create_failed") {
					throw new Error("无法新建空白会话，当前会话与消息已保留，请重试。");
				}
				if (data?.error === "replacement_unavailable") {
					throw new Error("准备切换到的会话已不可用，当前会话已保留，请重试。");
				}
				if (data?.error === "session_deleting") {
					throw new Error("该会话正在删除中，请稍后刷新列表。");
				}
				throw err;
			}
		}, "删除失败");
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
		setExpandedCourseId(targetCourseId);
		setMobileNavOpen(false);
	};

	/** One conversation row: select, plus a menu for rename / archive / delete. */
	const conversationRow = (session: SessionMeta) => {
		const name = conversationName(session);
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
						{session.archived ? <span className="mla-badge">已归档</span> : null}
					</span>
					<span className="mla-session-item-preview">
						{session.preview || (session.messageCount > 0 ? `${session.messageCount} 条消息` : "暂无消息")}
					</span>
					<span className="mla-session-item-meta">
						{isFree ? "自由学习" : "课程任务"}
						{!session.course && unclassifiedSessions.some((row) => row.id === session.id) ? " · 未归类" : ""}
					</span>
				</button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="mla-session-more"
							aria-label={`会话操作：${name}`}
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
							label="重命名"
							onSelect={() => setRenaming({ session, name })}
						/>
						<DropdownMenuActionItem
							icon={<Archive size={14} />}
							label="归档会话"
							onSelect={() => void archiveOne(session.id)}
						/>
						<DropdownMenuSeparator />
						<DropdownMenuActionItem
							variant="danger"
							icon={<Trash2 size={14} />}
							label="永久删除"
							onSelect={() => void removeSession(session.id, name)}
						/>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	};

	const courseNavItem = (course: (typeof courseState.courses)[number]) => {
		const expanded = expandedCourseId === course.course_id;
		const conversations = sessions.filter((session) => session.course?.course_id === course.course_id
			&& (isDailyVisible(session) || session.id === currentSessionId));
		const selected = course.course_id === courseId;
		return (
			<div className={`mla-course-nav-item${selected ? " mla-course-nav-item--selected" : ""}`} key={course.course_id}>
				<div className="mla-course-nav-head">
					<button
						type="button"
						className="mla-course-nav-toggle"
						aria-expanded={expanded}
						onClick={() => {
							if (selected) {
								setExpandedCourseId(expanded ? null : course.course_id);
								return;
							}
							learnWorkbenchStore.selectCourse(course.course_id);
							setExpandedCourseId(course.course_id);
							setMobileNavOpen(false);
						}}
					>
						{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
						<BookOpen size={14} aria-hidden="true" />
						<span className="mla-course-nav-title">{course.title}</span>
						<span className="mla-badge">{conversations.length}</span>
					</button>
					<IconButton
						size="sm"
						className="mla-course-nav-add"
						aria-label={`在「${course.title}」中新对话`}
						disabled={workbench.creating}
						onClick={() => startConversation(course.course_id)}
					>
						<Plus size={14} aria-hidden="true" />
					</IconButton>
				</div>
				{expanded ? (
					<div className="mla-course-convos">
						{conversations.length === 0 ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								这门课程还没有学习对话。在下方输入框提问即可开始第一段。
							</p>
						) : conversations.map(conversationRow)}
					</div>
				) : null}
			</div>
		);
	};

	const loadingCourses = courseState.loading && courseState.courses.length === 0;
	const chatTitle = selectedCourse?.title
		?? sessionContext?.context.course?.title
		?? (currentSessionId ? "未归类对话" : "AI 学习");

	return (
		<div className={`mla-learn${statusOpen ? "" : " mla-learn--status-collapsed"}${mobileNavOpen ? " mla-learn--nav-open" : ""}`}>
			<button
				type="button"
				className="mla-learn-nav-backdrop"
				aria-label="关闭课程列表"
				onClick={() => setMobileNavOpen(false)}
			/>

			<aside className="mla-learn-sidebar" aria-label="课程与学习对话">
				<div className="mla-learn-sidebar-head">
					<h2>我的课程</h2>
					<Button size="xs" disabled={Boolean(courseState.pendingAction)} onClick={() => setCreateOpen(true)}>
						<Plus size={14} />
						创建课程
					</Button>
				</div>

				{loadingCourses ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />
						正在加载课程…
					</p>
				) : courseState.error ? (
					<div>
						<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
							课程列表读取失败：{courseState.error}
						</p>
						<Button className="mla-inline" style={{ marginTop: 8 }} onClick={() => void coursesStore.loadCourses()}>
							<RotateCcw size={14} />
							重试
						</Button>
					</div>
				) : activeCourses.length === 0 ? (
					<div className="mla-empty" style={{ padding: "12px 0" }}>
						<FolderOpen size={22} aria-hidden="true" />
						<strong>{archivedCourses.length > 0 ? "课程都在归档中" : "还没有课程"}</strong>
						<p className="mla-small" style={{ margin: 0 }}>
							{archivedCourses.length > 0
								? "恢复归档课程，或创建一门新课程。"
								: "创建第一门课程后，就可以在这里开始学习对话。"}
						</p>
						<Button onClick={() => setCreateOpen(true)}>
							<Plus size={14} />
							创建课程
						</Button>
					</div>
				) : (
					<div className="mla-course-nav">
						{activeCourses.map(courseNavItem)}

						{unclassifiedSessions.length > 0 ? (
							<div className="mla-course-nav-item">
								<button
									type="button"
									className="mla-course-nav-toggle mla-course-nav-toggle--loose"
									aria-expanded={showUnclassified}
									onClick={() => setShowUnclassified((value) => !value)}
								>
									{showUnclassified ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
									<Archive size={14} aria-hidden="true" />
									<span className="mla-course-nav-title">未归类历史</span>
									<span className="mla-badge">{unclassifiedSessions.length}</span>
								</button>
								{showUnclassified ? (
									<div className="mla-course-convos">{unclassifiedSessions.map(conversationRow)}</div>
								) : null}
							</div>
						) : null}
					</div>
				)}

				{archivedCourses.length > 0 ? (
					<button
						type="button"
						className="mla-session-toggle"
						onClick={() => navigate("settings", { history: "push", settingsTab: "archived-courses" })}
					>
						归档课程 {archivedCourses.length} 门 →
					</button>
				) : null}
				{hiddenSessionCount > 0 ? (
					<div className="mla-session-group" style={{ marginTop: 12 }}>
						<h3 className="mla-session-group-title">已归档会话</h3>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{hiddenSessionCount} 个会话不在日常列表中（手动归档或随课程归档）。
						</p>
						<Button
							size="xs"
							onClick={() => navigate("settings", { history: "push", settingsTab: "archived-sessions" })}
						>
							前往归档会话
						</Button>
					</div>
				) : null}
				{sessionActionError ? (
					<p role="alert" className="mla-small" style={{ margin: "8px 0 0", color: "var(--inno-danger)" }}>
						{sessionActionError}
					</p>
				) : null}
			</aside>

			<section className="mla-chat-card" aria-label="AI 学习对话">
				<header className="mla-learn-chat-head">
					<IconButton
						size="sm"
						className="mla-learn-nav-toggle"
						aria-label="打开课程列表"
						aria-expanded={mobileNavOpen}
						onClick={() => setMobileNavOpen(true)}
					>
						<BookOpen size={16} aria-hidden="true" />
					</IconButton>
					<div className="mla-learn-chat-title">
						<strong>{chatTitle}</strong>
						{selectedCourse ? (
							<span className={`mla-badge${selectedCourse.status === "in_progress" ? " mla-badge--accent" : ""}`}>
								{courseStatusLabel(selectedCourse.status)}
							</span>
						) : null}
						{currentSession && !currentSession.course ? <span className="mla-badge">未归类</span> : null}
					</div>
					{selectedCourse && !blocked && selectedCourse.status === "in_progress" ? (
						<Button size="xs" disabled={workbench.creating} onClick={() => startConversation(selectedCourse.course_id)}>
							<Plus size={14} />
							新建对话
						</Button>
					) : null}
				</header>
				<CourseContextStrip sessionId={currentSessionId} />
				<LearningWorkspace
					readOnly={blocked ? false : readOnlySession}
					blocked={blocked}
					creating={workbench.creating}
					createError={workbench.error}
					createConversation={() => learnWorkbenchStore.ensureConversation()}
				/>
			</section>

			<aside className={`mla-learn-status${statusOpen ? "" : " mla-learn-status--collapsed"}`} aria-label="本次学习状态">
				<IconButton
					size="sm"
					className="mla-learn-status-toggle"
					aria-expanded={statusOpen}
					aria-label={statusOpen ? "收起学习状态" : "展开学习状态"}
					onClick={() => setStatusOpen((value) => !value)}
				>
					{statusOpen ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
				</IconButton>
				{statusOpen ? (
					<section className="mla-card" aria-labelledby="learn-checkpoint">
						<div className="mla-card-header">
							<h2 id="learn-checkpoint">本次学习</h2>
							{checkpoint ? (
								<span className={`mla-badge ${checkpoint.status === "active" ? "mla-badge--accent" : ""}`}>
									{STATUS_LABEL[checkpoint.status]}
								</span>
							) : null}
						</div>

						{!currentSessionId ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								选择课程并开始一段学习对话后，这里会显示学习检查点。
							</p>
						) : learning.isLoading ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								正在读取学习状态…
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
									重试
								</Button>
							</div>
						) : !learning.state?.exists ? (
							<div className="mla-stack" style={{ gap: 10 }}>
								<p className="mla-small mla-muted" style={{ margin: 0 }}>
									{readOnlySession
										? "这段会话没有学习检查点。归档期间不能新建记录，恢复后才能开始。"
										: "这段会话还没有学习检查点。初始化后，学习状态会记录在本机。"}
								</p>
								{readOnlySession ? null : (
									<Button
										variant="primary"
										disabled={learning.isSaving}
										onClick={() => void learningStore.init()}
									>
										初始化学习记录
									</Button>
								)}
							</div>
						) : checkpoint ? (
							<div className="mla-stack" style={{ gap: 12 }}>
								<dl className="mla-definition">
									<div>
										<dt>阶段</dt>
										<dd>{STEP_LABEL[checkpoint.step]}</dd>
									</div>
									<div>
										<dt>修订</dt>
										<dd>#{checkpoint.revision}</dd>
									</div>
								</dl>

								{question ? (
									<div>
										<span className="mla-overline">当前题目</span>
										<p className="mla-text" style={{ margin: "6px 0 0" }}>{question.prompt}</p>
										<span className="mla-small mla-muted">
											题号 {question.question_id} · 版本 {question.question_version}
										</span>
									</div>
								) : (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										当前没有待回答的题目。可以在「练习与反馈」生成一道题；检查点会随学习推进。
									</p>
								)}

								{learning.state.pending_action ? (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{ACTION_LABEL[learning.state.pending_action]}
									</p>
								) : null}

								<div className="mla-inline">
									{canPause ? (
										<Button disabled={learning.isSaving} onClick={() => void learningStore.pause()}>
											<Pause size={14} />
											暂停学习
										</Button>
									) : null}
									{canResume ? (
										<Button variant="primary" disabled={learning.isSaving} onClick={() => void learningStore.resume()}>
											<Play size={14} />
											继续学习
										</Button>
									) : null}
									{checkpoint.status === "completed" ? (
										<span className="mla-small mla-muted">检查点已完成，不能恢复。</span>
									) : null}
								</div>
							</div>
						) : null}
					</section>
				) : null}
			</aside>

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
					// conversation: the workbench opens empty and the first message
					// creates the session.
					learnWorkbenchStore.selectCourse(created.course_id, { history: "replace" });
					setExpandedCourseId(created.course_id);
					return true;
				}}
			/>

			{renaming ? (
				<Dialog
					label="重命名对话"
					className="mla-dialog"
					onClose={() => setRenaming(null)}
				>
					<div className="mla-dialog-body">
						<h2>重命名对话</h2>
						<label className="mla-field">
							<span>对话标题</span>
							<Input
								value={renaming.name}
								autoFocus
								maxLength={80}
								onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
							/>
						</label>
						<div className="mla-dialog-actions">
							<Button onClick={() => setRenaming(null)}>取消</Button>
							<Button
								variant="primary"
								disabled={!renaming.name.trim() || busySessionId === renaming.session.id}
								onClick={() => {
									const target = renaming;
									void runSessionAction(target.session.id, async () => {
										await sessionsStore.renameSession(target.session.id, target.name.trim());
									}, "重命名失败").then(() => setRenaming(null));
								}}
							>
								保存
							</Button>
						</div>
					</div>
				</Dialog>
			) : null}
		</div>
	);
}
