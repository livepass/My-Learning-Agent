import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { Button, Dialog } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { navigate } from "../shell/navigation.js";

/**
 * 归档会话 (E4.7-R1b).
 *
 * The daily rail shows only usable conversations; everything hidden from it is
 * listed here with the reason:
 *
 * - 手动归档 — the learner archived this conversation itself;
 * - 随课程归档 — the parent course is archived. The session's own flag is never
 *   rewritten by a course archive, so restoring the course brings back exactly
 *   the conversations that were not manually archived.
 *
 * 「恢复」 calls the existing unarchive API. While the parent course is archived
 * the server refuses with `course_archived`, and this panel says so up front
 * instead of letting the click fail silently.
 */
export function ArchivedSessionsSettings() {
	const state = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		loading: sessionsStore.isLoading,
	}));
	const [busyId, setBusyId] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

	useEffect(() => {
		void sessionsStore.load();
	}, []);

	const hidden = useMemo(
		() => state.sessions
			.filter((session) => session.daily_visible === false)
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
		[state.sessions],
	);

	const manualCount = hidden.filter((session) => session.archived === true).length;
	const courseCount = hidden.length - manualCount;

	const restore = async (id: string, name: string) => {
		setBusyId(id);
		setFeedback(null);
		try {
			await sessionsStore.unarchiveSession(id);
			setFeedback({ tone: "success", message: `会话「${name}」已恢复到日常学习。` });
			// Re-read: the list's derived `daily_visible` and course scope come from
			// the server, not from an optimistic local guess.
			await sessionsStore.refresh();
		} catch (err) {
			setFeedback({ tone: "error", message: errorMessage(err, "恢复失败") });
		} finally {
			setBusyId(null);
		}
	};

	const remove = async () => {
		if (!deleteTarget) return;
		const { id, name } = deleteTarget;
		setBusyId(id);
		setFeedback(null);
		try {
			await sessionsStore.deleteSession(id);
			setFeedback({ tone: "success", message: `会话「${name}」已删除。` });
		} catch (err) {
			setFeedback({ tone: "error", message: errorMessage(err, "删除失败") });
		} finally {
			setBusyId(null);
			setDeleteTarget(null);
		}
	};

	return (
		<section className="mla-card" aria-labelledby="settings-archived-sessions">
			<div className="mla-card-header">
				<div>
					<h2 id="settings-archived-sessions">归档会话</h2>
					<span className="mla-small mla-muted">
						归档的对话不再出现在 AI 学习页的日常列表中，但仍可查看、恢复或删除。
					</span>
				</div>
				<span className="mla-badge">{hidden.length} 个</span>
			</div>

			{feedback ? (
				<p
					role={feedback.tone === "success" ? "status" : "alert"}
					className={`mla-notice mla-notice--${feedback.tone}`}
				>
					{feedback.message}
				</p>
			) : null}

			{state.loading && state.sessions.length === 0 ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					正在读取会话…
				</p>
			) : hidden.length === 0 ? (
				<div className="mla-empty">
					<Archive size={26} aria-hidden="true" />
					<strong>没有归档会话</strong>
					<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
						在 AI 学习页的会话菜单中选择「归档会话」，它会出现在这里。
					</p>
				</div>
			) : (
				<>
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{manualCount} 个手动归档 · {courseCount} 个随课程归档
					</p>
					<div className="mla-state-list">
						{hidden.map((session) => {
							const name = session.name || "未命名对话";
							const byCourse = session.archived !== true;
							const courseArchived = session.course?.archived === true;
							const busy = busyId === session.id;
							return (
								<div className="mla-state-row" key={session.id}>
									<div>
										<div className="mla-inline" style={{ flexWrap: "wrap" }}>
											<strong>{name}</strong>
											<span className={`mla-badge${byCourse ? "" : " mla-badge--warning"}`}>
												{byCourse ? "随课程归档" : "手动归档"}
											</span>
											{session.course ? (
												<span className="mla-badge">{session.course.title}</span>
											) : null}
										</div>
										<p>{session.preview || `${session.messageCount} 条消息`}</p>
										<p className="mla-small mla-muted">
											{new Date(session.updatedAt).toLocaleString("zh-CN")}
											{byCourse ? " · 恢复课程后，该会话会回到日常学习" : ""}
										</p>
									</div>
									<div className="mla-inline" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
										<Button
											size="xs"
											disabled={busy}
											onClick={() => {
												navigate("learn", { history: "push", session: session.id });
												void sessionsStore.openSession(session.id, { historyMode: "none" });
											}}
										>
											<ExternalLink size={14} />
											查看历史
										</Button>
										<Button
											size="xs"
											disabled={busy || courseArchived}
											title={courseArchived ? "所属课程仍归档，请先在「归档课程」中恢复课程" : undefined}
											onClick={() => void restore(session.id, name)}
										>
											<ArchiveRestore size={14} />
											恢复会话
										</Button>
										<Button
											size="xs"
											variant="danger"
											disabled={busy}
											onClick={() => setDeleteTarget({ id: session.id, name })}
										>
											<Trash2 size={14} />
											删除
										</Button>
									</div>
								</div>
							);
						})}
					</div>
					{courseCount > 0 ? (
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							标注「随课程归档」的会话，需要先恢复课程；恢复课程后只有未手动归档的会话会回到日常学习。
							<button
								type="button"
								className="mla-link-button"
								style={{ marginLeft: 6 }}
								onClick={() => navigate("settings", { history: "push", settingsTab: "archived-courses" })}
							>
								前往归档课程
							</button>
						</p>
					) : null}
				</>
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
						<div className="mla-dialog-actions">
							<Button onClick={() => setDeleteTarget(null)}>取消</Button>
							<Button variant="danger" disabled={busyId === deleteTarget.id} onClick={() => void remove()}>
								<Trash2 size={14} />
								永久删除
							</Button>
						</div>
					</div>
				</Dialog>
			) : null}
		</section>
	);
}

/** Prefer the server's own copy (`course_archived` explains the next step). */
function errorMessage(err: unknown, fallback: string): string {
	const data = (err as { data?: Record<string, unknown> } | undefined)?.data;
	if (typeof data?.message === "string" && data.message) return data.message;
	const status = (err as { status?: number } | undefined)?.status;
	if (status === 409) return `${fallback}：操作被拒绝，请刷新后重试。`;
	return err instanceof Error ? `${fallback}：${err.message}` : `${fallback}，请重试。`;
}
