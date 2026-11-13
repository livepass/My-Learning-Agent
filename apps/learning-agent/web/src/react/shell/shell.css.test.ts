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

	it("gives the phone chat page a page scroll so the status panel below is reachable", () => {
		const phone = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
		const learn = phone.match(/\.mla-learn\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(learn).toContain("overflow-y: auto");

		// E4.8: the card fills the workbench height the shell already measured,
		// so the composer sits above the bottom navigation instead of guessing
		// `100dvh - N` (which clipped it). The min-height keeps a very short
		// viewport scrollable to the status panel below.
		const card = phone.match(/\.mla-chat-card\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(card).toContain("height: 100%");
		expect(card).toContain("min-height: 380px");
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
		// E4.8: 1600px = course sidebar 260 + gap 16 + chat + gap 16 + status 240.
		// The chat takes every remaining pixel, so widening the window widens the
		// conversation instead of stretching a fixed rail. The status panel can be
		// collapsed to a 40px strip, handing that width to the chat.
		const learn = ruleBody(".mla-learn");
		expect(learn).toContain("max-width: 1600px");
		expect(learn).toContain("grid-template-columns: 260px minmax(0, 1fr) 240px");
		expect(learn).toContain("width: 100%");
		expect(learn).toContain("margin-inline: auto");
		expect(ruleBody(".mla-learn--status-collapsed")).toContain("260px minmax(0, 1fr) 40px");

		const column = ruleBody(".mla-chat-scroll > *");
		expect(column).toContain("max-width: 1100px");
		expect(ruleBody(".mla-composer")).toContain("padding: 12px 24px");

		// Phones keep the full card width rather than the desktop column.
		expect(css).toMatch(/\.mla-chat-scroll > \*\s*\{\s*max-width: 100%;/);
	});

	it("keeps the welcome home a single centred column before a conversation opens", () => {
		// E4.8b: the course sidebar and the status rail only exist in the
		// conversation layout; the welcome home must not reserve their width.
		expect(ruleBody(".mla-learn--welcome")).toContain("grid-template-columns: minmax(0, 1fr)");
		// E4.8f: 720–800px band, shared with the composer so greeting → cards →
		// input read as one column.
		expect(ruleBody(".mla-welcome")).toContain("max-width: 760px");
		expect(ruleBody(".mla-chat-card--welcome .mla-composer")).toContain("max-width: 760px");
		// Greeting and composer are one centred group: the scroll area's top auto
		// margin plus the composer's bottom auto margin absorb the free space, so
		// the input follows the cards instead of being pinned to the bottom.
		expect(ruleBody(".mla-chat-card--welcome .mla-chat-scroll")).toContain("flex: 0 0 auto");
		expect(ruleBody(".mla-chat-card--welcome .mla-chat-scroll")).toContain("margin-top: auto");
		expect(ruleBody(".mla-chat-card--welcome .mla-composer")).toContain("margin-bottom: auto");
		expect(ruleBody(".mla-chat-card--welcome .mla-composer")).toContain("padding-top: 20px");
		// An empty conversation is centred the same way, and returns to the
		// bottom composer as soon as a message exists.
		expect(ruleBody(".mla-chat--empty-start .mla-chat-scroll")).toContain("margin-top: auto");
		expect(ruleBody(".mla-chat--empty-start .mla-composer")).toContain("margin-bottom: auto");
	});

	it("keeps one 64px desktop navigation on every page (E4.8c)", () => {
		// E4.8 had a `--compact` 64px rail only on the workbench, but the plain
		// `.mla-body` rule came later with equal specificity and won, so every
		// page rendered at 184px while the compact rules were dead. The rail is
		// the single base rule now; a second width must never reappear.
		expect(ruleBody(".mla-body")).toContain("grid-template-columns: 64px minmax(0, 1fr)");
		expect(css).not.toMatch(/\.mla-body\s*\{[^}]*184px/);
		expect(css).not.toContain(".mla-body--compact");
		expect(css).not.toContain(".mla-sidebar--compact");
		// Icon-only rail: the label is hidden visually but stays the accessible name.
		expect(css).toMatch(/\.mla-nav-label,\s*\n\.mla-nav-label-short\s*\{\s*display: none;/);
	});

	it("keeps immersive pages free of a second phone inset (E4.8c)", () => {
		// `.mla-main--flush` zeroes the page inset, but the phone `@media`
		// `.mla-main` rule came later with equal specificity and repainted a
		// 20px/16px inset inside the already-inset chat card. Both must hold.
		expect(ruleBody(".mla-main--flush")).toContain("padding: 0");
		// Several 900px blocks exist; check every one that re-pads `.mla-main`.
		const phoneBlocks = [...css.matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? "");
		const paddingBlocks = phoneBlocks.filter((block) => /\.mla-main\s*\{/.test(block));
		expect(paddingBlocks.length).toBeGreaterThan(0);
		for (const block of paddingBlocks) {
			expect(block).toMatch(/\.mla-main--flush\s*\{\s*padding: 0;/);
		}
	});

	it("gives ordinary content pages one shared measure (E4.8c)", () => {
		expect(ruleBody(".mla-page")).toContain("max-width: 1288px");
		expect(ruleBody(".mla-page")).toContain("margin-inline: auto");
	});

	it("shares one course-card surface with explicit variants (E4.8c)", () => {
		// Today's 课程信息卡 and the welcome 可选择的课程卡 used to be two
		// implementations that drifted on radius/padding/title size.
		const family = css.match(/\.mla-course-card,\s*\n\.mla-course-pick,\s*\n\.mla-quick-card\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(family).toContain("border-radius: 10px");
		expect(family).toContain("padding: 16px");
		expect(family).toContain("background: var(--inno-surface)");
		// The tile-only rules must not re-declare their own surface.
		expect(ruleBody(".mla-course-pick")).not.toContain("border-radius");
		expect(ruleBody(".mla-course-card")).not.toContain("border-radius");
	});

	it("gives the welcome home its own open-canvas container variant (E4.8c)", () => {
		// The page itself is the canvas (chat surface, no inset); the card inside
		// it draws no frame at all. Entering a conversation only adds the frame.
		const page = ruleBody(".mla-learn--welcome");
		expect(page).toContain("max-width: none");
		expect(page).toContain("padding: 0");
		expect(page).toContain("background: var(--inno-chat-bg)");
		const welcome = ruleBody(".mla-chat-card--welcome");
		expect(welcome).toContain("border: 0");
		expect(welcome).toContain("background: transparent");
	});

	it("keeps wide markdown tables readable on phones without touching other pages", () => {
		// The table scrolls inside its own wrapper instead of collapsing columns
		// to one character per line; the selector is scoped to the chat message.
		expect(css).toMatch(
			/@container \(max-width: 640px\) \{[\s\S]*?\.mla-message-assistant \.inno-markdown-table\s*\{[^}]*min-width: 560px;/,
		);
	});

});
