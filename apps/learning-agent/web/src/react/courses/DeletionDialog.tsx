import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import { Button, Dialog } from "../ui/index.js";
import { coursesStore } from "../../stores/courses-store.js";
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
function deletionFacts(report: CourseDeletionReport | PlanDeletionReport, t: TFunction): string[] {
	if (isCourseReport(report)) {
		const facts = [
			t("course.deletion.facts.planCount", { count: report.counts.plans }),
			t("course.deletion.facts.stageCount", { count: report.counts.stages }),
			t("course.deletion.facts.taskCount", { count: report.counts.tasks }),
		];
		facts.push(report.has_material
			? t("course.deletion.facts.materialLinked", { count: report.counts.sources })
			: t("course.deletion.facts.noMaterial"));
		if (report.counts.goals > 0) facts.push(t("course.deletion.facts.goalCount", { count: report.counts.goals }));
		if (report.counts.sessions > 0) facts.push(t("course.deletion.facts.sessionCount", { count: report.counts.sessions }));
		if (report.counts.started_tasks > 0) facts.push(t("course.deletion.facts.startedTaskCount", { count: report.counts.started_tasks }));
		return facts;
	}
	const facts = [
		t("course.deletion.facts.stageCount", { count: report.counts.stages }),
		t("course.deletion.facts.taskCount", { count: report.counts.tasks }),
	];
	if (report.counts.completed_tasks > 0) facts.push(t("course.deletion.facts.completedTaskCount", { count: report.counts.completed_tasks }));
	if (report.counts.sessions > 0) facts.push(t("course.deletion.facts.planSessionCount", { count: report.counts.sessions }));
	return facts;
}

/**
 * E4.8d — the evidence a course delete destroys, stated before the learner
 * confirms. Zero counts are printed as zero (not omitted) so "no evidence" is a
 * visible fact rather than an absence the reader has to interpret.
 */
