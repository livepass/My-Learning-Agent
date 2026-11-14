import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../i18n/index.js";
import type { TFunction } from "i18next";
import { AlertTriangle, Loader2, Target } from "lucide-react";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { CourseKnowledgeState } from "../../api/courses.js";

/**
 * 指定课程的学习档案 (E4.5e).
 *
 * Reads `GET /api/courses/:id/learner` and the course-scoped daily snapshot.
 * Only states the server attributes to this course are listed; goals,
 * knowledge and task completion never mix in another course's records.
 * Mastery numbers are displayed, never computed here, and the B2 evidence path
 * remains the only writer of formal mastery.
 */

/** Shared with CourseOverviewPanel: one state enum, one set of keys. */
const STATE_LABEL_KEY: Record<string, string> = {
	unknown: "course.state.unknown",
	learning: "course.state.learning",
	fragile: "course.state.fragile",
	review_due: "course.state.review_due",
	stable: "course.state.stable",
	misconception: "course.state.misconception",
};

const WEAK = new Set(["fragile", "learning", "misconception", "review_due"]);

function stateLabel(state: CourseKnowledgeState, t: TFunction): string {
	if (!state.state_label) return t("course.state.unknown");
	const key = STATE_LABEL_KEY[state.state_label];
	return key ? t(key) : state.state_label;
}

function formatDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleDateString(currentLocale(), { month: "long", day: "numeric" });
}

function isWeak(state: CourseKnowledgeState): boolean {
	return Boolean(state.state_label && WEAK.has(state.state_label));
}

export function CourseLearnerPanel({ courseId }: { courseId: string }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(coursesStore, () => ({
		courseLearner: coursesStore.courseLearner,
		courseLearnerLoading: coursesStore.courseLearnerLoading,
		courseLearnerError: coursesStore.courseLearnerError,
		courseDaily: coursesStore.courseDaily,
		courseDailyLoading: coursesStore.courseDailyLoading,
	}));

	useEffect(() => {
		void coursesStore.loadCourseLearner(courseId);
		void coursesStore.loadCourseDaily(courseId);
	}, [courseId]);

	const view = state.courseLearner;
	const knowledge = view?.knowledge_states ?? [];
	const weak = useMemo(() => knowledge.filter(isWeak), [knowledge]);
	const progress = state.courseDaily?.courses[0]?.task_progress ?? null;
	const daily = state.courseDaily?.courses[0] ?? null;

	if (state.courseLearnerLoading && !view) {
		return (
			<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
				<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.learner.loading")}
			</p>
		);
	}
	if (state.courseLearnerError) {
		return <p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.courseLearnerError}</p>;
	}
	if (!view) return null;

	return (
		<div className="mla-stack-lg">
			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>{view.course.title}</h2>
						<span className="mla-small mla-muted">{t("course.learner.subtitle")}</span>
					</div>
				</div>
				<div className="mla-fact-grid">
					<div className="mla-fact">
						<strong>{progress ? `${progress.completed}/${progress.total}` : "—"}</strong>
						<span>{t("course.learner.completedTasks")}</span>
					</div>
					<div className="mla-fact">
						<strong>{progress ? `${progress.percent}%` : "—"}</strong>
						<span>{t("course.learner.completionRate")}</span>
					</div>
					<div className="mla-fact">
						<strong>{knowledge.length}</strong>
						<span>{t("course.learner.evidencedConcepts")}</span>
					</div>
					<div className="mla-fact">
						<strong>{weak.length}</strong>
						<span>{t("course.learner.weakConcepts")}</span>
					</div>
				</div>
				{state.courseDailyLoading && !daily ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.learner.progressLoading")}
					</p>
				) : null}
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.learner.explanation")}
				</p>
			</section>

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>{t("course.learner.goalsTitle")}</h2>
					<span className="mla-small mla-muted">{t("course.learner.goalCount", { count: view.goals.length })}</span>
				</div>
				{view.goals.length === 0 ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>{t("course.learner.noGoals")}</p>
				) : (
					<div className="mla-state-list">
						{view.goals.map((goal) => (
							<div className="mla-state-row" key={goal.goal_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<Target size={14} aria-hidden="true" />
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
										<p>{t("course.learner.successCriteria", { items: goal.success_criteria.join("；") })}</p>
									) : null}
								</div>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>{t("course.learner.masteryTitle")}</h2>
					<span className="mla-small mla-muted">{t("course.learner.masterySubtitle")}</span>
				</div>
				{knowledge.length === 0 ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{t("course.learner.noMastery")}
					</p>
				) : (
					<div className="mla-state-list">
						{knowledge.map((item) => (
							<div className="mla-state-row" key={item.concept_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{item.concept_name || t("course.learner.conceptNamePending")}</strong>
										<span className={`mla-badge${isWeak(item) ? " mla-badge--warning" : " mla-badge--success"}`}>
											{stateLabel(item, t)}
										</span>
										{item.review_due_at ? (
											<span className="mla-badge">{t("course.learner.reviewOn", { date: formatDate(item.review_due_at) })}</span>
										) : null}
									</div>
									{item.diagnosis ? <p>{item.diagnosis}</p> : null}
								</div>
								<span className="mla-small mla-muted">{t("course.learner.evidenceCount", { count: item.evidence_ids.length })}</span>
							</div>
						))}
					</div>
				)}
			</section>

			{weak.length > 0 ? (
				<section className="mla-card">
					<div className="mla-card-header">
						<h2>{t("course.learner.weakTitle")}</h2>
					</div>
					<div className="mla-state-list">
						{weak.map((item) => (
							<div className="mla-state-row" key={item.concept_id}>
								<div>
									<div className="mla-inline">
										<AlertTriangle size={14} aria-hidden="true" />
										<strong>{item.concept_name || t("course.learner.conceptNamePending")}</strong>
										<span className="mla-badge mla-badge--warning">
											{stateLabel(item, t)}
										</span>
									</div>
									{item.next_actions.length > 0 ? (
										<p>{t("course.learner.suggestions", { items: item.next_actions.join("；") })}</p>
									) : null}
								</div>
							</div>
						))}
					</div>
				</section>
			) : null}

			{view.unclassified.knowledge_states > 0 || view.unclassified.goals > 0 ? (
				<section className="mla-card">
					<h2>{t("course.learner.unclassifiedTitle")}</h2>
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{t("course.learner.unclassifiedBody", {
							concepts: view.unclassified.knowledge_states,
							goals: view.unclassified.goals,
						})}
					</p>
				</section>
			) : null}

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>{t("course.learner.preferencesTitle")}</h2>
					<span className="mla-badge">{t("course.learner.preferencesShared")}</span>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.learner.preferencesBody")}
				</p>
				<div className="mla-stack" style={{ gap: 8 }}>
					{([
						["course.learner.prefExplanationStyle", view.preferences.explanation_style],
						["course.learner.prefPracticeStyle", view.preferences.practice_style],
						["course.learner.prefFeedbackTone", view.preferences.feedback_tone],
						["course.learner.prefAvoid", view.preferences.avoid],
					] as const).map(([labelKey, values]) => (
						<div className="mla-inline" key={labelKey}>
							<span className="mla-small mla-muted">{t("course.learner.prefLabel", { label: t(labelKey) })}</span>
							{values.length === 0
								? <span className="mla-small mla-muted">{t("course.learner.unset")}</span>
								: values.map((value) => <span className="mla-badge" key={value}>{value}</span>)}
						</div>
					))}
				</div>
			</section>
		</div>
	);
}
