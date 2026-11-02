import { BookOpen, Brain, GraduationCap, Home, Settings, type LucideIcon } from "lucide-react";
import { appStore, isShellPage, PAGE_PARAM, type ShellPage } from "../../stores/app-store.js";
import { initializeNavigationHistory, syncNavigationHistory } from "../../stores/navigation-history.js";

/**
 * Five-page shell navigation.
 *
 * The URL query (`?page=…`) is the single source of truth so browser back /
 * forward, refresh and direct links all work without a router dependency. The
 * existing `?session=` parameter is preserved: switching page never drops the
 * open conversation, and a session deep link implies the learn page.
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

function pageUrl(page: ShellPage): URL {
	const url = new URL(window.location.href);
	url.searchParams.set(PAGE_PARAM, page);
	// Keep the open session attached to the learn page; other pages drop the
	// parameter so a refresh of e.g. today does not silently reopen chat.
	if (page !== "learn") url.searchParams.delete("session");
	url.searchParams.delete("tab");
	return url;
}

/** Navigate to a page, recording a history entry (or replacing the current one). */
export function navigate(page: ShellPage, options: { history?: "push" | "replace" } = {}): void {
	if (typeof window === "undefined") {
		appStore.applyPage(page);
		return;
	}
	const mode = options.history ?? "push";
	const url = pageUrl(page);
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
	const onPopState = () => appStore.applyPage(pageFromLocation());
	window.addEventListener("popstate", onPopState);
	return () => window.removeEventListener("popstate", onPopState);
}