function destroyedEvidenceFacts(report: CourseDeletionReport, t: TFunction): string[] {
	const sessions = report.b2_evidence_sessions ?? 0;
	const attempts = report.b2_evidence_attempts ?? 0;
	return [
		t("course.deletion.evidence.destroyed", { sessions, attempts }),
		t("course.deletion.evidence.mastery", { count: report.mastery_state_count ?? 0 }),
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
function evidenceBadge(detail: CourseDeletionTaskDetail, t: TFunction): { label: string; tone: string } {
	switch (detail.evidence_state) {
		case "b2_evidence":
			return {
				label: detail.b2_evidence_count === null
					? t("course.deletion.badge.b2Evidence")
					: t("course.deletion.badge.b2EvidenceCount", { count: detail.b2_evidence_count }),
				tone: "mla-badge mla-badge--success",
			};
		case "session_bound":
			return { label: t("course.deletion.badge.sessionBound"), tone: "mla-badge mla-badge--warning" };
		default:
			return { label: t("course.deletion.badge.progressOnly"), tone: "mla-badge mla-badge--warning" };
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
	const { t } = useTranslation();
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
				{expanded
					? t("course.deletion.taskList.collapse")
					: t("course.deletion.taskList.expand", { count: details.length })}
			</button>
			{expanded ? (
				<div className="mla-state-list">
					{details.map((detail) => {
						const badge = evidenceBadge(detail, t);
						const where = [detail.plan_title, detail.stage_title].filter(Boolean).join(" · ");
						const updated = formatTime(detail.updated_at);
						const meta = [
							where || t("course.deletion.taskList.unowned"),
							detail.completed_at ? t("course.deletion.taskList.completedAt", { time: formatTime(detail.completed_at) }) : "",
							updated ? t("course.deletion.taskList.updatedAt", { time: updated }) : "",
						].filter(Boolean).join(" · ");
						return (
							<div className="mla-state-row" key={detail.task_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{detail.task_title}</strong>
										<span className="mla-badge">{t(`course.task.${detail.task_status}`)}</span>
										<span className={badge.tone}>{badge.label}</span>
									</div>
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{meta}
									</p>
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{detail.session_ids.length > 0
											? t("course.deletion.taskList.sessionsLinked", { count: detail.session_ids.length })
											: t("course.deletion.taskList.noSessions")}
									</p>
								</div>
								{detail.session_ids.length > 0 ? (
									<Button
										size="xs"
										onClick={() => openLearningSession(detail.session_ids[0])}
									>
										{t("course.deletion.taskList.viewRecord")}
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
	const { t } = useTranslation();
	if (details.length === 0) return null;
	return (
		<div className="mla-stack" style={{ gap: 6 }}>
			<p className="mla-small mla-muted" style={{ margin: 0 }}>
				{t("course.deletion.sessionList.title", { count: details.length })}
			</p>
			<div className="mla-state-list">
				{details.map((detail) => {
					const b2 = detail.b2_evidence_count === null
						? { label: t("course.deletion.sessionList.b2Pending"), tone: "mla-badge mla-badge--warning" }
						: detail.b2_evidence
							? { label: t("course.deletion.sessionList.b2Evidence", { count: detail.b2_evidence_count }), tone: "mla-badge mla-badge--success" }
							: { label: t("course.deletion.sessionList.noB2"), tone: "mla-badge" };
					const archived = detail.archived === null
						? { label: t("course.deletion.sessionList.archivedPending"), tone: "mla-badge mla-badge--warning" }
						: detail.archived
							? { label: t("course.deletion.sessionList.archived"), tone: "mla-badge" }
							: { label: t("course.deletion.sessionList.daily"), tone: "mla-badge" };
					const where = [detail.plan_title, detail.stage_title].filter(Boolean).join(" · ");
					return (
						<div className="mla-state-row" key={detail.session_id}>
							<div style={{ minWidth: 0 }}>
								<div className="mla-inline" style={{ flexWrap: "wrap" }}>
									<strong style={{ overflowWrap: "anywhere" }}>
										{detail.task_title ?? t("course.deletion.sessionList.noTask")}
									</strong>
									{detail.task_status ? (
										<span className="mla-badge">{t(`course.task.${detail.task_status}`)}</span>
									) : null}
									<span className={archived.tone}>{archived.label}</span>
									<span className={b2.tone}>{b2.label}</span>
								</div>
								<p className="mla-small mla-muted" style={{ margin: 0, overflowWrap: "anywhere" }}>
									{t("course.deletion.sessionList.sessionId", { id: detail.session_id })}
								</p>
								{where ? (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>{where}</p>
								) : null}
							</div>
							<Button size="xs" onClick={() => openLearningSession(detail.session_id)}>
								{t("course.deletion.sessionList.viewHistory")}
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
	const { t } = useTranslation();
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
	const subject = target.kind === "course"
		? t("course.deletion.subject.course")
		: t("course.deletion.subject.plan");
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
		<Dialog label={t("course.deletion.dialogLabel", { subject })} className="mla-dialog" onClose={close}>
			<div className="mla-dialog-body">
				{step === "summary" ? (
					<>
						<h2>{t("course.deletion.title", { subject, title: target.title })}</h2>
						{state.loading && !report ? (
							<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
								<Loader2 size={14} className="mla-spin" aria-hidden="true" />
								{t("course.deletion.checking")}
							</p>
						) : state.error ? (
							<>
								<p role="alert" className="mla-notice mla-notice--error">{state.error}</p>
								<div className="mla-dialog-actions">
									<Button onClick={close}>{t("course.deletion.close")}</Button>
									<Button onClick={() => { if (previewTarget) void coursesStore.loadDeletionPreview(previewTarget); }}>
										{t("course.deletion.retry")}
									</Button>
								</div>
							</>
						) : report ? (
							<>
								<p className="mla-text" style={{ margin: 0 }}>{t("course.deletion.willDelete")}</p>
								<ul className="mla-list">
									{deletionFacts(report, t).map((fact) => <li key={fact}><span>{fact}</span></li>)}
								</ul>

								{deletable ? (
									isCourseReport(report) ? (
										<>
											<p className="mla-text" style={{ margin: 0 }}>{t("course.deletion.destroyedTitle")}</p>
											<ul className="mla-list">
												{destroyedEvidenceFacts(report, t).map((fact) => (
													<li key={fact}><span>{fact}</span></li>
												))}
											</ul>
											{/* The same lists as the refusal branch: a confirmed delete
											    should still let the learner inspect exactly which tasks
											    and conversations are about to disappear. */}
											<BlockingTaskList details={report.started_task_details ?? []} />
											<BlockingSessionList details={report.session_details ?? []} />
											<p className="mla-small mla-muted" style={{ margin: 0 }}>
												{t("course.deletion.courseKeeps")}
											</p>
											<p className="mla-small mla-muted" style={{ margin: 0 }}>
												{t("course.deletion.archivedDeletable")}
											</p>
										</>
									) : (
										<p className="mla-small mla-muted" style={{ margin: 0 }}>
											{t("course.deletion.planSafe")}
										</p>
									)
								) : (
									<>
										<p role="alert" className="mla-notice mla-notice--error mla-notice--inline" style={{ margin: 0 }}>
											<AlertTriangle size={14} aria-hidden="true" />
											{isCourseReport(report)
												? t("course.deletion.courseBlocked")
												: t("course.deletion.planBlocked")}
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
												? t("course.deletion.courseNextStep")
												: t("course.deletion.planNextStep")}
										</p>
									</>
								)}

								{writeError ? (
									<p role="alert" className="mla-notice mla-notice--error" style={{ margin: 0 }}>{writeError}</p>
								) : null}

								<div className="mla-dialog-actions">
									<Button onClick={close} disabled={busy}>{t("course.deletion.cancel")}</Button>
									{deletable ? (
										<Button variant="danger" disabled={busy} onClick={() => { coursesStore.clearFeedback(); setStep("confirm"); }}>
											<Trash2 size={14} />
											{t("course.deletion.continueDelete")}
										</Button>
									) : target.kind === "course" ? (
										// A course delete is only refused for a not-yet-archived
										// course or an in-flight start; archiving is the way forward
										// in the first case. The archived-centre caller passes no
										// `onArchive`, so it simply shows the refusal.
										onArchive ? (
											<Button variant="primary" disabled={busy} onClick={() => void archive()}>
												{t("course.deletion.archiveSubject", { subject })}
											</Button>
										) : null
									) : onArchive ? (
										<Button variant="primary" disabled={busy} onClick={() => void archive()}>
											{t("course.deletion.archiveSubject", { subject })}
										</Button>
									) : null}
								</div>
							</>
						) : null}
					</>
				) : (
					<>
						<h2>{t("course.deletion.confirmTitle", { title: target.title })}</h2>
						<p className="mla-text" style={{ margin: 0 }}>
							{target.kind === "course"
								? t("course.deletion.confirmCourseBody")
								: t("course.deletion.confirmPlanBody")}
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{target.kind === "course"
								? t("course.deletion.confirmCourseKeep")
								: t("course.deletion.confirmPlanKeep")}
						</p>
						{writeError ? (
							<p role="alert" className="mla-notice mla-notice--error" style={{ margin: 0 }}>{writeError}</p>
						) : null}
						<div className="mla-dialog-actions">
							<Button onClick={close} disabled={busy}>{t("course.deletion.cancel")}</Button>
							<Button variant="danger" disabled={busy} onClick={() => void remove()}>
								{busy ? <Loader2 size={14} className="mla-spin" /> : <Trash2 size={14} />}
								{t("course.deletion.deleteForever")}
							</Button>
						</div>
					</>
				)}
			</div>
		</Dialog>
	);
}
