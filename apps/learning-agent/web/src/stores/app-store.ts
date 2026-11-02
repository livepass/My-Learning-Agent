import { EventEmitter } from "./event-emitter.js";

/**
 * Learning shell UI state.
 *
 * The workbench layout state (sidebar width, workspace panel mode) belonged to
 * the removed full product. What remains is the settings overlay plus the
 * five-page shell navigation and the chat draft, which must survive a page
 * switch without touching conversation persistence.
 */
export type SettingsTab = "general" | "models" | "about";

export const SHELL_PAGES = ["today", "learn", "practice", "profile", "settings"] as const;
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
	if (isShellPage(page)) return page;
	if (params.get("tab") === "settings") return "settings";
	if (params.get("session")) return "learn";
	return "today";
}

export const appStore = new AppStoreImpl();

export { PAGE_PARAM, isShellPage };

