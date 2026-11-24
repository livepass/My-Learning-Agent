import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	Archive, ArrowLeft, BookOpen, ChevronDown, ChevronRight, FolderOpen, Lightbulb, Loader2,
	PencilLine, Plus, Repeat, RotateCcw,
} from "lucide-react";
import type { CourseSummary } from "../../../api/courses.js";
import type { SessionMeta } from "../../../api/sessions.js";
import { isDailyVisible } from "../../../utils/session-visibility.js";
import type { CourseErrorRef } from "../../../stores/courses-store.js";
import { Badge, Button } from "../../ui/index.js";

/**
 * E4.9g-P2-1 — the display-only start surfaces of the AI learning page.
 *
 * Two modes share one component because they are the same decision point: what
 * should the learner start from in this course?
 *
 * - `welcome`: course picker, course greeting, quick starts, previous
 *   conversations, unclassified history and the archive entry.
 * - `empty`: the three starter prompts above an empty conversation's composer.
 *
 * Quick starts and starters only call `onFillDraft`. They never send a message,
 * create a conversation or touch `learning/start`; the page owns those actions.
 */

type QuickAction = {
	id: string;
	labelKey: string;
	icon: typeof Lightbulb;
	promptKey: string;
};

/** E4.8f: deliberately short; each fills a complete, sendable sentence. */
const QUICK_ACTIONS: QuickAction[] = [
	{ id: "explain", labelKey: "learn.quick.explain.label", icon: Lightbulb, promptKey: "learn.quick.explain.prompt" },
	{ id: "practice", labelKey: "learn.quick.practice.label", icon: PencilLine, promptKey: "learn.quick.practice.prompt" },
	{ id: "review", labelKey: "learn.quick.review.label", icon: Repeat, promptKey: "learn.quick.review.prompt" },
];

/**
 * E4.9g-P2-4 — the most recent conversation that can be resumed.
 *
 * Only data the page already has: `SessionMeta.updatedAt`. Archived rows are
 * excluded (they are read-only history), and an unparsable timestamp never
 * wins. Ties keep the first row in list order, so the result is stable rather
 * than dependent on `Array.sort` details.
 */
export function mostRecentConversation(sessions: SessionMeta[]): SessionMeta | null {
	let best: SessionMeta | null = null;
	let bestTime = Number.NEGATIVE_INFINITY;
	for (const session of sessions) {
		if (session.archived) continue;
		const parsed = Date.parse(session.updatedAt);
		if (!Number.isFinite(parsed)) continue;
		if (parsed > bestTime) {
			best = session;
			bestTime = parsed;
		}
	}
	return best;
}

/** Starter questions for an empty conversation; they only fill the composer. */
const STARTER_PROMPTS: Array<{ id: string; labelKey: string; promptKey: string }> = [
	{ id: "overview", labelKey: "learn.empty.start.overview.label", promptKey: "learn.empty.start.overview.prompt" },
	{ id: "example", labelKey: "learn.empty.start.example.label", promptKey: "learn.empty.start.example.prompt" },
	{ id: "check", labelKey: "learn.empty.start.check.label", promptKey: "learn.empty.start.check.prompt" },
];

function shortDate(time: string, locale: string): string | null {
	const parsed = Date.parse(time);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed).toLocaleDateString(locale, { month: "long", day: "numeric" });
}

type SharedProps = {
	/** Fills the composer only. Never sends or creates a conversation. */
	onFillDraft: (text: string) => void;
};

type WelcomeProps = SharedProps & {
	mode: "welcome";
	/** Renders the shared session row; keeps row actions in the page. */
	renderSessionRow: (session: SessionMeta) => ReactNode;
	course: CourseSummary | null;
	coursesLoading: boolean;
	coursesError: CourseErrorRef | null;
	activeCourses: CourseSummary[];
	archivedCourses: CourseSummary[];
	/** All sessions, used only for the "last studied" date on course cards. */
	sessions: SessionMeta[];
	courseConversations: SessionMeta[];
	unclassifiedSessions: SessionMeta[];
	showHistory: boolean;
	showUnclassified: boolean;
	archiveEntryCount: number;
	onSelectCourse: (courseId: string) => void;
	onCreateCourse: () => void;
	onRetryCourses: () => void;
	onToggleHistory: () => void;
	onToggleUnclassified: () => void;
	onOpenArchive: () => void;
	onSwitchCourse: () => void;
	/** Opens the conversation through the page's existing `openSession` path. */
	onResumeRecent: (session: SessionMeta) => void;
};

