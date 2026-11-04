import { useEffect, useMemo, useState } from "react";
import {
	Archive, ArchiveRestore, BookOpen, ChevronDown, ChevronUp, Loader2, MoreHorizontal,
	Pause, Play, Plus, RotateCcw, Trash2,
} from "lucide-react";
import { appStore } from "../../stores/app-store.js";
import { learningStore } from "../../stores/learning-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import {
	Button, DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/index.js";
import { LearningWorkspace } from "../LearningWorkspace.js";
import type { LearningCheckpointStatus, LearningCheckpointStep, LearningRecoveryAction } from "../../api/learning.js";
import type { SessionMeta } from "../../api/sessions.js";

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
	evaluate: "已保存作答，等待评分（评分尚未开放）",
	wait_for_running_evaluation: "评分正在进行（评分尚未开放）",
	await_manual_retry: "评分失败，等待重试（评分尚未开放）",
	mark_retry_limit: "已达评分重试上限（评分尚未开放）",
	publish_saved_evidence: "已评分，等待写入学习证据（尚未开放）",
	project_saved_evidence: "证据已记录，等待更新学习画像（尚未开放）",
	advance_checkpoint: "检查点可以继续推进（尚未开放）",
	return_saved_result: "本次作答已保存，可继续下一题",
};

