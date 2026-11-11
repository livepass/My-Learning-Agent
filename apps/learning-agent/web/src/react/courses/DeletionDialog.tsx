import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button, Dialog } from "../ui/index.js";
import { coursesStore } from "../../stores/courses-store.js";
import { useStoreSnapshot } from "../hooks.js";
import type { CourseDeletionReport, DeletionBlocker, PlanDeletionReport } from "../../api/courses.js";

/**
 * E4.7 — the one place a course or plan is permanently deleted.
 *
 * Three rules, all enforced here rather than in the menu that opens it:
 *
 * 1. Opening the dialog is a read (`.../delete-preview`), so nothing is
 *    removed by clicking 「删除」 in a menu;
 * 2. the summary names what disappears — stages, tasks, material associations —
 *    and the server's blockers decide whether a delete is offered at all;
 * 3. the final action needs a second confirmation, because the server deletes
 *    atomically and there is no trash to restore from.
 *
 * A record with real learning history never reaches step two: the only action
 * kept is archiving, which is what preserves L1/L2/L3/B2.
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
		if (report.counts.sessions > 0) facts.push(`学习会话 ${report.counts.sessions} 个`);
		return facts;
	}
	const facts = [`${report.counts.stages} 个阶段`, `${report.counts.tasks} 个任务`];
	if (report.counts.completed_tasks > 0) facts.push(`已完成任务 ${report.counts.completed_tasks} 个`);
	if (report.counts.sessions > 0) facts.push(`关联学习会话 ${report.counts.sessions} 个`);
	return facts;
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
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{target.kind === "course"
											? "该课程没有学习会话、已开始的任务或正式学习证据，可以安全删除；教材原文、学习目标与其他课程不受影响。"
											: "该计划没有学习会话、已开始的任务或正式学习证据，可以安全删除；课程教材与其他计划不受影响。"}
									</p>
								) : (
									<>
										<p role="alert" className="mla-notice mla-notice--error mla-notice--inline" style={{ margin: 0 }}>
											<AlertTriangle size={14} aria-hidden="true" />
											该{subject}已有真实学习记录，不能永久删除。
										</p>
										<ul className="mla-list">
											{blockers.map((blocker) => (
												<li key={blocker.code}>
													<span>{blocker.message}</span>
												</li>
											))}
										</ul>
										<p className="mla-small mla-muted" style={{ margin: 0 }}>
											归档后仍可在「学习记录」中查看历史学习内容。
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
							删除后无法恢复：这些阶段与任务会从课程中移除，规划状态不会保留。
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							学习档案、知识库教材与其他{subject === "课程" ? "课程" : "计划"}不受影响。
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