type EmptyProps = SharedProps & {
	mode: "empty";
	courseTitle: string | null;
};

export type LearnStartPanelProps = WelcomeProps | EmptyProps;

export function LearnStartPanel(props: LearnStartPanelProps) {
	const { t, i18n } = useTranslation();

	if (props.mode === "empty") {
		const title = props.courseTitle;
		return (
			<div className="mla-empty-starters">
				<div className="mla-empty-starters-head">
					<strong>
						{title
							? t("learn.empty.titleWithCourse", { title })
							: t("learn.empty.title")}
					</strong>
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{title
							? t("learn.empty.descriptionWithCourse")
							: t("learn.empty.description")}
					</p>
				</div>
				<div className="mla-empty-starter-list" role="group" aria-label={t("learn.empty.group")}>
					{STARTER_PROMPTS.map((starter) => (
						<button
							type="button"
							key={starter.id}
							className="mla-empty-starter"
							onClick={() => props.onFillDraft(
								t(starter.promptKey, {
									title: title ?? t("learn.empty.thisCourse"),
								}),
							)}
						>
							{t(starter.labelKey)}
						</button>
					))}
				</div>
			</div>
		);
	}

	const {
		course,
		activeCourses,
		archivedCourses,
		coursesLoading,
		coursesError,
		courseConversations,
		unclassifiedSessions,
	} = props;
	// The original page treated "no course records at all" as loading. Archived
	// courses are records too: while a refresh runs with only archived courses,
	// the empty text and the create entry must stay visible instead of flipping
	// back to the first-load spinner.
	const loadingCourses = coursesLoading
		&& activeCourses.length === 0
		&& archivedCourses.length === 0;
	const composerActive = course?.status === "in_progress";
	/** The one conversation worth a one-click resume; the rest stay listed below. */
	const recent = mostRecentConversation(courseConversations);

	/** One course card on the welcome home. Selecting never starts a chat. */
	const coursePickCard = (item: CourseSummary) => {
		const lastStudied = props.sessions.reduce<string | null>((latest, session) => {
			if (session.course?.course_id !== item.course_id || !isDailyVisible(session)) return latest;
			const parsed = Date.parse(session.updatedAt);
			if (!Number.isFinite(parsed)) return latest;
			if (!latest || parsed > Date.parse(latest)) return session.updatedAt;
			return latest;
		}, null);
		const last = lastStudied ? shortDate(lastStudied, i18n.language) : null;
		return (
			<button
				type="button"
				className="mla-course-pick"
				key={item.course_id}
				aria-label={t("learn.welcome.selectCourse", { title: item.title })}
				onClick={() => props.onSelectCourse(item.course_id)}
			>
				<span className="mla-course-pick-title">
					<BookOpen size={16} aria-hidden="true" />
					<strong>{item.title}</strong>
				</span>
				<span className="mla-course-pick-meta">
					<Badge tone={item.status === "in_progress" ? "accent" : "neutral"}>
						{t(`course.status.${item.status}`)}
					</Badge>
					<span>{t("learn.welcome.conversationCount", { count: item.counts.sessions })}</span>
					{last ? <span>{t("learn.welcome.lastStudied", { date: last })}</span> : null}
				</span>
				<span className="mla-course-pick-hint">
					{item.status === "paused"
						? t("learn.welcome.hint.paused")
						: item.status === "completed"
							? t("learn.welcome.hint.completed")
							: t("learn.welcome.hint.active")}
				</span>
			</button>
		);
	};

	const coursePicker = (
		<div className="mla-welcome-courses">
			{loadingCourses ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					{t("learn.welcome.loadingCourses")}
				</p>
			) : null}
			{!loadingCourses && coursesError ? (
				<div className="mla-welcome-error">
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
						{t("learn.welcome.courseError", { message: coursesError })}
					</p>
					<Button size="xs" onClick={props.onRetryCourses}>
						<RotateCcw size={14} aria-hidden="true" />
						{t("learn.welcome.retry")}
					</Button>
				</div>
			) : null}
			{!loadingCourses ? (
				<div className="mla-course-picker">
					{activeCourses.map(coursePickCard)}
					<button
						type="button"
						className="mla-course-pick mla-course-pick--create"
						onClick={props.onCreateCourse}
					>
						<span className="mla-course-pick-title">
							<Plus size={16} aria-hidden="true" />
							<strong>{t("learn.welcome.createCourse")}</strong>
						</span>
						<span className="mla-course-pick-hint">{t("learn.welcome.createCourseHint")}</span>
					</button>
				</div>
			) : null}
			{!loadingCourses && !coursesError && activeCourses.length === 0 ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{archivedCourses.length > 0
						? t("learn.welcome.emptyAllArchived")
						: t("learn.welcome.emptyNoCourses")}
				</p>
			) : null}
		</div>
	);

	return (
		<div className="mla-welcome">
			<header className="mla-welcome-hero">
				<h1>
					{course
						? t("learn.welcome.titleWithCourse", { title: course.title })
						: t("learn.welcome.title")}
				</h1>
				{course ? (
					/*
					 * UI-C01: the heading above already names the course
					 * (`titleWithCourse`), so the meta line only adds the status and the
					 * start hint instead of repeating the title a second time.
					 */
					<p className="mla-welcome-course-meta">
						<Badge tone={course.status === "in_progress" ? "accent" : "neutral"}>
							{t(`course.status.${course.status}`)}
						</Badge>
						<span>{t("learn.welcome.chooseStart")}</span>
					</p>
				) : (
					<p>{t("learn.welcome.selectFirst")}</p>
				)}
			</header>

			{course ? (
				<>
					{composerActive ? (
						<div className="mla-quick-grid" role="group" aria-label={t("learn.quick.group")}>
							{QUICK_ACTIONS.map((action) => {
								const Icon = action.icon;
								return (
									<button
										type="button"
										className="mla-quick-card"
										key={action.id}
										onClick={() => props.onFillDraft(
											t(action.promptKey, { title: course.title }),
										)}
									>
										<Icon size={18} aria-hidden="true" />
										<span>{t(action.labelKey)}</span>
									</button>
								);
							})}
						</div>
					) : null}
					{recent ? (
						<div className="mla-welcome-recent">
							<span className="mla-overline">{t("learn.welcome.recentLabel")}</span>
							<button
								type="button"
								className="mla-welcome-recent-card"
								aria-label={t("learn.welcome.resumeRecent", { name: recent.name || t("learn.history.unnamed") })}
								onClick={() => props.onResumeRecent(recent)}
							>
								<span className="mla-welcome-recent-copy">
									<strong>{recent.name || t("learn.history.unnamed")}</strong>
									<span>{recent.preview || t("learn.history.noMessages")}</span>
								</span>
								<ChevronRight size={16} aria-hidden="true" />
							</button>
						</div>
					) : null}
					{courseConversations.length > 0 ? (
						<div className="mla-welcome-history">
							<Button
								variant="ghost"
								size="xs"
								aria-expanded={props.showHistory}
								onClick={props.onToggleHistory}
							>
								{props.showHistory
									? <ChevronDown size={14} aria-hidden="true" />
									: <ChevronRight size={14} aria-hidden="true" />}
								{t("learn.welcome.continuePrevious", { count: courseConversations.length })}
							</Button>
							{props.showHistory ? (
								<div className="mla-welcome-history-list">
									{courseConversations.map(props.renderSessionRow)}
								</div>
							) : null}
						</div>
					) : null}
				</>
			) : (
				coursePicker
			)}

			<footer className="mla-welcome-footer">
				{course ? (
					<Button variant="ghost" size="xs" onClick={props.onSwitchCourse}>
						<ArrowLeft size={14} aria-hidden="true" />
						{t("learn.welcome.switchCourse")}
					</Button>
				) : null}
				{unclassifiedSessions.length > 0 ? (
					<Button
						variant="ghost"
						size="xs"
						aria-expanded={props.showUnclassified}
						onClick={props.onToggleUnclassified}
					>
						<Archive size={14} aria-hidden="true" />
						{t("learn.welcome.unclassifiedHistory", { count: unclassifiedSessions.length })}
					</Button>
				) : null}
				{props.archiveEntryCount > 0 ? (
					<Button variant="ghost" size="xs" onClick={props.onOpenArchive}>
						<FolderOpen size={14} aria-hidden="true" />
						{t("learn.welcome.viewArchive")}
					</Button>
				) : null}
			</footer>

			{props.showUnclassified ? (
				<div className="mla-welcome-history-list">
					{unclassifiedSessions.map(props.renderSessionRow)}
				</div>
			) : null}
		</div>
	);
}
