import { BookOpen, Brain, GraduationCap, Home, Settings, type LucideIcon } from "lucide-react";
import { appStore, isShellPage, PAGE_PARAM, type ShellPage } from "../../stores/app-store.js";
import { initializeNavigationHistory, syncNavigationHistory } from "../../stores/navigation-history.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import {
	isSafeReviewSessionId,
	parseReviewIntent,
	REVIEW_CONCEPT_PARAM,
	REVIEW_INTENT,
	REVIEW_INTENT_PARAM,
	REVIEW_QUESTION_PARAM,
} from "../../utils/review-intent.js";

/**
 * Five-page shell navigation.
 *
 * The URL query is the single source of truth so browser back / forward,
 * refresh and direct links all work without a router dependency:
 *   `?page=`    which page is shown
 *   `?session=` which conversation is open (only meaningful on the learn page)
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
}

export const SHELL_PAGE_META: readonly ShellPageMeta[] = [
	{ id: "today", label: "今日学习", shortLabel: "今日", icon: Home, description: "从上次停下的地方继续。" },
	{ id: "learn", label: "AI 学习", shortLabel: "学习", icon: BookOpen, description: "围绕一个小目标，与学习助手逐步推进。" },
	{ id: "practice", label: "练习与反馈", shortLabel: "练习", icon: GraduationCap, description: "把看懂了，变成一次能独立完成的回答。" },
	{ id: "profile", label: "我的学习档案", shortLabel: "档案", icon: Brain, description: "了解系统如何认识你，也保留每次学习的真实依据。" },
	{ id: "settings", label: "系统设置", shortLabel: "设置", icon: Settings, description: "配置模型与学习记忆，让学习过程清楚、可靠。" },
];

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
): URL {
	const url = new URL(window.location.href);
	url.searchParams.set(PAGE_PARAM, page);
	url.searchParams.delete("tab");
	if (page === "learn") {
		url.searchParams.delete(REVIEW_INTENT_PARAM);
		url.searchParams.delete(REVIEW_CONCEPT_PARAM);
		url.searchParams.delete(REVIEW_QUESTION_PARAM);
		const id = session === undefined ? (sessionsStore.currentSessionId ?? url.searchParams.get("session")) : session;
		if (id) url.searchParams.set("session", id);
		else url.searchParams.delete("session");
	} else if (page === "practice" && review) {
		url.searchParams.set(REVIEW_INTENT_PARAM, REVIEW_INTENT);
		url.searchParams.set(REVIEW_CONCEPT_PARAM, review.conceptId);
		if (review.questionId) url.searchParams.set(REVIEW_QUESTION_PARAM, review.questionId);
		else url.searchParams.delete(REVIEW_QUESTION_PARAM);
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
	} = {},
): void {
	if (typeof window === "undefined") {
		appStore.applyPage(page);
		return;
	}
	const mode = options.history ?? "push";
	const url = pageUrl(page, options.session, options.review);
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
