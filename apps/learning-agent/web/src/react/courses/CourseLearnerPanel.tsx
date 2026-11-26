import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, Target } from "lucide-react";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { CourseKnowledgeState } from "../../api/courses.js";
import { Badge } from "../ui/index.js";
import { isWeakKnowledgeState } from "../knowledge-state.js";
import { KnowledgeStateBadge } from "../profile/KnowledgeStateBadge.js";
import { KnowledgeStateFilters } from "../profile/KnowledgeStateFilters.js";
import { KnowledgeProvenance } from "../profile/KnowledgeProvenance.js";
import {
	DEFAULT_KNOWLEDGE_FILTER,
	countKnowledgeFilters,
	filterKnowledgeStates,
	type KnowledgeFilter,
} from "../profile/knowledge-filter.js";
import { formatReviewDate } from "../profile/knowledge-format.js";
import { useCourseErrorText } from "./use-course-error-text.js";

/**
 * 指定课程的学习档案 (E4.5e).
 *
 * Reads `GET /api/courses/:id/learner` and the course-scoped daily snapshot.
 * Only states the server attributes to this course are listed; goals,
 * knowledge and task completion never mix in another course's records.
 * Mastery numbers are displayed, never computed here, and the B2 evidence path
 * remains the only writer of formal mastery.
 */

/**
 * E4.9i-P2-2: the review date format now comes from `react/profile`, the same
 * helper the all-courses row uses, so the two views cannot disagree on it.
 */
function formatDate(iso?: string): string {
	return formatReviewDate(iso, "");
}

function isWeak(state: CourseKnowledgeState): boolean {
	return isWeakKnowledgeState(state.state_label);
}

export function CourseLearnerPanel({ courseId }: { courseId: string }) {
	const courseErrorText = useCourseErrorText();
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
	/**
	 * E4.9i-P2-4: the same filters and the same pure functions as the
	 * all-courses view, over the course-scoped list the server returned.
	 *
	 * This view is read-only, so there is no editor to unmount and no draft to
	 * ask about — the switch is a plain state change. The scope resets to 全部
	 * whenever `courseId` changes, and the 需要关注的知识点 card above keeps
	 * showing the whole course list, not the filtered subset.
	 */
	const [filter, setFilter] = useState<KnowledgeFilter>(DEFAULT_KNOWLEDGE_FILTER);
	useEffect(() => {
		setFilter(DEFAULT_KNOWLEDGE_FILTER);
	}, [courseId]);
	const filterCounts = useMemo(() => countKnowledgeFilters(knowledge), [knowledge]);
	const visibleKnowledge = useMemo(() => filterKnowledgeStates(knowledge, filter), [knowledge, filter]);
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
		return <p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{courseErrorText(state.courseLearnerError)}</p>;
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
										<Badge>
											{goal.status === "active"
												? t("course.status.in_progress")
												: goal.status === "completed"
													? t("course.status.completed")
													: goal.status === "paused"
														? t("course.status.paused")
														: t("course.status.archived")}
										</Badge>
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
					<>
						{/* E4.9i-P2-4: same filters and pure functions as 全部课程. */}
						<div className="mb-3">
							<KnowledgeStateFilters value={filter} counts={filterCounts} onChange={setFilter} />
						</div>
						{visibleKnowledge.length === 0 ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{t("profile.knowledge.filters.empty")}
							</p>
						) : (
							/*
							 * E4.9i-P2-5: `mla-course-knowledge-*` is a modifier on
							 * top of the shared `.mla-state-*` pattern, not a
							 * replacement. `.mla-state-row` is reused by goals,
							 * plans, records and deletion dialogs, so the row keeps
							 * that base and only gains the knowledge-row wrapping.
							 */
							<div className="mla-state-list mla-course-knowledge-list">
								{visibleKnowledge.map((item) => (
									<div className="mla-state-row mla-course-knowledge-row" key={item.concept_id}>
										<div className="mla-course-knowledge-row__identity">
											<div className="mla-inline mla-course-knowledge-row__meta">
												<strong>{item.concept_name || t("course.learner.conceptNamePending")}</strong>
												{/* E4.9i-P2-2: same badge component as the all-courses row. */}
												<KnowledgeStateBadge stateLabel={item.state_label} />
												{item.review_due_at ? (
													<Badge>{t("course.learner.reviewOn", { date: formatDate(item.review_due_at) })}</Badge>
												) : null}
											</div>
											{item.diagnosis ? <p>{item.diagnosis}</p> : null}
											{/*
											 * E4.9i-P2-6 (T05): the same provenance rules as the
											 * all-courses view, over this course's own record — the
											 * fields are never backfilled from the global profile.
											 * No notes here: this row is compact, and the reading view
											 * in 全部课程 carries the full explanation.
											 */}
											<KnowledgeProvenance
												origin={item.origin}
												provenance_unknown={item.provenance_unknown}
												evidenceIds={item.evidence_ids}
												className="mla-course-knowledge-row__provenance"
											/>
										</div>
									</div>
								))}
							</div>
						)}
					</>
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
										<KnowledgeStateBadge stateLabel={item.state_label} />
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
					<Badge>{t("course.learner.preferencesShared")}</Badge>
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
								: values.map((value) => <Badge key={value}>{value}</Badge>)}
						</div>
					))}
				</div>
			</section>
		</div>
	);
}
