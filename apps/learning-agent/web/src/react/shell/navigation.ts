import { BookOpen, Brain, GraduationCap, Home, Settings, type LucideIcon } from "lucide-react";
import { appStore, isShellPage, PAGE_PARAM, type ShellPage } from "../../stores/app-store.js";
import { initializeNavigationHistory, syncNavigationHistory } from "../../stores/navigation-history.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { isSafeCourseParam } from "../../utils/course-params.js";
import {
	isSafeReviewSessionId,
	parseReviewIntent,
	REVIEW_CONCEPT_PARAM,
	REVIEW_INTENT,
	REVIEW_INTENT_PARAM,
	REVIEW_QUESTION_PARAM,
} from "../../utils/review-intent.js";

/**
 * Shell navigation.
 *
 * The URL query is the single source of truth so browser back / forward,
 * refresh and direct links all work without a router dependency:
 *   `?page=`    which page is shown
 *   `?session=` which conversation is open (only meaningful on the learn page)
 *
 * The primary navigation lists four learning pages. Settings is intentionally
 * not repeated there; it stays reachable from the top-bar action and by URL.
 *
 * `sessionsStore` remains the owner of the open conversation; this module only
 * keeps the URL and that owner in step in both directions.
 */

export interface ShellPageMeta {
	id: ShellPage;
	label: string;
	shortLabel: string;
	icon: LucideIcon;
	/** One-line description used as the page subtitle. */
	description: string;
	/** Reachable (top-bar / URL) but not repeated in the primary navigation. */
	hiddenFromNav?: boolean;
}

export const SHELL_PAGE_META: readonly ShellPageMeta[] = [
	{ id: "today", label: "今日学习", shortLabel: "今日", icon: Home, description: "从上次停下的地方继续。" },
	{ id: "learn", label: "AI 学习", shortLabel: "学习", icon: BookOpen, description: "围绕一个小目标，与学习助手逐步推进。" },
	{ id: "practice", label: "练习与反馈", shortLabel: "练习", icon: GraduationCap, description: "把看懂了，变成一次能独立完成的回答。" },
	{ id: "profile", label: "我的学习档案", shortLabel: "档案", icon: Brain, description: "了解系统如何认识你，也保留每次学习的真实依据。" },
	{ id: "settings", label: "系统设置", shortLabel: "设置", icon: Settings, description: "配置模型与学习记忆，让学习过程清楚、可靠。", hiddenFromNav: true },
	// Second-level page: opened from a course card, never a sidebar entry.
	{ id: "course", label: "课程详情", shortLabel: "课程", icon: BookOpen, description: "学习计划、课程知识库、学习记录与学习概况。", hiddenFromNav: true },
];

/** Course-detail views; the URL keeps the active one so refresh/Back work. */
export const COURSE_VIEWS = ["plan", "library", "records", "overview"] as const;
export type CourseView = (typeof COURSE_VIEWS)[number];

/**
 * Settings tabs. The URL is the source of truth (`?tab=`), so a refresh, a deep
 * link and Back/Forward all land on the same panel. Archived content lives here:
 * sessions and courses are not shown in the daily lists any more.
 */
export const SETTINGS_TABS = ["general", "models", "about", "archived-sessions", "archived-courses"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function isSettingsTab(value: unknown): value is SettingsTab {
	return typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);
}

export const SETTINGS_TAB_PARAM = "tab";

export const COURSE_PARAM = "course";
export const COURSE_VIEW_PARAM = "view";

export function isCourseView(value: unknown): value is CourseView {
	return typeof value === "string" && (COURSE_VIEWS as readonly string[]).includes(value);
}

/**
 * The course named by the current URL, if any.
 *
 * `search` lets a mounted page pass the query it subscribed to, so a tab change
 * is not read from a URL that React has not re-rendered for yet.
 */
export function courseFromLocation(search?: string): string | null {
	const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
	const value = new URLSearchParams(query).get(COURSE_PARAM);
	return isSafeCourseParam(value) ? value : null;
}

