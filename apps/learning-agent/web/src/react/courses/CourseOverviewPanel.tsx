import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../i18n/index.js";
import type { TFunction } from "i18next";
import { Link2, Loader2, Plus, Target, Unlink } from "lucide-react";
import { Button, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore } from "../../stores/courses-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import type { CourseKnowledgeState } from "../../api/courses.js";

/**
 * 学习概况 (E4.5c / E4.5e).
 *
 * Two different questions are kept apart on purpose:
 *   - task completion — a count of finished plan tasks, computed by the server;
 *   - knowledge mastery — the L1 states whose evidence was recorded in a
 *     course-bound session.
 *
 * The panel never derives a mastery number and never writes one. Goals are
 * created through `learnerStore` (the single goal owner) and then bound here;
 * teaching preferences are shown as personal/shared, not per-course.
 */

/** Shared with CourseLearnerPanel: one state enum, one set of keys. */
const STATE_LABEL_KEY: Record<string, string> = {
	unknown: "course.state.unknown",
	learning: "course.state.learning",
	fragile: "course.state.fragile",
	review_due: "course.state.review_due",
	stable: "course.state.stable",
	misconception: "course.state.misconception",
};

const WEAK_LABELS = new Set(["fragile", "learning", "misconception", "review_due"]);

function formatDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleDateString(currentLocale(), { month: "long", day: "numeric" });
}

function stateLabel(state: CourseKnowledgeState, t: TFunction): string {
	if (!state.state_label) return t("course.state.unknown");
	const key = STATE_LABEL_KEY[state.state_label];
	return key ? t(key) : state.state_label;
}

function isWeak(state: CourseKnowledgeState): boolean {
	return Boolean(state.state_label && WEAK_LABELS.has(state.state_label));
}

/** Bind an existing personal goal to this course (no second goal store). */
function BindGoal({ courseId, boundIds }: { courseId: string; boundIds: Set<string> }) {
	const { t } = useTranslation();
	const profile = useStoreSnapshot(learnerStore, () => learnerStore.profile);
	const pendingAction = useStoreSnapshot(coursesStore, () => coursesStore.pendingAction);
	const [selected, setSelected] = useState("");
	const [newTitle, setNewTitle] = useState("");
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		if (!profile) void learnerStore.load();
	}, [profile]);

	const candidates = (profile?.goals ?? []).filter((goal) => !boundIds.has(goal.goal_id));
	const busy = pendingAction !== null;

	const createAndBind = async () => {
		const title = newTitle.trim();
		if (!title) return;
		try {
			const goal = await learnerStore.addGoal({
				title,
				type: "skill",
				priority: 3,
				status: "active",
				success_criteria: [],
				source: "user_declared",
			});
			const bound = await coursesStore.bindGoal(courseId, goal.goal_id);
			if (bound) {
				setNewTitle("");
				setCreating(false);
			}
		} catch {
			// The store surfaces the failure; keep the typed title for a retry.
		}
	};

	return (
		<div className="mla-stack" style={{ gap: 10 }}>
			{candidates.length > 0 ? (
				<div className="mla-inline">
					<Select value={selected || "none"} disabled={busy} onValueChange={(value) => setSelected(value === "none" ? "" : value)}>
						<SelectTrigger aria-label={t("course.overview.bindGoalAria")}><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectOption value="none" label={t("course.overview.bindGoalPlaceholder")} />
							{candidates.map((goal) => <SelectOption key={goal.goal_id} value={goal.goal_id} label={goal.title} />)}
						</SelectContent>
					</Select>
					<Button
						disabled={!selected || busy}
						onClick={async () => {
							const done = await coursesStore.bindGoal(courseId, selected);
							if (done) setSelected("");
						}}
					>
						<Link2 size={14} />
						{t("course.overview.bindToCourse")}
					</Button>
				</div>
			) : (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{!profile
						? t("course.overview.profileGoalsLoading")
						: (profile.goals?.length ?? 0) === 0
							? t("course.overview.noGoalsInProfile")
							: t("course.overview.allGoalsBound")}
				</p>
			)}

			{creating ? (
				<div className="mla-inline">
					<Input
						value={newTitle}
						autoFocus
						maxLength={120}
						placeholder={t("course.overview.newGoalPlaceholder")}
						disabled={busy}
						onChange={(event) => setNewTitle(event.target.value)}
					/>
					<Button variant="primary" disabled={busy || !newTitle.trim()} onClick={() => void createAndBind()}>
						{t("course.overview.createAndBind")}
					</Button>
					<Button disabled={busy} onClick={() => { setCreating(false); setNewTitle(""); }}>{t("course.overview.cancel")}</Button>
				</div>
			) : (
				<Button size="xs" disabled={busy} onClick={() => setCreating(true)}>
					<Plus size={14} />
					{t("course.overview.newGoal")}
				</Button>
			)}
		</div>
	);
}

