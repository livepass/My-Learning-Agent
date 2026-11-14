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

/**
 * E4.9b — page metadata carries **translation keys**, never display text.
 *
 * `label`, `shortLabel` and `description` are keys under `nav.<page>.*`; the
 * React layer resolves them with `t()` at render time. Keeping keys here (not
 * Chinese strings) means the navigation follows a language switch immediately
 * and a test can assert that every key exists in both locales.
 */
export interface ShellPageMeta {
	id: ShellPage;
	labelKey: string;
	shortLabelKey: string;
	icon: LucideIcon;
	/** One-line description used as the page subtitle. */
	descriptionKey: string;
	/** Reachable (top-bar / URL) but not repeated in the primary navigation. */
	hiddenFromNav?: boolean;
}

export const SHELL_PAGE_META: readonly ShellPageMeta[] = [
	{ id: "today", labelKey: "nav.today.label", shortLabelKey: "nav.today.short", icon: Home, descriptionKey: "nav.today.description" },
	{ id: "learn", labelKey: "nav.learn.label", shortLabelKey: "nav.learn.short", icon: BookOpen, descriptionKey: "nav.learn.description" },
	{ id: "practice", labelKey: "nav.practice.label", shortLabelKey: "nav.practice.short", icon: GraduationCap, descriptionKey: "nav.practice.description" },
	{ id: "profile", labelKey: "nav.profile.label", shortLabelKey: "nav.profile.short", icon: Brain, descriptionKey: "nav.profile.description" },
	{ id: "settings", labelKey: "nav.settingsPage.label", shortLabelKey: "nav.settingsPage.short", icon: Settings, descriptionKey: "nav.settingsPage.description", hiddenFromNav: true },
	// Second-level page: opened from a course card, never a sidebar entry.
	{ id: "course", labelKey: "nav.course.label", shortLabelKey: "nav.course.short", icon: BookOpen, descriptionKey: "nav.course.description", hiddenFromNav: true },
];

/** Course-detail views; the URL keeps the active one so refresh/Back work. */
export const COURSE_VIEWS = ["plan", "library", "records", "overview"] as const;
export type CourseView = (typeof COURSE_VIEWS)[number];

/**
 * Settings tabs. The URL is the source of truth (`?tab=`), so a refresh, a deep
 * link and Back/Forward all land on the same panel. Archived content lives in
 * the single 「归档」 tab (E4.8e): sessions and courses are not shown in the
 * daily lists any more.
 */
/**
 * Settings tabs, in the order the nav renders them.
 *
 * E4.8e merged the two archive tabs into one 「归档」 tab. The old ids stay
 * readable (`LEGACY_SETTINGS_TABS`) so an existing deep link still lands on the
 * archive centre instead of silently falling back to 「通用与外观」.
 */
export const SETTINGS_TABS = ["general", "models", "archive", "about"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Tabs that no longer exist but must keep working as links (E4.8e). */
export const LEGACY_SETTINGS_TABS = ["archived-sessions", "archived-courses"] as const;
export type LegacySettingsTab = (typeof LEGACY_SETTINGS_TABS)[number];

export function isSettingsTab(value: unknown): value is SettingsTab {
	return typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);
}

export function isLegacySettingsTab(value: unknown): value is LegacySettingsTab {
	return typeof value === "string" && (LEGACY_SETTINGS_TABS as readonly string[]).includes(value);
}

/** The tab a URL actually asks for, folding the retired archive tabs into 「归档」. */
export function resolveSettingsTab(value: unknown): SettingsTab | null {
	if (isSettingsTab(value)) return value;
	if (isLegacySettingsTab(value)) return "archive";
	return null;
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
 * E4.8 — what the AI learning workbench should show after navigating.
 *
 * `?page=learn&course=<id>` selects a course without opening (or creating) a
 * conversation. `?session=` names the open conversation and its course is always
 * taken from the server's binding, never from the URL. An explicit `null`
 * clears the parameter; `undefined` keeps the current URL value.
 */
export interface LearnTarget {
	courseId?: string | null;
	session?: string | null;
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
	learn?: LearnTarget,
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
		// A retired archive tab always normalises to the merged 「归档」 tab, so a
		// new link never writes the old parameter back.
		const resolved = settingsTab ? resolveSettingsTab(settingsTab) : null;
		if (resolved) url.searchParams.set("tab", resolved);
		else url.searchParams.delete("tab");
	} else if (page === "learn") {
		url.searchParams.delete(REVIEW_INTENT_PARAM);
		url.searchParams.delete(REVIEW_CONCEPT_PARAM);
		url.searchParams.delete(REVIEW_QUESTION_PARAM);
		url.searchParams.delete(COURSE_VIEW_PARAM);
		// E4.8: the learn page keeps `?course=` — it names the workbench the
		// learner is in. `undefined` preserves whatever the URL already says, so
		// a plain `navigate("learn")` from another page does not silently drop the
		// course on a re-render.
		const courseId = learn && "courseId" in learn
			? learn.courseId
			: url.searchParams.get(COURSE_PARAM);
		if (courseId) url.searchParams.set(COURSE_PARAM, courseId);
		else url.searchParams.delete(COURSE_PARAM);
		const id = learn && "session" in learn
			? learn.session
			: session === undefined ? (sessionsStore.currentSessionId ?? url.searchParams.get("session")) : session;
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
		/** Learn only: which course workbench, and whether to clear the session. */
		learn?: LearnTarget;
	} = {},
): void {
	if (typeof window === "undefined") {
		appStore.applyPage(page);
		return;
	}
	const mode = options.history ?? "push";
	const url = pageUrl(page, options.session, options.review, options.settingsTab, options.course, options.learn);
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
