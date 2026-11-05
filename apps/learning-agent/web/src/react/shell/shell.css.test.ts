import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Scroll ownership is a layout contract that jsdom cannot measure, so it is
 * pinned here: the shell never scrolls, the page main is the scrollport, the
 * chat/profile surfaces opt out and keep their own inner scrollers, and the
 * bottom navigation reserves space instead of floating over content.
 */
const css = await readFile(new URL("./shell.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("shell scroll responsibilities", () => {
	it("pins the shell to the viewport instead of letting it grow", () => {
		const shell = ruleBody(".mla-shell");
		expect(shell).toContain("height: 100dvh");
		expect(shell).toContain("overflow: hidden");
		// A growing shell is exactly what clipped pages below the fold before.
		expect(shell).not.toContain("min-height: 100dvh");
	});

	it("makes the page main the scrollport for content pages", () => {
		const main = ruleBody(".mla-main");
		expect(main).toContain("overflow-y: auto");
		expect(main).toContain("min-height: 0");

		const flush = ruleBody(".mla-main--flush");
		expect(flush).toContain("overflow: hidden");
	});

	it("gives the phone chat page a page scroll so the rail below is reachable", () => {
		const phone = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
		const learn = phone.match(/\.mla-learn\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(learn).toContain("overflow-y: auto");

		// A fixed chat block, not a min-height: the page must be able to scroll past it.
		const card = phone.match(/\.mla-chat-card\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(card).toContain("height: max(");
		expect(card).not.toContain("min-height");
	});

	it("bounds the profile panel so its own overflow can scroll", () => {
		const body = ruleBody(".mla-profile-body");
		expect(body).toContain("flex: 1");
		expect(body).toContain("min-height: 0");
		expect(css).toContain(".mla-profile .mla-profile-body > *");
	});

	it("keeps the bottom navigation in the layout instead of over the content", () => {
		const nav = ruleBody(".mla-bottomnav");
		expect(nav).toContain("flex-shrink: 0");
		expect(nav).not.toContain("position: sticky");
		expect(nav).not.toContain("position: fixed");
	});

	it("keeps the chat list as the inner scroller on every width", () => {
		expect(ruleBody(".mla-chat-scroll")).toContain("overflow-y: auto");
	});

	it("keeps message actions tappable on touch devices", () => {
		const touch = css.match(/@media \(hover: none\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
		expect(touch).toContain(".mla-message-actions");
		expect(touch).toContain("opacity: 1");
		expect(touch).toContain("pointer-events: auto");
	});


	it("keeps the composer outside the message scroller on every width", () => {
		expect(ruleBody(".mla-chat")).toContain("min-height: 0");
		expect(ruleBody(".mla-composer")).toContain("flex-shrink: 0");
		expect(ruleBody(".mla-chat-scroll")).toContain("flex: 1");
	});

});
