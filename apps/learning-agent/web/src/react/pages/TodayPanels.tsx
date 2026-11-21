import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
	AlertCircle,
	Archive,
	ArrowRight,
	BookOpen,
	CalendarClock,
	CheckCircle2,
	Lightbulb,
	Loader2,
	Target,
} from "lucide-react";
import { Badge, Button, Card, EmptyState } from "../ui/index.js";
import type { CourseDailyPlan, CourseSummary } from "../../api/courses.js";
import type { SessionMeta } from "../../api/sessions.js";
import type { KnowledgeState, LearningGoal, LearningRecommendation, RecommendationSnapshot } from "../../types/learner.js";
import { currentLocale } from "../../i18n/index.js";
import { CourseRow } from "../courses/CourseRow.js";
import { recommendationReasonText } from "./recommendation-copy.js";

/** Shared date format for due reviews; month + day, never a timestamp. */
export function formatTodayDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleDateString(currentLocale(), { month: "long", day: "numeric" });
}

const ACTION_LABEL_KEY: Record<LearningRecommendation["action"], string> = {
	learn: "today.action.learn",
	review: "today.action.review",
	practice: "today.action.practice",
	diagnose: "today.action.diagnose",
	transfer: "today.action.transfer",
};

const KIND_LABEL_KEY: Record<NonNullable<LearningRecommendation["suggested_kind"]>, string> = {
	free_recall: "today.kind.free_recall",
	application: "today.kind.application",
	transfer: "today.kind.transfer",
};

const RESULT_LABEL_KEY: Record<NonNullable<LearningRecommendation["evidence_basis"]["last_result"]>, string> = {
	correct: "today.lastResult.correct",
	partial: "today.lastResult.partial",
	incorrect: "today.lastResult.incorrect",
	unknown: "today.lastResult.unknown",
};

function basisFacts(item: LearningRecommendation, t: TFunction): string[] {
	const basis = item.evidence_basis;
	const facts: string[] = [];
	if (basis.has_active_misconception) facts.push(t("today.basis.activeMisconception"));
	if (basis.review_due_at) {
		facts.push(t("today.basis.reviewAt", {
			date: formatTodayDate(basis.review_due_at) || t("today.basis.reviewDueNow"),
		}));
	}
	facts.push(t("today.basis.evidenceCount", { count: basis.evidence_count }));
	if (basis.last_result) facts.push(t(RESULT_LABEL_KEY[basis.last_result]));
	if (basis.exposure_only) facts.push(t("today.basis.exposureOnly"));
	if (basis.provenance_limited) facts.push(t("today.basis.provenanceLimited"));
	return facts;
}

function actionLabel(item: LearningRecommendation, t: TFunction): string {
	if (item.action === "learn") return t("today.recommendations.goLearn");
	if (item.action === "review") return t("today.startReview");
	return t("today.recommendations.goPractice");
}

/* ── Advice ─────────────────────────────────────────────────── */

