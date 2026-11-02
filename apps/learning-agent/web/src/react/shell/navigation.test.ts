// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../../stores/app-store.js";
import { navigate, pageFromLocation, sessionFromLocation, startShellNavigation } from "./navigation.js";

/**
 * The real `sessionsStore.openSession` sets `currentSessionId` and
 * `openingSessionId` synchronously before it awaits anything. The fake mirrors
 * that, so the guard that makes React StrictMode's double effect safe is
 * exercised rather than bypassed.
 */
const fake = vi.hoisted(() => {
	const store = {
		currentSessionId: null as string | null,
		openingSessionId: null as string | null,
		openSession: vi.fn<(id: string, options?: { historyMode?: string }) => Promise<void>>(async (id: string) => {
			store.currentSessionId = id;
			store.openingSessionId = id;
		}),
	};
	return { sessionsStore: store };
});

vi.mock("../../stores/sessions-store.js", () => ({ sessionsStore: fake.sessionsStore }));

const store = fake.sessionsStore;

beforeEach(() => {
	window.history.replaceState(null, "", "/");
	appStore.activePage = "today";
	store.currentSessionId = null;
	store.openingSessionId = null;
	store.openSession.mockClear();
	store.openSession.mockImplementation(async (id: string) => {
		store.currentSessionId = id;
		store.openingSessionId = id;
	});
});

describe("shell navigation", () => {
	it("reads the page from the URL and treats ?session= as the learn page", () => {
		window.history.replaceState(null, "", "/?page=practice");
		expect(pageFromLocation()).toBe("practice");

		window.history.replaceState(null, "", "/?session=abc.jsonl");
		expect(pageFromLocation()).toBe("learn");

		window.history.replaceState(null, "", "/");
		expect(pageFromLocation()).toBe("today");
	});

	it("pushes a URL entry and updates the active page", () => {
		const stop = startShellNavigation();
		navigate("profile", { history: "push" });
		expect(new URL(window.location.href).searchParams.get("page")).toBe("profile");
		expect(appStore.activePage).toBe("profile");
		stop();
	});

	it("replace mode does not grow the in-app history trail", () => {
		const stop = startShellNavigation();
		navigate("practice", { history: "replace" });
		const first = (window.history.state as { __innoAgentNavigation?: { index: number } }).__innoAgentNavigation?.index;
		navigate("settings", { history: "replace" });
		const second = (window.history.state as { __innoAgentNavigation?: { index: number } }).__innoAgentNavigation?.index;
		expect(second).toBe(first);
		expect(appStore.activePage).toBe("settings");
		stop();
	});

	it("applies the page on browser back / forward", () => {
		const stop = startShellNavigation();
		navigate("today", { history: "push" });
		expect(appStore.activePage).toBe("today");

		// The browser restores the previous entry's URL, then fires popstate.
		window.history.replaceState(window.history.state, "", "/?page=learn");
		window.dispatchEvent(new Event("popstate"));
		expect(appStore.activePage).toBe("learn");
		stop();
	});

	it("keeps the conversation parameter out of non-learn pages", () => {
		const stop = startShellNavigation();
		window.history.replaceState(null, "", "/?page=learn&session=abc.jsonl");
		navigate("today", { history: "push" });
		const url = new URL(window.location.href);
		expect(url.searchParams.get("page")).toBe("today");
		expect(url.searchParams.get("session")).toBeNull();
		stop();
	});
});

describe("deep links and history restore the conversation", () => {
	it("opens the session named by a direct link on first start", () => {
		window.history.replaceState(null, "", "/?page=learn&session=abc.jsonl");
		const stop = startShellNavigation();

		expect(appStore.activePage).toBe("learn");
		expect(sessionFromLocation()).toBe("abc.jsonl");
		// The URL already carries the id, so opening must not rewrite history.
		expect(store.openSession).toHaveBeenCalledTimes(1);
		expect(store.openSession).toHaveBeenCalledWith("abc.jsonl", { historyMode: "none" });
		stop();
	});

	it("does not open anything for a page without a session", () => {
		window.history.replaceState(null, "", "/?page=today");
		const stop = startShellNavigation();
		expect(store.openSession).not.toHaveBeenCalled();
		stop();
	});

	it("is a no-op when the linked session is already open", () => {
		store.currentSessionId = "abc.jsonl";
		window.history.replaceState(null, "", "/?page=learn&session=abc.jsonl");
		const stop = startShellNavigation();
		expect(store.openSession).not.toHaveBeenCalled();
		stop();
	});

	it("opens once even when the mount effect runs twice (StrictMode)", () => {
		window.history.replaceState(null, "", "/?page=learn&session=abc.jsonl");
		const stopFirst = startShellNavigation();
		stopFirst();
		const stopSecond = startShellNavigation();
		expect(store.openSession).toHaveBeenCalledTimes(1);
		stopSecond();
	});

	it("restores the session when the browser goes back to a session entry", () => {
		const stop = startShellNavigation();

		window.history.replaceState(window.history.state, "", "/?page=learn&session=def.jsonl");
		window.dispatchEvent(new Event("popstate"));

		expect(appStore.activePage).toBe("learn");
		expect(store.openSession).toHaveBeenCalledWith("def.jsonl", { historyMode: "none" });
		stop();
	});

	it("never closes the open conversation for a learn URL without a session", () => {
		store.currentSessionId = "abc.jsonl";
		const stop = startShellNavigation();

		window.history.replaceState(window.history.state, "", "/?page=learn");
		window.dispatchEvent(new Event("popstate"));

		// In-app page switches intentionally drop `?session=`; returning to learn
		// must keep the conversation the user had, not reset it.
		expect(store.openSession).not.toHaveBeenCalled();
		expect(store.currentSessionId).toBe("abc.jsonl");
		stop();
	});

	it("writes page and session as one history entry", () => {
		const stop = startShellNavigation();
		const startIndex = (window.history.state as { __innoAgentNavigation?: { index: number } }).__innoAgentNavigation?.index ?? 0;

		navigate("learn", { history: "push", session: "abc.jsonl" });

		const url = new URL(window.location.href);
		expect(url.searchParams.get("page")).toBe("learn");
		expect(url.searchParams.get("session")).toBe("abc.jsonl");
		const endIndex = (window.history.state as { __innoAgentNavigation?: { index: number } }).__innoAgentNavigation?.index;
		// Today → learn(session) is exactly one step, so Back returns to today.
		expect(endIndex).toBe(startIndex + 1);
		stop();
	});

	it("keeps naming the open conversation when navigating back to learn", () => {
		store.currentSessionId = "kept.jsonl";
		const stop = startShellNavigation();
		navigate("today", { history: "push" });
		navigate("learn", { history: "push" });

		const url = new URL(window.location.href);
		expect(url.searchParams.get("page")).toBe("learn");
		expect(url.searchParams.get("session")).toBe("kept.jsonl");
		stop();
	});
});
