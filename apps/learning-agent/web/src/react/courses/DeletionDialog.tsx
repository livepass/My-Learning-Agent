import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import { Button, Dialog } from "../ui/index.js";
import { coursesStore, taskStatusLabel } from "../../stores/courses-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { navigate } from "../shell/navigation.js";
import type {
	CourseDeletionReport,
	CourseDeletionSessionDetail,
	CourseDeletionTaskDetail,
	DeletionBlocker,
	PlanDeletionReport,
} from "../../api/courses.js";

/**
 * E4.7 / E4.8d — the one place a course or plan is permanently deleted.
 *
 * Rules, all enforced here rather than in the menu that opens it:
 *
 * 1. Opening the dialog is a read (`.../delete-preview`), so nothing is
 *    removed by clicking 「删除」 in a menu;
 * 2. the summary names what disappears — stages, tasks, material associations,
 *    conversations, B2 evidence and L1 mastery — and the server's blockers
 *    decide whether a delete is offered at all;
 * 3. the final action needs a second confirmation, because there is no trash.
 *
 * E4.8d: for an **archived course** the history is no longer a refusal. The
 * dialog states exactly how much evidence the delete destroys and what shared
 * data survives, then lets the learner confirm. A course that is not archived
 * is still refused (`course_not_archived`) — archiving is the first step. The
 * plan path keeps the E4.7 rule: a plan with history can only be archived.
 */

export type DeletionTarget =
	| { kind: "course"; courseId: string; title: string }
	| { kind: "plan"; courseId: string; planId: string; title: string };

function isCourseReport(report: CourseDeletionReport | PlanDeletionReport): report is CourseDeletionReport {
	return "has_material" in report;
}

/** Count/fact rows for the confirmation body. Never an estimate. */
function deletionFacts(report: CourseDeletionReport | PlanDeletionReport): string[] {
	if (isCourseReport(report)) {
		const facts = [`${report.counts.plans} 份学习计划`, `${report.counts.stages} 个阶段`, `${report.counts.tasks} 个任务`];
		facts.push(report.has_material ? `关联教材 ${report.counts.sources} 份（教材原文会保留）` : "未关联教材");
		if (report.counts.goals > 0) facts.push(`课程目标关联 ${report.counts.goals} 个（学习目标本身会保留）`);
		if (report.counts.sessions > 0) facts.push(`学习会话 ${report.counts.sessions} 个（聊天记录与学习记录一并删除）`);
		if (report.counts.started_tasks > 0) facts.push(`已开始或完成的任务 ${report.counts.started_tasks} 个`);
		return facts;
	}
	const facts = [`${report.counts.stages} 个阶段`, `${report.counts.tasks} 个任务`];
	if (report.counts.completed_tasks > 0) facts.push(`已完成任务 ${report.counts.completed_tasks} 个`);
	if (report.counts.sessions > 0) facts.push(`关联学习会话 ${report.counts.sessions} 个`);
	return facts;
}

/**
 * E4.8d — the evidence a course delete destroys, stated before the learner
 * confirms. Zero counts are printed as zero (not omitted) so "no evidence" is a
 * visible fact rather than an absence the reader has to interpret.
 */
function destroyedEvidenceFacts(report: CourseDeletionReport): string[] {
	const sessions = report.b2_evidence_sessions ?? 0;
	const attempts = report.b2_evidence_attempts ?? 0;
	return [
		`B2 正式学习证据：${sessions} 个会话、${attempts} 条记录`,
		`L1 课程知识点掌握状态：${report.mastery_state_count ?? 0} 个`,
	];
}

/** Time in the course records' own format; an unparseable value prints nothing. */
function formatTime(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleString("zh-CN", {
		month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
	});
}

/**
 * The evidence badge for one task.
 *
 * Deliberately three states and no fourth: a task status alone is never shown
 * as evidence, and a bound conversation without a formal attempt is still
 * 「待核实」 rather than a success.
 */
function evidenceBadge(detail: CourseDeletionTaskDetail): { label: string; tone: string } {
	switch (detail.evidence_state) {
		case "b2_evidence":
			return {
				label: detail.b2_evidence_count === null
					? "B2 正式证据"
					: `B2 正式证据 ${detail.b2_evidence_count} 条`,
				tone: "mla-badge mla-badge--success",
			};
		case "session_bound":
			return { label: "已关联会话，证据待核实", tone: "mla-badge mla-badge--warning" };
		default:
			return { label: "仅有任务进度，证据待核实", tone: "mla-badge mla-badge--warning" };
	}
}