export function LearnPage() {
	const { currentSessionId, sessions, openingSessionId, pendingNewSession } = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
		sessions: sessionsStore.sessions,
		openingSessionId: sessionsStore.openingSessionId,
		pendingNewSession: sessionsStore.pendingNewSession,
	}));
	const learning = useStoreSnapshot(learningStore, () => ({
		sessionId: learningStore.sessionId,
		state: learningStore.state,
		isLoading: learningStore.isLoading,
		isSaving: learningStore.isSaving,
		error: learningStore.error,
	}));
	const [showAllActive, setShowAllActive] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	const [busySessionId, setBusySessionId] = useState<string | null>(null);
	const [sessionActionError, setSessionActionError] = useState<string | null>(null);

	useEffect(() => {
		void sessionsStore.load();
	}, []);

	/**
	 * Resume the newest conversation instead of silently starting a new one.
	 *
	 * A fresh load (refresh, new tab, first visit after restart) has no
	 * `?session=`, so the first message used to create a second, near-identical
	 * conversation while the previous one stayed in the rail. An explicit "新建"
	 * sets `pendingNewSession`, so that intent is never overridden; an open or
	 * opening session is left alone. The URL is replaced, not pushed, so Back
	 * does not land on an empty learn page.
	 */
	useEffect(() => {
		if (currentSessionId || openingSessionId || pendingNewSession) return;
		const newest = [...sessions]
			.filter((session) => !session.archived)
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
		if (!newest) return;
		void sessionsStore.openSession(newest.id, { historyMode: "replace" });
	}, [currentSessionId, openingSessionId, pendingNewSession, sessions]);

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

	const activeSessions = sessions.filter((session) => !session.archived);
	const archivedSessions = sessions.filter((session) => session.archived);
	// Six is a scan limit, not a shelf: the rest stay reachable through "查看全部".
	const visibleActiveSessions = showAllActive ? activeSessions : activeSessions.slice(0, 6);
	const hiddenActiveCount = activeSessions.length - visibleActiveSessions.length;
	const canPause = checkpoint?.status === "active" && !learning.isSaving;
	const canResume = checkpoint?.status === "paused" && !learning.isSaving;

	const runSessionAction = async (id: string, action: () => Promise<void>, failure: string) => {
		setSessionActionError(null);
		setBusySessionId(id);
		try {
			await action();
		} catch (err) {
			setSessionActionError(err instanceof Error ? `${failure}：${err.message}` : `${failure}，请重试。`);
		} finally {
			setBusySessionId(null);
		}
	};

	const archiveOne = (id: string) =>
		runSessionAction(id, async () => {
			try {
				await sessionsStore.archiveSession(id);
			} catch (err) {
				// The server refuses while a turn is streaming; say what to do instead
				// of surfacing its English status line.
				const status = (err as { status?: number } | undefined)?.status;
				throw new Error(status === 409
					? "当前会话还有正在生成的回复，请先停止后再归档。"
					: err instanceof Error ? err.message : "网络错误");
			}
		}, "归档失败");

	const restoreOne = (id: string) =>
		runSessionAction(id, () => sessionsStore.unarchiveSession(id), "恢复失败");

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
		const copy = [
			`删除会话「${name}」？`,
			"",
			"删除后，该会话的聊天内容、题目、作答、评分和学习检查点将无法恢复。",
			"",
			"已经写入长期学习档案的学习证据和掌握状态不会自动删除或回滚。",
			"",
			"因此，原始作答可能无法再回查。这不等同于彻底清除个人学习数据。",
			...(isCurrent ? ["", "这是当前打开的会话；删除后会自动切换到另一个已有会话。若没有其他可用会话，本次删除会被取消，不会自动新建。"] : []),
		].join("\n");
		if (typeof window !== "undefined" && !window.confirm(copy)) return;
		await runSessionAction(id, async () => {
			try {
				await sessionsStore.deleteSession(id);
			} catch (err) {
				// D4 and the replacement race have concrete remedies; surface them
				// instead of the raw status line.
				const data = (err as { data?: Record<string, unknown> } | undefined)?.data;
				if (data?.error === "no_replacement_session") {
					throw new Error("这是当前唯一的会话，已保留。请先新建一个会话，或归档后再删除。");
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

	/** One row for both groups: open, plus a secondary menu for archiving/deleting. */
	const sessionRow = (session: SessionMeta) => {
		const name = session.name || "未命名对话";
		const busy = Boolean(openingSessionId) || busySessionId === session.id;
		return (
			<div className="mla-session-row" key={session.id}>
				<button
					type="button"
					className="mla-session-item"
					aria-current={session.id === currentSessionId ? "true" : undefined}
					disabled={busy}
					onClick={() => void sessionsStore.openSession(session.id)}
				>
					<strong style={{ fontWeight: 500 }}>{name}</strong>
					<span>{session.preview || (session.messageCount > 0 ? `${session.messageCount} 条消息` : "暂无消息")}</span>
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
						{session.archived ? (
							<DropdownMenuActionItem
								icon={<ArchiveRestore size={14} />}
								label="恢复会话"
								onSelect={() => void restoreOne(session.id)}
							/>
						) : (
							<DropdownMenuActionItem
								icon={<Archive size={14} />}
								label="归档会话"
								onSelect={() => void archiveOne(session.id)}
							/>
						)}
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

	return (
		<div className="mla-learn">
			<section className="mla-chat-card" aria-label="AI 学习对话">
				<LearningWorkspace />
			</section>

			<aside className="mla-rail" aria-label="学习状态与会话">
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
							开始或打开一段学习对话后，这里会显示学习检查点。
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
								这段会话还没有学习检查点。初始化后，学习状态会记录在本机。
							</p>
							<Button
								variant="primary"
								disabled={learning.isSaving}
								onClick={() => void learningStore.init()}
							>
								初始化学习记录
							</Button>
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
									当前没有待回答的题目。出题能力尚未开放，检查点会随对话推进。
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

				<section className="mla-card" aria-labelledby="learn-sessions">
					<div className="mla-card-header">
						<h2 id="learn-sessions">学习会话</h2>
						<Button
							disabled={Boolean(openingSessionId)}
							onClick={() => {
								appStore.setChatDraft(appStore.chatDraft);
								sessionsStore.beginNewSession();
							}}
						>
							<Plus size={14} />
							新建
						</Button>
					</div>
					{sessions.length === 0 ? (
						<div className="mla-empty">
							<BookOpen size={24} aria-hidden="true" />
							<strong>暂无学习对话</strong>
							<p className="mla-small" style={{ margin: 0 }}>直接在左侧提问即可开始。</p>
						</div>
					) : (
						<div className="mla-stack" style={{ gap: 14 }}>
							<div className="mla-session-group">
								<h3 className="mla-session-group-title">日常会话</h3>
								{activeSessions.length === 0 ? (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										日常会话已全部归档，可在下方「已归档」中恢复。
									</p>
								) : (
									<div className="mla-session-list">
										{visibleActiveSessions.map(sessionRow)}
									</div>
								)}
								{hiddenActiveCount > 0 ? (
									<button type="button" className="mla-session-toggle" onClick={() => setShowAllActive(true)}>
										查看全部 {activeSessions.length} 条（还有 {hiddenActiveCount} 条）
									</button>
								) : showAllActive && activeSessions.length > 6 ? (
									<button type="button" className="mla-session-toggle" onClick={() => setShowAllActive(false)}>
										收起
									</button>
								) : null}
							</div>

							<div className="mla-session-group">
								<button
									type="button"
									className="mla-session-group-toggle"
									aria-expanded={showArchived}
									aria-controls="learn-archived"
									onClick={() => setShowArchived((value) => !value)}
								>
									<span className="mla-session-group-title">已归档</span>
									<span className="mla-badge">{archivedSessions.length}</span>
									{showArchived
										? <ChevronUp size={14} aria-hidden="true" />
										: <ChevronDown size={14} aria-hidden="true" />}
								</button>
								{showArchived ? (
									<div id="learn-archived" className="mla-session-list">
										{archivedSessions.length === 0 ? (
											<p className="mla-small mla-muted" style={{ margin: 0 }}>暂无归档会话。</p>
										) : archivedSessions.map(sessionRow)}
									</div>
								) : null}
							</div>
						</div>
					)}
					{sessionActionError ? (
						<p role="alert" className="mla-small" style={{ margin: "8px 0 0", color: "var(--inno-danger)" }}>
							{sessionActionError}
						</p>
					) : null}
				</section>
			</aside>
		</div>
	);
}
