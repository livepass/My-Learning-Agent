// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../../stores/app-store.js";
import {
	courseFromLocation,
	courseViewFromLocation,
	navigate,
	pageFromLocation,
	sessionFromLocation,
	startShellNavigation,
} from "./navigation.js";

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

describe("review entry navigation", () => {
	it("writes page, review intent, concept, question and session into one entry", () => {
		const stop = startShellNavigation();

		navigate("practice", {
			history: "push",
			session: "abc.jsonl",
			review: { conceptId: "concept_closure", questionId: "q_1" },
		});

		const url = new URL(window.location.href);
		expect(url.searchParams.get("page")).toBe("practice");
		expect(url.searchParams.get("intent")).toBe("review");
		expect(url.searchParams.get("review_concept_id")).toBe("concept_closure");
		expect(url.searchParams.get("review_question_id")).toBe("q_1");
		expect(url.searchParams.get("session")).toBe("abc.jsonl");
		stop();
	});

	it("strips review parameters when opening plain practice", () => {
		const stop = startShellNavigation();
		window.history.replaceState(null, "", "/?page=practice&intent=review&review_concept_id=concept_a&session=abc.jsonl");

		navigate("practice", { history: "replace" });

		const url = new URL(window.location.href);
		expect(url.searchParams.get("intent")).toBeNull();
		expect(url.searchParams.get("review_concept_id")).toBeNull();
		expect(url.searchParams.get("review_question_id")).toBeNull();
		expect(url.searchParams.get("session")).toBeNull();
		stop();
	});

	it("opens the named session for a valid review deep link", () => {
		window.history.replaceState(null, "", "/?page=practice&intent=review&review_concept_id=concept_a&session=abc.jsonl");
		const stop = startShellNavigation();

		expect(appStore.activePage).toBe("practice");
		expect(store.openSession).toHaveBeenCalledWith("abc.jsonl", { historyMode: "none" });
		stop();
	});

	it("does not open a session for an invalid review link or plain practice", () => {
		window.history.replaceState(null, "", "/?page=practice&intent=review&review_concept_id=../bad&session=abc.jsonl");
		const stopInvalid = startShellNavigation();
		expect(store.openSession).not.toHaveBeenCalled();
		stopInvalid();

		store.openSession.mockClear();
		window.history.replaceState(null, "", "/?page=practice&session=abc.jsonl");
		const stopPlain = startShellNavigation();
		expect(store.openSession).not.toHaveBeenCalled();
		stopPlain();
	});

	it("restores the review session on browser back / forward", () => {
		const stop = startShellNavigation();

		window.history.replaceState(
			window.history.state,
			"",
			"/?page=practice&intent=review&review_concept_id=concept_b&session=def.jsonl",
		);
		window.dispatchEvent(new Event("popstate"));

		expect(appStore.activePage).toBe("practice");
		expect(store.openSession).toHaveBeenCalledWith("def.jsonl", { historyMode: "none" });
		stop();
	});
});

describe("course detail navigation", () => {
	it("treats ?page=course as a page only when it names a course", () => {
		window.history.replaceState(null, "", "/?page=course&course=course_python&view=library");
		expect(pageFromLocation()).toBe("course");
		expect(courseFromLocation()).toBe("course_python");
		expect(courseViewFromLocation()).toBe("library");

		window.history.replaceState(null, "", "/?page=course");
		expect(pageFromLocation()).toBe("today");
	});

	it("defaults an unknown view to the plan tab and rejects a malformed course id", () => {
		window.history.replaceState(null, "", "/?page=course&course=course_math&view=unknown");
		expect(courseViewFromLocation()).toBe("plan");

		window.history.replaceState(null, "", "/?page=course&course=../etc/passwd");
		expect(courseFromLocation()).toBeNull();
		expect(pageFromLocation()).toBe("today");
	});

	it("writes course id and view into one history entry", () => {
		const stop = startShellNavigation();
		const startIndex = (window.history.state as { __innoAgentNavigation?: { index: number } }).__innoAgentNavigation?.index ?? 0;

		navigate("course", { history: "push", course: { id: "course_python", view: "plan" } });

		const url = new URL(window.location.href);
		expect(url.searchParams.get("page")).toBe("course");
		expect(url.searchParams.get("course")).toBe("course_python");
		expect(url.searchParams.get("view")).toBe("plan");
		expect(url.searchParams.get("session")).toBeNull();
		expect(appStore.activePage).toBe("course");
		const endIndex = (window.history.state as { __innoAgentNavigation?: { index: number } }).__innoAgentNavigation?.index;
		expect(endIndex).toBe(startIndex + 1);
		stop();
	});

	it("keeps the course id while switching views", () => {
		const stop = startShellNavigation();
		navigate("course", { history: "push", course: { id: "course_python", view: "plan" } });
		navigate("course", { history: "push", course: { id: "course_python", view: "records" } });

		const url = new URL(window.location.href);
		expect(url.searchParams.get("course")).toBe("course_python");
		expect(url.searchParams.get("view")).toBe("records");
		stop();
	});

	it("restores the course view on browser back / forward", () => {
		const stop = startShellNavigation();
		window.history.replaceState(window.history.state, "", "/?page=course&course=course_math&view=overview");
		window.dispatchEvent(new Event("popstate"));

		expect(appStore.activePage).toBe("course");
		expect(courseFromLocation()).toBe("course_math");
		expect(courseViewFromLocation()).toBe("overview");
		stop();
	});

	it("clears course parameters when leaving the detail page", () => {
		const stop = startShellNavigation();
		navigate("course", { history: "push", course: { id: "course_python", view: "plan" } });
		navigate("today", { history: "push" });

		const url = new URL(window.location.href);
		expect(url.searchParams.get("page")).toBe("today");
		expect(url.searchParams.get("course")).toBeNull();
		expect(url.searchParams.get("view")).toBeNull();
		stop();
	});

	it("does not open a session for a course URL", () => {
		window.history.replaceState(null, "", "/?page=course&course=course_python&view=plan&session=abc.jsonl");
		const stop = startShellNavigation();
		expect(store.openSession).not.toHaveBeenCalled();
		stop();
	});
});