/**
 * The started tasks a delete would orphan, so the learner can locate them.
 *
 * Collapsed by default: the dialog's first job is the decision, not a list. The
 * rows are read-only — this package locates real records and explains the
 * reason; it never resets progress. Clicking a row with a bound conversation
 * opens that conversation, where the learning record lives.
 */
/** Open one conversation's history from a read-only preview row. */
function openLearningSession(sessionId: string): void {
	navigate("learn", { history: "push", session: sessionId });
	void sessionsStore.openSession(sessionId, { historyMode: "none" });
}

function BlockingTaskList({ details }: { details: CourseDeletionTaskDetail[] }) {
	const [expanded, setExpanded] = useState(false);
	if (details.length === 0) return null;
	return (
		<div className="mla-stack" style={{ gap: 6 }}>
			<button
				type="button"
				className="mla-link-button mla-inline"
				aria-expanded={expanded}
				onClick={() => setExpanded((value) => !value)}
			>
				{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
				{expanded ? "收起具体任务" : `查看涉及的具体任务（${details.length}）`}
			</button>
			{expanded ? (
				<div className="mla-state-list">
					{details.map((detail) => {
						const badge = evidenceBadge(detail);
						const where = [detail.plan_title, detail.stage_title].filter(Boolean).join(" · ");
						const updated = formatTime(detail.updated_at);
						return (
							<div className="mla-state-row" key={detail.task_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{detail.task_title}</strong>
										<span className="mla-badge">{taskStatusLabel(detail.task_status)}</span>
										<span className={badge.tone}>{badge.label}</span>
									</div>
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{where || "未归属计划"}
										{detail.completed_at ? ` · 完成于 ${formatTime(detail.completed_at)}` : ""}
										{updated ? ` · 更新于 ${updated}` : ""}
									</p>
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{detail.session_ids.length > 0
											? `关联会话 ${detail.session_ids.length} 个`
											: "没有关联学习会话"}
									</p>
								</div>
								{detail.session_ids.length > 0 ? (
									<Button
										size="xs"
										onClick={() => openLearningSession(detail.session_ids[0])}
									>
										查看学习记录
									</Button>
								) : null}
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

/**
 * Every bound conversation that blocks the delete.
 *
 * Driven by bindings, not task status: a pending task can already own a
 * conversation, and a course-level session may have no task at all. Both are
 * named here with their archive state and B2 verification result, so the
 * learner can open the actual record instead of guessing from counts.
 */
function BlockingSessionList({ details }: { details: CourseDeletionSessionDetail[] }) {
	if (details.length === 0) return null;
	return (
		<div className="mla-stack" style={{ gap: 6 }}>
			<p className="mla-small mla-muted" style={{ margin: 0 }}>
				涉及的学习会话（{details.length}）
			</p>
			<div className="mla-state-list">
				{details.map((detail) => {
					const b2 = detail.b2_evidence_count === null
						? { label: "B2 待核实", tone: "mla-badge mla-badge--warning" }
						: detail.b2_evidence
							? { label: `B2 正式证据 ${detail.b2_evidence_count} 条`, tone: "mla-badge mla-badge--success" }
							: { label: "无 B2 正式证据", tone: "mla-badge" };
					const archived = detail.archived === null
						? { label: "归档状态待核实", tone: "mla-badge mla-badge--warning" }
						: detail.archived
							? { label: "已归档", tone: "mla-badge" }
							: { label: "日常会话", tone: "mla-badge" };
					const where = [detail.plan_title, detail.stage_title].filter(Boolean).join(" · ");
					return (
						<div className="mla-state-row" key={detail.session_id}>
							<div style={{ minWidth: 0 }}>
								<div className="mla-inline" style={{ flexWrap: "wrap" }}>
									<strong style={{ overflowWrap: "anywhere" }}>
										{detail.task_title ?? "未关联任务"}
									</strong>
									{detail.task_status ? (
										<span className="mla-badge">{taskStatusLabel(detail.task_status)}</span>
									) : null}
									<span className={archived.tone}>{archived.label}</span>
									<span className={b2.tone}>{b2.label}</span>
								</div>
								<p className="mla-small mla-muted" style={{ margin: 0, overflowWrap: "anywhere" }}>
									会话 {detail.session_id}
								</p>
								{where ? (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>{where}</p>
								) : null}
							</div>
							<Button size="xs" onClick={() => openLearningSession(detail.session_id)}>
								查看历史
							</Button>
						</div>
					);
				})}
			</div>
		</div>
	);
}

export function DeletionDialog({
	target,
	onClose,
	onDeleted,
	onArchive,
}: {
	target: DeletionTarget | null;
	onClose: () => void;
	/** Called after the server confirmed the delete; the caller navigates away. */
	onDeleted?: () => void;
	/** Archive instead: the only action left when the record has history. */
	onArchive?: () => Promise<boolean>;
}) {
	const state = useStoreSnapshot(coursesStore, () => ({
		preview: coursesStore.deletionPreview,
		loading: coursesStore.deletionPreviewLoading,
		error: coursesStore.deletionPreviewError,
		pendingAction: coursesStore.pendingAction,
		feedback: coursesStore.feedback,
	}));
	const [step, setStep] = useState<"summary" | "confirm">("summary");

	/** The read this dialog performs; built once so every caller agrees. */
	const previewTarget = target
		? target.kind === "course"
			? { kind: "course" as const, courseId: target.courseId }
			: { kind: "plan" as const, courseId: target.courseId, planId: target.planId }
		: null;
	const targetKey = previewTarget ? JSON.stringify(previewTarget) : null;

	useEffect(() => {
		setStep("summary");
		if (!previewTarget) return;
		void coursesStore.loadDeletionPreview(previewTarget);
		// The target key is the identity: re-opening the same target must not
		// re-fetch, but a different course/plan is a different question.
	}, [targetKey]);

	useEffect(() => () => coursesStore.clearDeletionPreview(), []);

	if (!target) return null;

	const report = state.preview;
	const blockers: DeletionBlocker[] = report?.blockers ?? [];
	const deletable = report?.deletable ?? false;
	const busy = state.pendingAction === "delete_course" || state.pendingAction === "delete_plan" || state.pendingAction === "archive_course" || state.pendingAction === "archive_plan";
	const subject = target.kind === "course" ? "课程" : "学习计划";
	const writeError = state.feedback && state.feedback.tone !== "success" ? state.feedback.message : null;

	const close = () => {
		coursesStore.clearDeletionPreview();
		onClose();
	};

	const remove = async () => {
		const done = target.kind === "course"
			? await coursesStore.deleteCourse(target.courseId)
			: await coursesStore.deletePlan(target.courseId, target.planId);
		if (!done) {
			// A 409 here means the record changed after the preflight (a session
			// started, a task was completed). Go back to the summary and re-read
			// so the dialog shows the current blockers instead of a stale
			// "deletable" that the learner could click again.
			setStep("summary");
			if (previewTarget) void coursesStore.loadDeletionPreview(previewTarget);
			return;
		}
		onClose();
		onDeleted?.();
	};

	const archive = async () => {
		if (!onArchive) return;
		const done = await onArchive();
		if (done) onClose();
	};

	return (
		<Dialog label={`删除${subject}确认`} className="mla-dialog" onClose={close}>
			<div className="mla-dialog-body">
				{step === "summary" ? (
					<>
						<h2>删除{subject}「{target.title}」？</h2>
						{state.loading && !report ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								正在检查是否可以安全删除…
							</p>
						) : state.error ? (
							<>
								<p role="alert" className="mla-notice mla-notice--error">{state.error}</p>
								<div className="mla-dialog-actions">
									<Button onClick={close}>关闭</Button>
									<Button onClick={() => { if (previewTarget) void coursesStore.loadDeletionPreview(previewTarget); }}>
										重试
									</Button>
								</div>
							</>
						) : report ? (
							<>
								<p className="mla-text" style={{ margin: 0 }}>将永久删除：</p>
								<ul className="mla-list">
									{deletionFacts(report).map((fact) => <li key={fact}><span>{fact}</span></li>)}
								</ul>

								{deletable ? (
									isCourseReport(report) ? (
										<>
											<p className="mla-text" style={{ margin: 0 }}>同时删除、且不可恢复的学习记录：</p>
											<ul className="mla-list">
												{destroyedEvidenceFacts(report).map((fact) => (
													<li key={fact}><span>{fact}</span></li>
												))}
											</ul>
											{/* The same lists as the refusal branch: a confirmed delete
											    should still let the learner inspect exactly which tasks
											    and conversations are about to disappear. */}
											<BlockingTaskList details={report.started_task_details ?? []} />
											<BlockingSessionList details={report.session_details ?? []} />
											<p className="mla-small mla-muted" style={{ margin: 0 }}>
												会保留：教材原文与其他课程共用的资料、学习目标本身、其他课程的对话与学习档案。
											</p>
											<p className="mla-small mla-muted" style={{ margin: 0 }}>
												课程已归档，历史学习记录不再阻止删除；删除后无法恢复。
											</p>
										</>
									) : (
										<p className="mla-small mla-muted" style={{ margin: 0 }}>
											该计划没有学习会话、已开始的任务或正式学习证据，可以安全删除；课程教材与其他计划不受影响。
										</p>
									)
								) : (
									<>
										<p role="alert" className="mla-notice mla-notice--error mla-notice--inline" style={{ margin: 0 }}>
											<AlertTriangle size={14} aria-hidden="true" />
											{isCourseReport(report)
												? "该课程现在不能永久删除。"
												: "该学习计划已有真实学习记录，不能永久删除。"}
										</p>
										<ul className="mla-list">
											{blockers.map((blocker) => (
												<li key={blocker.code}>
													<span>{blocker.message}</span>
												</li>
											))}
										</ul>
										<BlockingTaskList details={report.started_task_details ?? []} />
										{isCourseReport(report) ? (
											<BlockingSessionList details={report.session_details ?? []} />
										) : null}
										<p className="mla-small mla-muted" style={{ margin: 0 }}>
											{isCourseReport(report)
												? "先归档课程，再回到「系统设置 → 归档课程」删除。"
												: "归档后仍可在「学习记录」中查看历史学习内容。"}
										</p>
									</>
								)}

								{writeError ? (
									<p role="alert" className="mla-notice mla-notice--error" style={{ margin: 0 }}>{writeError}</p>
								) : null}

								<div className="mla-dialog-actions">
									<Button onClick={close} disabled={busy}>取消</Button>
									{deletable ? (
										<Button variant="danger" disabled={busy} onClick={() => { coursesStore.clearFeedback(); setStep("confirm"); }}>
											<Trash2 size={14} />
											继续删除
										</Button>
									) : target.kind === "course" ? (
										// A course delete is only refused for a not-yet-archived
										// course or an in-flight start; archiving is the way forward
										// in the first case. The archived-centre caller passes no
										// `onArchive`, so it simply shows the refusal.
										onArchive ? (
											<Button variant="primary" disabled={busy} onClick={() => void archive()}>
												归档{subject}
											</Button>
										) : null
									) : onArchive ? (
										<Button variant="primary" disabled={busy} onClick={() => void archive()}>
											归档{subject}
										</Button>
									) : null}
								</div>
							</>
						) : null}
					</>
				) : (
					<>
						<h2>确认永久删除「{target.title}」？</h2>
						<p className="mla-text" style={{ margin: 0 }}>
							{target.kind === "course"
								? "删除后无法恢复：课程、计划、任务，以及该课程的全部对话与正式学习记录都会消失。"
								: "删除后无法恢复：这些阶段与任务会从课程中移除，规划状态不会保留。"}
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{target.kind === "course"
								? "教材原文、学习目标本身、其他课程的对话与学习档案会保留。"
								: "学习档案、知识库教材与其他计划不受影响。"}
						</p>
						{writeError ? (
							<p role="alert" className="mla-notice mla-notice--error" style={{ margin: 0 }}>{writeError}</p>
						) : null}
						<div className="mla-dialog-actions">
							<Button onClick={close} disabled={busy}>取消</Button>
							<Button variant="danger" disabled={busy} onClick={() => void remove()}>
								{busy ? <Loader2 size={14} className="mla-spin" /> : <Trash2 size={14} />}
								永久删除
							</Button>
						</div>
					</>
				)}
			</div>
		</Dialog>
	);
}
