// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../../stores/app-store.js";
import { navigate, pageFromLocation, startShellNavigation } from "./navigation.js";

beforeEach(() => {
	window.history.replaceState(null, "", "/");
	appStore.activePage = "today";
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