export function CourseOverviewPanel({ courseId }: { courseId: string }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(coursesStore, () => ({
		detail: coursesStore.detail,
		courseLearner: coursesStore.courseLearner,
		courseLearnerLoading: coursesStore.courseLearnerLoading,
		courseLearnerError: coursesStore.courseLearnerError,
		courseSettings: coursesStore.courseSettings,
		courseDaily: coursesStore.courseDaily,
		courseDailyLoading: coursesStore.courseDailyLoading,
		pendingAction: coursesStore.pendingAction,
		feedback: coursesStore.feedback,
	}));
	const [minutes, setMinutes] = useState("");
	const [minutesError, setMinutesError] = useState<string | null>(null);

	useEffect(() => {
		void coursesStore.loadCourseLearner(courseId);
		void coursesStore.loadCourseSettings(courseId);
		void coursesStore.loadCourseDaily(courseId);
	}, [courseId]);

	useEffect(() => {
		setMinutes(state.courseSettings?.daily_minutes ? String(state.courseSettings.daily_minutes) : "");
	}, [state.courseSettings?.daily_minutes]);

	const goals = state.courseLearner?.goals ?? [];
	const knowledge = state.courseLearner?.knowledge_states ?? [];
	const weak = useMemo(() => knowledge.filter(isWeak), [knowledge]);
	const boundGoalIds = useMemo(() => new Set(goals.map((goal) => goal.goal_id)), [goals]);
	const progress = state.courseDaily?.courses[0]?.task_progress ?? null;
	const busy = state.pendingAction !== null;

	const saveMinutes = async () => {
		const value = Number(minutes);
		if (!Number.isFinite(value) || value < 5 || value > 720) {
			setMinutesError(t("course.overview.minutesInvalid"));
			return;
		}
		setMinutesError(null);
		await coursesStore.saveSettings(courseId, value);
	};

	return (
		<div className="mla-stack-lg">
			{state.feedback ? (
				<p role={state.feedback.tone === "success" ? "status" : "alert"} className={`mla-notice mla-notice--${state.feedback.tone}`}>
					{state.feedback.message}
				</p>
			) : null}

			{/* ── Goals ─────────────────────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>{t("course.overview.goalsTitle")}</h2>
						<span className="mla-small mla-muted">{t("course.overview.goalsSubtitle")}</span>
					</div>
				</div>
				{state.courseLearnerLoading && !state.courseLearner ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.overview.goalsLoading")}
					</p>
				) : state.courseLearnerError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.courseLearnerError}</p>
				) : goals.length === 0 ? (
					<div className="mla-empty">
						<Target size={26} aria-hidden="true" />
						<strong>{t("course.overview.noGoalsTitle")}</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							{t("course.overview.noGoalsHint")}
						</p>
					</div>
				) : (
					<div className="mla-state-list">
						{goals.map((goal) => (
							<div className="mla-state-row" key={goal.goal_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{goal.title}</strong>
										<span className="mla-badge">
											{goal.status === "active"
												? t("course.status.in_progress")
												: goal.status === "completed"
													? t("course.status.completed")
													: goal.status === "paused"
														? t("course.status.paused")
														: t("course.status.archived")}
										</span>
									</div>
									{goal.success_criteria.length > 0 ? (
										<p>{t("course.overview.successCriteria", { items: goal.success_criteria.join("；") })}</p>
									) : null}
								</div>
								<Button
									size="xs"
									disabled={busy}
									onClick={() => void coursesStore.unbindGoal(courseId, goal.goal_id)}
								>
									<Unlink size={14} />
									{t("course.overview.unbind")}
								</Button>
							</div>
						))}
					</div>
				)}
				<BindGoal courseId={courseId} boundIds={boundGoalIds} />
			</section>

			{/* ── Study budget ──────────────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<h2>{t("course.overview.budgetTitle")}</h2>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.overview.budgetHint")}
				</p>
				<div className="mla-inline">
					<Input
						type="number"
						min={5}
						max={720}
						step={5}
						aria-label={t("course.overview.budgetAria")}
						value={minutes}
						placeholder={t("course.overview.unset")}
						style={{ width: 120 }}
						disabled={busy}
						onChange={(event) => setMinutes(event.target.value)}
					/>
					<span className="mla-small mla-muted">{t("course.overview.minutesPerDay")}</span>
					<Button disabled={busy} onClick={() => void saveMinutes()}>{t("course.overview.save")}</Button>
				</div>
				{minutesError ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{minutesError}</p>
				) : null}
			</section>

			{/* ── Progress vs mastery ───────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>{t("course.overview.progressTitle")}</h2>
						<span className="mla-small mla-muted">{t("course.overview.progressSubtitle")}</span>
					</div>
				</div>

				<div className="mla-fact-grid">
					<div className="mla-fact">
						<strong>{progress ? `${progress.completed}/${progress.total}` : "—"}</strong>
						<span>{t("course.overview.completedTasks")}</span>
					</div>
					<div className="mla-fact">
						<strong>{progress ? `${progress.percent}%` : "—"}</strong>
						<span>{t("course.overview.completionRate")}</span>
					</div>
					<div className="mla-fact">
						<strong>{knowledge.length}</strong>
						<span>{t("course.overview.evidencedConcepts")}</span>
					</div>
					<div className="mla-fact">
						<strong>{weak.length}</strong>
						<span>{t("course.overview.weakConcepts")}</span>
					</div>
				</div>

				{state.courseDailyLoading && !state.courseDaily ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.overview.progressLoading")}
					</p>
				) : null}

				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.overview.progressNote")}
				</p>

				{knowledge.length === 0 ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{t("course.overview.noKnowledge")}
					</p>
				) : (
					<div className="mla-state-list">
						{knowledge.map((item) => (
							<div className="mla-state-row" key={item.concept_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{item.concept_name || t("course.overview.conceptNamePending")}</strong>
										<span className={`mla-badge${isWeak(item) ? " mla-badge--warning" : " mla-badge--success"}`}>
											{stateLabel(item, t)}
										</span>
										{item.review_due_at ? (
											<span className="mla-badge">{t("course.overview.reviewOn", { date: formatDate(item.review_due_at) })}</span>
										) : null}
									</div>
									{item.diagnosis ? <p>{item.diagnosis}</p> : null}
								</div>
								<span className="mla-small mla-muted">{t("course.overview.evidenceCount", { count: item.evidence_ids.length })}</span>
							</div>
						))}
					</div>
				)}

				{state.courseLearner?.unclassified ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{t("course.overview.unclassified", {
							concepts: state.courseLearner.unclassified.knowledge_states,
							goals: state.courseLearner.unclassified.goals,
						})}
					</p>
				) : null}
			</section>

			{/* ── Shared preferences ────────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<h2>{t("course.overview.preferencesTitle")}</h2>
					<span className="mla-badge">{t("course.overview.preferencesShared")}</span>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.overview.preferencesBody")}
				</p>
				{state.courseLearner?.preferences ? (
					<div className="mla-stack" style={{ gap: 8 }}>
						{([
							["course.overview.prefExplanationStyle", state.courseLearner.preferences.explanation_style],
							["course.overview.prefPracticeStyle", state.courseLearner.preferences.practice_style],
							["course.overview.prefFeedbackTone", state.courseLearner.preferences.feedback_tone],
							["course.overview.prefAvoid", state.courseLearner.preferences.avoid],
						] as const).map(([labelKey, values]) => (
							<div className="mla-inline" key={labelKey}>
								<span className="mla-small mla-muted">{t("course.overview.prefLabel", { label: t(labelKey) })}</span>
								{values.length === 0
									? <span className="mla-small mla-muted">{t("course.overview.unset")}</span>
									: values.map((value) => <span className="mla-badge" key={value}>{value}</span>)}
							</div>
						))}
					</div>
				) : null}
			</section>
		</div>
	);
}
