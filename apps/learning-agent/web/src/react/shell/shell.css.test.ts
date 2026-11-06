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

	it("centres the profile heading and panel on one shared column", () => {
		// The width cap used to sit on the heading (900px) and separately on the
		// panel (860px), so a desktop window showed dead space on both sides and
		// the two left edges did not even line up. The page owns the measure now.
		const profile = ruleBody(".mla-profile");
		expect(profile).toContain("max-width: 1288px");
		expect(profile).toContain("margin: 0 auto");
		expect(ruleBody(".mla-profile-head")).not.toContain("max-width");
		// The panel scrolls but the heading does not; reserving the gutter keeps
		// their left edges aligned once the scrollbar appears.
		expect(css).toContain("scrollbar-gutter: stable");
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

	it("caps the desktop learn layout and keeps composer and messages on one column", () => {
		// 1440px block = 24px page padding * 2 + 1148px card + 20px gap + 224px rail.
		// The card is 1100px column + 24px composer padding * 2, so the message
		// column and the composer share the same edges without extra overrides.
		const learn = ruleBody(".mla-learn");
		expect(learn).toContain("max-width: 1440px");
		expect(learn).toContain("width: 100%");
		expect(learn).toContain("margin-inline: auto");

		const column = ruleBody(".mla-chat-scroll > *");
		expect(column).toContain("max-width: 1100px");
		expect(ruleBody(".mla-composer")).toContain("padding: 12px 24px");

		// Phones keep the full card width rather than the desktop column.
		expect(css).toMatch(/\.mla-chat-scroll > \*\s*\{\s*max-width: 100%;/);
	});

	it("keeps wide markdown tables readable on phones without touching other pages", () => {
		// The table scrolls inside its own wrapper instead of collapsing columns
		// to one character per line; the selector is scoped to the chat message.
		expect(css).toMatch(
			/@container \(max-width: 640px\) \{[\s\S]*?\.mla-message-assistant \.inno-markdown-table\s*\{[^}]*min-width: 560px;/,
		);
	});

});
