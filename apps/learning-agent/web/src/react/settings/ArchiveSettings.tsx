import { useEffect, useMemo, useState } from "react";
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

function sessionName(session: SessionMeta): string {
	return session.name || "未命名对话";
}

/** The reason a conversation is in the archive centre, in display order. */
function archiveReason(session: SessionMeta): { label: string; manual: boolean } {
	if (session.archived === true) {
		return { label: session.course?.archived === true ? "手动归档 · 课程已归档" : "手动归档", manual: true };
	}
	return { label: "随课程归档", manual: false };
}

function timeLabel(iso: string): string {
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN") : "";
}

function errorMessage(err: unknown, fallback: string): string {
	const data = (err as { data?: Record<string, unknown> } | undefined)?.data;
	if (typeof data?.message === "string" && data.message) return data.message;
	const status = (err as { status?: number } | undefined)?.status;
	if (status === 409) return `${fallback}：操作被拒绝，请刷新后重试。`;
	return err instanceof Error ? `${fallback}：${err.message}` : `${fallback}，请重试。`;
}

export function ArchiveSettings() {
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
				setFeedback({ tone: "error", message: coursesStore.feedback?.message ?? "恢复课程失败，请重试。" });
				return;
			}
			// The course row and every child's derived `daily_visible` /
			// `course.archived` come from the server; the session list must be
			// re-read or the groups keep the old split.
			await sessionsStore.refresh();
			setFeedback({ tone: "success", message: `课程「${course.title}」已恢复为暂停；手动归档的会话仍保留在这里。` });
		} catch (err) {
			setFeedback({ tone: "error", message: errorMessage(err, "恢复课程失败") });
		} finally {
			setBusyId(null);
		}
	};

	const restoreSession = async (session: SessionMeta) => {
		const name = sessionName(session);
		setBusyId(session.id);
		setFeedback(null);
		try {
			await sessionsStore.unarchiveSession(session.id);
			await sessionsStore.refresh();
			setFeedback({ tone: "success", message: `会话「${name}」已恢复到日常学习。` });
		} catch (err) {
			setFeedback({ tone: "error", message: errorMessage(err, "恢复会话失败") });
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
			setFeedback({ tone: "success", message: `会话「${name}」已删除。` });
		} catch (err) {
			// A failure removes nothing locally; the row stays visible.
			setFeedback({ tone: "error", message: errorMessage(err, "删除失败") });
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
		const name = sessionName(session);
		const reason = archiveReason(session);
		const busy = busyId === session.id;
		return (
			<div className="mla-archive-session" key={session.id}>
				<div className="mla-archive-session-main">
					<div className="mla-inline" style={{ flexWrap: "wrap", gap: 6 }}>
						<strong className="mla-archive-session-title">{name}</strong>
						<span className={`mla-badge${reason.manual ? " mla-badge--warning" : ""}`}>{reason.label}</span>
						{courseArchived ? <span className="mla-badge">只读</span> : null}
					</div>
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{timeLabel(session.updatedAt)}
						{session.preview ? ` · ${session.preview}` : ""}
					</p>
				</div>
				<div className="mla-archive-actions">
					<Button size="xs" disabled={busy} onClick={() => openHistory(session.id)}>
						<ExternalLink size={14} aria-hidden="true" />
						查看历史
					</Button>
					{/* A child of an archived course cannot be restored on its own. */}
					<Button
						size="xs"
						disabled={busy || courseArchived}
						title={courseArchived ? "请先恢复所属课程" : undefined}
						onClick={() => void restoreSession(session)}
					>
						<ArchiveRestore size={14} aria-hidden="true" />
						恢复会话
					</Button>
					<Button
						size="xs"
						variant="danger"
						disabled={busy}
						onClick={() => setDeleteTarget({ id: session.id, name })}
					>
						<Trash2 size={14} aria-hidden="true" />
						删除会话
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
						<span className="mla-archive-group-title" id="archive-unclassified">未归类归档会话</span>
						<span className="mla-badge">{group.sessions.length}</span>
						<span className="mla-small mla-muted">没有课程绑定，不会被自动归入任何课程</span>
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
						<span className="mla-archive-group-title" id={`archive-${group.courseId}`}>{group.title}</span>
						{group.courseArchived ? <span className="mla-badge">已归档</span> : null}
						<span className="mla-badge">{group.sessions.length} 个会话</span>
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
									课程详情
								</Button>
								<Button
									size="xs"
									disabled={busy}
									onClick={() => navigate("course", { history: "push", course: { id: course.course_id, view: "records" } })}
								>
									<ClipboardList size={14} aria-hidden="true" />
									学习记录
								</Button>
								<Button size="xs" variant="primary" disabled={busy} onClick={() => void restoreCourse(course)}>
									{busy ? <Loader2 size={14} className="mla-spin" /> : <ArchiveRestore size={14} aria-hidden="true" />}
									恢复课程
								</Button>
								<Button
									size="xs"
									variant="danger"
									disabled={busy}
									onClick={() => setCourseTarget({ kind: "course", courseId: course.course_id, title: course.title })}
								>
									<Trash2 size={14} aria-hidden="true" />
									删除课程
								</Button>
							</div>
							{/* Phones: the same actions in a menu, so nothing overflows. */}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button size="xs" className="mla-archive-actions-menu" aria-label={`课程操作：${group.title}`}>
										<MoreHorizontal size={14} aria-hidden="true" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuActionItem
										icon={<BookOpen size={14} />}
										label="课程详情"
										onSelect={() => navigate("course", { history: "push", course: { id: course.course_id, view: "overview" } })}
									/>
									<DropdownMenuActionItem
										icon={<ClipboardList size={14} />}
										label="学习记录"
										onSelect={() => navigate("course", { history: "push", course: { id: course.course_id, view: "records" } })}
									/>
									<DropdownMenuActionItem
										icon={<ArchiveRestore size={14} />}
										label="恢复课程"
										onSelect={() => void restoreCourse(course)}
									/>
									<DropdownMenuActionItem
										variant="danger"
										icon={<Trash2 size={14} />}
										label="删除课程"
										onSelect={() => setCourseTarget({ kind: "course", courseId: course.course_id, title: course.title })}
									/>
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					) : (
						<span className="mla-small mla-muted mla-archive-group-hint">
							{group.sessions.length} 个会话已手动归档
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
					<h2 id="settings-archive">归档</h2>
					<span className="mla-small mla-muted">
						归档的课程与对话不再出现在日常列表，但仍可查看、恢复或删除。课程归档与会话手动归档是两种独立状态。
					</span>
				</div>
				<span className="mla-badge">{groups.length} 组 · {totalSessions} 个会话</span>
			</div>

			{feedback ? (
				<p role={feedback.tone === "success" ? "status" : "alert"} className={`mla-notice mla-notice--${feedback.tone}`}>
					{feedback.message}
				</p>
			) : null}

			{loading ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					正在读取归档内容…
				</p>
			) : loadError ? (
				<div>
					<p role="alert" className="mla-notice mla-notice--error">
						归档内容读取失败：{loadError}
					</p>
					<Button size="xs" onClick={() => void refreshAll()}>重试</Button>
				</div>
			) : groups.length === 0 ? (
				<div className="mla-empty">
					<Archive size={26} aria-hidden="true" />
					<strong>暂无归档内容</strong>
					<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
						在课程或对话的「更多操作」中选择归档后，内容会出现在这里。
					</p>
				</div>
			) : (
				<div className="mla-archive-groups">{groups.map(groupCard)}</div>
			)}

			{deleteTarget ? (
				<Dialog label="删除归档会话" className="mla-dialog" onClose={() => setDeleteTarget(null)}>
					<div className="mla-dialog-body">
						<h2>永久删除会话「{deleteTarget.name}」？</h2>
						<p className="mla-text" style={{ margin: 0 }}>
							聊天内容、题目、作答、评分和学习检查点将无法恢复。
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							已经写入长期学习档案的学习证据和掌握状态不会自动删除或回滚；原始作答可能无法再回查。
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							如果这是运行时当前绑定的会话，删除后会自动新建一个空白对话并切换过去；原会话不会恢复。
						</p>
						<div className="mla-dialog-actions">
							<Button onClick={() => setDeleteTarget(null)}>取消</Button>
							<Button variant="danger" disabled={busyId === deleteTarget.id} onClick={() => void removeSession()}>
								<Trash2 size={14} aria-hidden="true" />
								永久删除
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
			// is keyed by the real id either way.
			title: course?.title ?? rows[0]?.course?.title ?? "未知课程",
			courseArchived: course?.status === "archived" || rows.some((row) => row.course?.archived === true),
			sessions: [...rows].sort(newest),
		});
	}
	groups.sort((a, b) => {
		if (a.kind !== "course" || b.kind !== "course") return a.kind === "course" ? -1 : 1;
		if (a.courseArchived !== b.courseArchived) return a.courseArchived ? -1 : 1;
		return a.title.localeCompare(b.title, "zh-CN");
	});
	if (unclassified.length > 0) {
		groups.push({ kind: "unclassified", sessions: [...unclassified].sort(newest) });
	}
	return groups;
}