export function TodayAdvice({
	snapshot,
	loading,
	error,
	onOpen,
}: {
	snapshot: RecommendationSnapshot | null;
	loading: boolean;
	error: string | null;
	onOpen: (item: LearningRecommendation) => void;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const items = snapshot?.recommendations ?? [];
	const first = items[0];
	const extra = items.slice(1);

	useEffect(() => {
		if (items.length <= 1) setExpanded(false);
	}, [items.length]);

	return (
		<section className="mla-today-section" aria-labelledby="today-advice-title">
			<div className="mla-today-section-head">
				<h2 id="today-advice-title">{t("today.recommendations.title")}</h2>
				<span>{t("today.recommendations.subtitle")}</span>
			</div>

			{loading || (!snapshot && !error) ? (
				<p className="mla-small mla-muted mla-today-inline-note">
					<Lightbulb size={14} aria-hidden="true" />
					{t("today.recommendations.loading")}
				</p>
			) : error ? (
				<p role="alert" className="mla-small mla-today-inline-note mla-today-error-text">{error}</p>
			) : !first ? (
				<EmptyState
					compact
					icon={Lightbulb}
					title={t("today.recommendations.emptyTitle")}
					description={t("today.recommendations.emptyHint")}
				/>
			) : (
				<>
					<div className="mla-today-advice">
						<div className="mla-today-advice-top">
							<span className="mla-today-advice-icon"><Lightbulb size={14} aria-hidden="true" /></span>
							<div className="mla-today-advice-copy">
								<div className="mla-today-advice-line">
									<strong>{first.name_available && first.concept_name ? first.concept_name : t("today.conceptNamePending")}</strong>
									<Badge tone="accent">{t(ACTION_LABEL_KEY[first.action])}</Badge>
									{first.suggested_kind ? (
										<Badge>{t("today.recommendations.suggestedKind", { kind: t(KIND_LABEL_KEY[first.suggested_kind]) })}</Badge>
									) : null}
								</div>
								<p className="mla-today-advice-reason">{recommendationReasonText(t, first)}</p>
								<div className="mla-today-advice-facts">
									{basisFacts(first, t).map((fact) => <span key={fact}>{fact}</span>)}
								</div>
								{!first.name_available ? (
									<p className="mla-today-advice-reason">{t("today.recommendations.nameUnavailable")}</p>
								) : null}
							</div>
							<div className="mla-today-advice-actions">
								{extra.length > 0 ? (
									<Button
										variant="ghost"
										size="xs"
										aria-expanded={expanded}
										onClick={() => setExpanded((value) => !value)}
									>
										{expanded
											? t("today.adviceUi.collapse")
											: t("today.adviceUi.more", { count: extra.length })}
									</Button>
								) : null}
								<Button variant="primary" size="xs" onClick={() => onOpen(first)}>
									{actionLabel(first, t)}
								</Button>
							</div>
						</div>

						{expanded ? (
							<div className="mla-today-advice-extra">
								{extra.map((item) => (
									<div className="mla-today-advice-item" key={item.concept_id}>
										<div>
											<div className="mla-today-advice-line">
												<strong>{item.name_available && item.concept_name ? item.concept_name : t("today.conceptNamePending")}</strong>
												<Badge tone="accent">{t(ACTION_LABEL_KEY[item.action])}</Badge>
											</div>
											<p className="mla-today-advice-reason">{recommendationReasonText(t, item)}</p>
										</div>
										<Button variant="ghost" size="xs" onClick={() => onOpen(item)}>
											{t("today.adviceUi.open")}
										</Button>
									</div>
								))}
							</div>
						) : null}
					</div>
					<p className="mla-small mla-muted mla-today-note">{t("today.plan.notes")}</p>
				</>
			)}
		</section>
	);
}

/* ── Due reviews ────────────────────────────────────────────── */

export function TodayReviews({
	reviews,
	onReview,
	onKnowledge,
}: {
	reviews: KnowledgeState[];
	onReview: (conceptId: string) => void;
	onKnowledge: () => void;
}) {
	const { t } = useTranslation();
	// The card stays compact; the profile owns the complete knowledge list.
	const shown = reviews.slice(0, 2);

	return (
		<Card className="mla-today-reviews" aria-labelledby="today-reviews-title">
			<div className="mla-today-panel-head">
				<h2 id="today-reviews-title">
					<span className="mla-today-panel-icon"><CalendarClock size={14} aria-hidden="true" /></span>
					{t("today.reviews.title")}
				</h2>
				<span>{t("today.reviews.subtitle")}</span>
			</div>

			{reviews.length === 0 ? (
				<EmptyState
					compact
					icon={CheckCircle2}
					title={t("today.reviews.emptyTitle")}
					description={t("today.reviews.emptyHint")}
				/>
			) : (
				<div className="mla-today-review-list">
					{shown.map((state) => (
						<div className="mla-today-review-row" key={state.concept_id}>
							<div>
								<div className="mla-today-review-line">
									<strong>{state.concept_name}</strong>
									<Badge tone="warning">{t("today.action.review")}</Badge>
								</div>
								<p>{state.diagnosis || t("today.reviews.noDiagnosis")}</p>
								<span>{t("today.reviews.dueOn", { date: formatTodayDate(state.review_due_at) })}</span>
							</div>
							<Button size="xs" onClick={() => onReview(state.concept_id)}>{t("today.startReview")}</Button>
						</div>
					))}
				</div>
			)}

			<div className="mla-today-panel-foot">
				<p className="mla-small mla-muted mla-today-note">{t("today.plan.progressVsMastery")}</p>
				<Button variant="ghost" size="xs" onClick={onKnowledge}>
					{t("today.reviewsUi.viewKnowledge")}
					<ArrowRight size={14} />
				</Button>
			</div>
		</Card>
	);
}

/* ── Courses / sessions / goal ──────────────────────────────── */

export function TodayCourses({
	courses,
	dailyByCourse,
	disabled,
	onOpen,
	onArchive,
	onDelete,
}: {
	courses: CourseSummary[];
	dailyByCourse: Map<string, CourseDailyPlan>;
	/** True while any course write is in flight; menu actions must not queue. */
	disabled: boolean;
	onOpen: (courseId: string) => void;
	onArchive: (courseId: string) => void;
	onDelete: (course: CourseSummary) => void;
}) {
	const { t } = useTranslation();
	return (
		<Card className="mla-today-panel" aria-labelledby="today-courses-title">
			<div className="mla-today-panel-head">
				<h2 id="today-courses-title">{t("today.courses.title")}</h2>
				<span>{t("today.coursesUi.count", { count: courses.length })}</span>
			</div>
			<div className="mla-today-course-list">
				{courses.map((course) => (
					<CourseRow
						key={course.course_id}
						course={course}
						daily={dailyByCourse.get(course.course_id)}
						disabled={disabled}
						onOpen={() => onOpen(course.course_id)}
						onArchive={() => onArchive(course.course_id)}
						onDelete={() => onDelete(course)}
					/>
				))}
			</div>
		</Card>
	);
}

export function TodaySessions({
	sessions,
	loading,
	total,
	onOpen,
	onAll,
}: {
	sessions: SessionMeta[];
	loading: boolean;
	total: number;
	onOpen: (id: string) => void;
	onAll: () => void;
}) {
	const { t } = useTranslation();
	return (
		<Card className="mla-today-panel" aria-labelledby="today-sessions-title">
			<div className="mla-today-panel-head">
				<h2 id="today-sessions-title">{t("today.rail.recentSessions")}</h2>
				<span>{t("today.rail.sessionCount", { count: total })}</span>
			</div>
			{loading && sessions.length === 0 ? (
				<p className="mla-small mla-muted mla-today-inline-note">
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					{t("today.rail.sessionsLoading")}
				</p>
			) : sessions.length === 0 ? (
				<EmptyState
					compact
					icon={BookOpen}
					title={t("today.rail.noSessionTitle")}
					description={t("today.rail.noSessionHint")}
				/>
			) : (
				<div className="mla-today-session-list">
					{sessions.map((session) => {
						const name = session.name || t("today.rail.untitledSession");
						const preview = session.preview && session.preview !== name
							? session.preview
							: t("today.rail.messageCount", { count: session.messageCount });
						return (
							<button
								type="button"
								key={session.id}
								className="mla-session-item"
								onClick={() => onOpen(session.id)}
							>
								<strong>{name}</strong>
								<span>{preview}</span>
							</button>
						);
					})}
				</div>
			)}
			<Button variant="ghost" size="xs" onClick={onAll}>
				{t("today.rail.goLearn")}
				<ArrowRight size={14} />
			</Button>
		</Card>
	);
}

export function TodayGoal({
	goal,
	loading,
	error,
	moreGoals,
	onOpen,
}: {
	goal: LearningGoal | undefined;
	loading: boolean;
	error: string | null;
	moreGoals: number;
	onOpen: () => void;
}) {
	const { t } = useTranslation();
	return (
		<Card className="mla-today-panel" aria-labelledby="today-goal-title">
			<div className="mla-today-panel-head">
				<h2 id="today-goal-title">{t("today.rail.currentGoal")}</h2>
				{goal ? <Badge tone="accent">{t("course.status.in_progress")}</Badge> : null}
			</div>
			{goal ? (
				<div className="mla-today-goal">
					<strong>{goal.title}</strong>
					{goal.success_criteria.length > 0 ? (
						<ul className="mla-today-criteria">
							{goal.success_criteria.map((criterion) => (
								<li key={criterion}>
									<Target size={13} aria-hidden="true" />
									<span>{criterion}</span>
								</li>
							))}
						</ul>
					) : null}
					<span className="mla-small mla-muted">
						{moreGoals > 0
							? t("today.rail.moreGoals", { count: moreGoals })
							: t("today.rail.goalsFromProfile")}
					</span>
					<Button variant="ghost" size="xs" onClick={onOpen}>{t("today.rail.viewAllGoals")}</Button>
				</div>
			) : (
				<>
					<p className="mla-small mla-muted mla-today-note">
						{loading ? t("today.rail.profileLoading") : error || t("today.rail.noGoal")}
					</p>
					<Button variant="ghost" size="xs" onClick={onOpen}>{t("today.rail.viewAllGoals")}</Button>
				</>
			)}
		</Card>
	);
}

/* ── Empty / error / loading ────────────────────────────────── */

export function TodayEmpty({
	archivedCount,
	onCreate,
	onArchive,
}: {
	archivedCount: number;
	onCreate: () => void;
	onArchive: () => void;
}) {
	const { t } = useTranslation();
	const archived = archivedCount > 0;
	return (
		<div className="mla-today-empty">
			<span className="mla-today-empty-icon">
				{archived ? <Archive size={22} aria-hidden="true" /> : <BookOpen size={22} aria-hidden="true" />}
			</span>
			<h2>{archived ? t("today.courses.allArchived") : t("today.courses.emptyTitle")}</h2>
			<p>{archived ? t("today.courses.allArchivedHint") : t("today.courses.emptyHint")}</p>
			{!archived ? (
				<ol className="mla-today-empty-steps">
					<li><b>01</b><strong>{t("today.emptyUi.step1Title")}</strong><span>{t("today.emptyUi.step1Hint")}</span></li>
					<li><b>02</b><strong>{t("today.emptyUi.step2Title")}</strong><span>{t("today.emptyUi.step2Hint")}</span></li>
					<li><b>03</b><strong>{t("today.emptyUi.step3Title")}</strong><span>{t("today.emptyUi.step3Hint")}</span></li>
				</ol>
			) : null}
			<div className="mla-today-empty-actions">
				{archived ? (
					<>
						<Button variant="primary" onClick={onArchive}>{t("today.courses.viewArchive")}</Button>
						<Button onClick={onCreate}>{t("today.courses.create")}</Button>
					</>
				) : (
					<Button variant="primary" onClick={onCreate}>{t("today.courses.create")}</Button>
				)}
			</div>
		</div>
	);
}

export function TodayError({
	title,
	message,
	onRetry,
	onArchive,
}: {
	title: string;
	message: string;
	onRetry: () => void;
	onArchive: () => void;
}) {
	const { t } = useTranslation();
	const ref = useRef<HTMLDivElement>(null);
	// A load failure appears after the page mounted; move focus to it so a
	// keyboard user is told what failed instead of tabbing from the top.
	useEffect(() => {
		ref.current?.focus({ preventScroll: true });
	}, []);
	return (
		<div className="mla-today-error" role="alert" tabIndex={-1} ref={ref}>
			<span className="mla-today-empty-icon"><AlertCircle size={22} aria-hidden="true" /></span>
			<h2>{title}</h2>
			<p>{message}</p>
			<div className="mla-today-empty-actions">
				<Button variant="primary" onClick={onRetry}>{t("today.errorUi.retry")}</Button>
				<Button onClick={onArchive}>{t("today.courses.viewArchive")}</Button>
			</div>
		</div>
	);
}

export function TodaySkeleton() {
	const { t } = useTranslation();
	return (
		<div className="mla-today-skeleton" role="status" aria-label={t("today.courses.loading")}>
			<div className="mla-today-sk mla-today-sk--hero" />
			<div className="mla-today-sk-head" />
			<div className="mla-today-sk-grid">
				<div className="mla-today-sk mla-today-sk--card" />
				<div className="mla-today-sk mla-today-sk--card" />
				<div className="mla-today-sk mla-today-sk--card" />
			</div>
			<div className="mla-today-sk-lower">
				<div className="mla-today-sk mla-today-sk--panel" />
				<div className="mla-today-sk mla-today-sk--panel" />
			</div>
		</div>
	);
}