/** The course-detail view named by the current URL (defaults to the plan). */
export function courseViewFromLocation(search?: string): CourseView {
	const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
	const value = new URLSearchParams(query).get(COURSE_VIEW_PARAM);
	return isCourseView(value) ? value : "plan";
}

/** Entries rendered by the desktop sidebar and the mobile bottom navigation. */
export const NAV_PAGES: readonly ShellPageMeta[] = SHELL_PAGE_META.filter((meta) => !meta.hiddenFromNav);

export function pageMeta(page: ShellPage): ShellPageMeta {
	return SHELL_PAGE_META.find((meta) => meta.id === page) ?? SHELL_PAGE_META[0];
}

/**
 * Build the URL for a page.
 *
 * `session` defaults to the currently open conversation when the target is the
 * learn page or a review entry, so the URL keeps naming what is actually on
 * screen (a refresh therefore restores it). Plain practice / other pages drop
 * the conversation parameter.
 */
function pageUrl(
	page: ShellPage,
	session?: string | null,
	review?: { conceptId: string; questionId?: string } | null,
	settingsTab?: SettingsTab,
	course?: { id: string; view?: CourseView },
): URL {
	const url = new URL(window.location.href);
	url.searchParams.set(PAGE_PARAM, page);
	url.searchParams.delete("tab");
	if (page === "course") {
		url.searchParams.delete("session");
		url.searchParams.delete(REVIEW_INTENT_PARAM);
		url.searchParams.delete(REVIEW_CONCEPT_PARAM);
		url.searchParams.delete(REVIEW_QUESTION_PARAM);
		const id = course?.id ?? url.searchParams.get(COURSE_PARAM);
		if (id) url.searchParams.set(COURSE_PARAM, id);
		else url.searchParams.delete(COURSE_PARAM);
		const view = course?.view ?? (courseViewFromLocation());
		url.searchParams.set(COURSE_VIEW_PARAM, view);
	} else if (page === "settings") {
		url.searchParams.delete("session");
		url.searchParams.delete(REVIEW_INTENT_PARAM);
		url.searchParams.delete(REVIEW_CONCEPT_PARAM);
		url.searchParams.delete(REVIEW_QUESTION_PARAM);
		url.searchParams.delete(COURSE_PARAM);
		url.searchParams.delete(COURSE_VIEW_PARAM);
		if (settingsTab) url.searchParams.set("tab", settingsTab);
		else url.searchParams.delete("tab");
	} else if (page === "learn") {
		url.searchParams.delete(REVIEW_INTENT_PARAM);
		url.searchParams.delete(REVIEW_CONCEPT_PARAM);
		url.searchParams.delete(REVIEW_QUESTION_PARAM);
		url.searchParams.delete(COURSE_PARAM);
		url.searchParams.delete(COURSE_VIEW_PARAM);
		const id = session === undefined ? (sessionsStore.currentSessionId ?? url.searchParams.get("session")) : session;
		if (id) url.searchParams.set("session", id);
		else url.searchParams.delete("session");
	} else if (page === "practice" && review) {
		url.searchParams.set(REVIEW_INTENT_PARAM, REVIEW_INTENT);
		url.searchParams.set(REVIEW_CONCEPT_PARAM, review.conceptId);
		if (review.questionId) url.searchParams.set(REVIEW_QUESTION_PARAM, review.questionId);
		else url.searchParams.delete(REVIEW_QUESTION_PARAM);
		url.searchParams.delete(COURSE_PARAM);
		url.searchParams.delete(COURSE_VIEW_PARAM);
		const id = session === undefined
			? (sessionsStore.currentSessionId ?? url.searchParams.get("session"))
			: session;
		if (id && isSafeReviewSessionId(id)) url.searchParams.set("session", id);
		else url.searchParams.delete("session");
	} else {
		url.searchParams.delete("session");
		url.searchParams.delete(REVIEW_INTENT_PARAM);
		url.searchParams.delete(REVIEW_CONCEPT_PARAM);
		url.searchParams.delete(REVIEW_QUESTION_PARAM);
		url.searchParams.delete(COURSE_PARAM);
		url.searchParams.delete(COURSE_VIEW_PARAM);
	}
	return url;
}

