// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import i18n, { setLocale } from "./index.js";

/**
 * E4.9g-P2-5-R1 — the document language must follow the UI language.
 *
 * `index.html` ships `lang="zh-CN"`; before this fix nothing updated it, so an
 * English UI still told screen readers "Chinese" for the whole document.
 */
describe("i18n document language", () => {
	afterEach(async () => {
		await i18n.changeLanguage("zh-CN");
		document.documentElement.lang = "zh-CN";
		window.localStorage.clear();
	});

	it("sets <html lang> when switching to English", async () => {
		setLocale("en");
		await i18n.changeLanguage("en");

		expect(document.documentElement.lang).toBe("en");
		expect(i18n.language).toBe("en");
	});

	it("restores <html lang> when switching back to Chinese", async () => {
		setLocale("en");
		await i18n.changeLanguage("en");
		setLocale("zh-CN");
		await i18n.changeLanguage("zh-CN");

		expect(document.documentElement.lang).toBe("zh-CN");
	});

	it("persists the chosen language for the next load", () => {
		setLocale("en");

		expect(window.localStorage.getItem("inno.locale")).toBe("en");
	});
});
