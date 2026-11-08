import { EventEmitter } from "./event-emitter.js";
import { isSafeCourseParam } from "../utils/course-params.js";

/**
 * Learning shell UI state.
 *
 * The workbench layout state (sidebar width, workspace panel mode) belonged to
 * the removed full product. What remains is the settings overlay plus the
 * five-page shell navigation and the chat draft, which must survive a page
 * switch without touching conversation persistence.
 */
export type SettingsTab = "general" | "models" | "about";

/**
 * Shell pages. `course` is the second-level course-detail page: reachable from
 * the today page and by URL, never repeated in the primary navigation.
 */
export const SHELL_PAGES = ["today", "learn", "practice", "profile", "settings", "course"] as const;
export type ShellPage = (typeof SHELL_PAGES)[number];

const PAGE_PARAM = "page";

function isShellPage(value: unknown): value is ShellPage {
	return typeof value === "string" && (SHELL_PAGES as readonly string[]).includes(value);
}

interface AppStoreEvents {
	change: void;
}

class AppStoreImpl extends EventEmitter<AppStoreEvents> {
	/** Current shell page; the URL query is the single source of truth. */
	activePage: ShellPage = getInitialPage();
	/** Composer draft owned by the shell so switching pages never loses it. */
	chatDraft = "";

	/** Apply a page without touching history (used when replaying popstate). */
	applyPage(page: ShellPage): void {
		if (this.activePage === page) return;
		this.activePage = page;
		this.emit("change", undefined);
	}

	setChatDraft(draft: string): void {
		if (this.chatDraft === draft) return;
		this.chatDraft = draft;
		this.emit("change", undefined);
	}
}

/** A deep link with `?session=` means "open that conversation", i.e. the learn page. */
function getInitialPage(): ShellPage {
	if (typeof window === "undefined") return "today";
	const params = new URLSearchParams(window.location.search);
	const page = params.get(PAGE_PARAM);
	// `?page=course` is only meaningful with a course id; without one the app
	// falls back to the today page instead of rendering an empty detail view.
	if (page === "course") return isSafeCourseParam(params.get("course")) ? "course" : "today";
	if (isShellPage(page)) return page;
	if (params.get("tab") === "settings") return "settings";
	if (params.get("session")) return "learn";
	return "today";
}

export const appStore = new AppStoreImpl();

export { PAGE_PARAM, isShellPage };