/** Navigate to a page, recording a history entry (or replacing the current one). */
export function navigate(
	page: ShellPage,
	options: {
		history?: "push" | "replace";
		session?: string | null;
		/** Practice only: open the review-preparation flow for this concept. */
		review?: { conceptId: string; questionId?: string } | null;
		/** Settings only: open a specific tab (e.g. "models" from the composer). */
		settingsTab?: SettingsTab;
		/** Course detail only: which course and which of its four views. */
		course?: { id: string; view?: CourseView };
	} = {},
): void {
	if (typeof window === "undefined") {
		appStore.applyPage(page);
		return;
	}
	const mode = options.history ?? "push";
	const url = pageUrl(page, options.session, options.review, options.settingsTab, options.course);
	if (mode !== "replace" || url.href !== window.location.href) {
		syncNavigationHistory(url, mode);
	}
	appStore.applyPage(page);
}

/** Read the page from the current URL (used on popstate and first mount). */
export function pageFromLocation(): ShellPage {
	if (typeof window === "undefined") return "today";
	const params = new URLSearchParams(window.location.search);
	const page = params.get(PAGE_PARAM);
	// `?page=course` without a usable id is not a page: it falls back to today.
	if (page === "course") return isSafeCourseParam(params.get(COURSE_PARAM)) ? "course" : "today";
	if (isShellPage(page)) return page;
	if (params.get("session")) return "learn";
	return "today";
}

/** The conversation named by the current URL, if any. */
export function sessionFromLocation(): string | null {
	if (typeof window === "undefined") return null;
	const value = new URLSearchParams(window.location.search).get("session");
	return value ? value : null;
}

/**
 * Bind the URL's `?session=` to the conversation store.
 *
 * Learn pages always restore their conversation. Practice pages restore one only
 * for a valid review intent: a plain practice URL must not silently reopen a
 * chat on refresh. Only ever *opens*: a URL without a session never closes the
 * current one, because in-app page switches intentionally keep the conversation
 * in memory while leaving the parameter off other pages.
 */
function syncSessionFromLocation(): void {
	const page = pageFromLocation();
	const review = page === "practice"
		? parseReviewIntent(typeof window === "undefined" ? "" : window.location.search)
		: null;
	if (page !== "learn" && !(page === "practice" && review)) return;
	const wanted = sessionFromLocation();
	if (!wanted) return;
	// The review path is a deep link, so it accepts only a safe session id.
	if (page === "practice" && !isSafeReviewSessionId(wanted)) return;
	if (sessionsStore.currentSessionId === wanted) return;
	// `openingSessionId` guards React StrictMode's double effect run and any
	// in-flight open, so one URL never triggers two opens (or two history writes).
	if (sessionsStore.openingSessionId === wanted) return;
	// The URL already carries the id: opening must not rewrite it, so a refresh
	// or a back/forward entry keeps the exact address the user arrived on.
	void sessionsStore.openSession(wanted, { historyMode: "none" });
}

/**
 * Install the popstate listener and seed the history trail. Returns a cleanup
 * function so tests and hot reload do not stack listeners.
 */
export function startShellNavigation(): () => void {
	if (typeof window === "undefined") return () => undefined;
	initializeNavigationHistory();
	// Normalise the first entry so the URL always states the active page.
	const initial = pageFromLocation();
	if (new URL(window.location.href).searchParams.get(PAGE_PARAM) !== initial) {
		syncNavigationHistory(pageUrl(initial), "replace");
	}
	appStore.applyPage(initial);
	syncSessionFromLocation();
	const onPopState = () => {
		appStore.applyPage(pageFromLocation());
		syncSessionFromLocation();
	};
	window.addEventListener("popstate", onPopState);
	return () => window.removeEventListener("popstate", onPopState);
}
