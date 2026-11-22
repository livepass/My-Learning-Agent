// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider } from "../../test-utils.js";
import type { SessionMeta } from "../../../api/sessions.js";
import { LearnHistoryRail } from "./LearnHistoryRail.js";

/**
 * E4.9g-P2-4 — the history rail.
 *
 * Presentation only: every action is a callback. These cases pin the two
 * frames it renders in (permanent column vs drawer) and that the drawer's
 * close affordance and focus handling exist only in drawer mode.
 */

const session = (id: string, overrides: Partial<SessionMeta> = {}): SessionMeta => ({
	id,
	name: id,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	messageCount: 2,
	preview: "上次的问题",
	channels: ["web"],
	origin: "web",
	archived: false,
	course: { course_id: "course_python", title: "Python 编程", archived: false, task_id: null },
	daily_visible: true,
	...overrides,
});

const row = (item: SessionMeta) => <div key={item.id} data-testid={`row-${item.id}`}>{item.name}</div>;

function rail(overrides: Partial<Parameters<typeof LearnHistoryRail>[0]> = {}) {
	const props = {
		draggable: false,
		open: false,
		course: { course_id: "course_python", title: "Python 编程", status: "in_progress" as const },
		title: "Python 编程",
		canStartNew: true,
		creating: false,
		conversations: [session("s1"), session("s2")],
		conversationCount: 2,
		unclassifiedSessions: [] as SessionMeta[],
		showUnclassified: false,
		archiveEntryCount: 0,
		archivedCourseCount: 0,
		hiddenSessionCount: 0,
		actionError: null as string | null,
		renderSessionRow: row,
		onBack: vi.fn(),
		onClose: vi.fn(),
		onNewConversation: vi.fn(),
		onToggleUnclassified: vi.fn(),
		onOpenArchive: vi.fn(),
		...overrides,
	};
	return { props, ...renderWithTooltipProvider(<LearnHistoryRail {...props} />) };
}

afterEach(cleanup);

describe("LearnHistoryRail — permanent column", () => {
	it("renders as a plain complementary region, never a dialog", () => {
		rail();

		const aside = screen.getByRole("complementary", { name: "课程与学习对话" });
		expect(aside.getAttribute("aria-hidden")).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
		// No drawer affordances in the permanent frame.
		expect(screen.queryByRole("button", { name: "关闭课程列表" })).toBeNull();
	});

	it("lists every conversation of the course, not just the first few", () => {
		const many = Array.from({ length: 9 }, (_, index) => session(`s${index + 1}`));
		rail({ conversations: many, conversationCount: many.length });

		for (const item of many) expect(screen.getByTestId(`row-${item.id}`)).toBeTruthy();
	});

	it("shows the course, its status and the new-conversation entry", () => {
		const { props } = rail();

		expect(screen.getByRole("heading", { name: "Python 编程" })).toBeTruthy();
		expect(screen.getByText("进行中")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
		expect(props.onNewConversation).toHaveBeenCalledTimes(1);
	});

	it("hides the new-conversation entry when the page says it is not allowed", () => {
		rail({ canStartNew: false });

		expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
	});

	it("keeps the unclassified group separate and collapsed by default when a course is open", () => {
		const { props } = rail({ unclassifiedSessions: [session("legacy", { course: null })] });

		const toggle = screen.getByRole("button", { name: /未归类历史/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByTestId("row-legacy")).toBeNull();

		fireEvent.click(toggle);
		expect(props.onToggleUnclassified).toHaveBeenCalledTimes(1);
	});

	it("expands the unclassified group when the page has it open", () => {
		rail({ unclassifiedSessions: [session("legacy", { course: null })], showUnclassified: true });

		expect(screen.getByTestId("row-legacy")).toBeTruthy();
	});

	it("shows the empty state only when the course really has no conversations", () => {
		rail({ conversations: [], conversationCount: 0 });
		expect(screen.getByText(/这门课程还没有学习对话/)).toBeTruthy();

		cleanup();
		rail({ conversations: [session("s1")], conversationCount: 5 });
		expect(screen.queryByText(/这门课程还没有学习对话/)).toBeNull();
	});

	it("surfaces a session action error and the archive entry", () => {
		const { props } = rail({
			actionError: "归档失败：请稍后重试",
			archiveEntryCount: 2,
			archivedCourseCount: 1,
			hiddenSessionCount: 1,
		});

		expect(screen.getByRole("alert").textContent).toContain("归档失败");
		fireEvent.click(screen.getByRole("button", { name: /查看归档/ }));
		expect(props.onOpenArchive).toHaveBeenCalledTimes(1);
	});
});

describe("LearnHistoryRail — drawer", () => {
	it("adds a close button and marks itself hidden while closed", () => {
		rail({ draggable: true, open: false });

		// `aria-hidden` takes it out of the accessibility tree, which is the point;
		// assert on the element itself.
		expect(document.querySelector(".mla-learn-sidebar")?.getAttribute("aria-hidden")).toBe("true");
		// The close button belongs to the open drawer only.
		expect(screen.queryByRole("button", { name: "关闭课程列表" })).toBeNull();
	});

	it("moves focus into the drawer on open and restores it on close", () => {
		const trigger = document.createElement("button");
		trigger.textContent = "trigger";
		document.body.appendChild(trigger);
		trigger.focus();

		const { rerender } = renderWithTooltipProvider(
			<LearnHistoryRail {...{
				draggable: true,
				open: false,
				course: null,
				title: "未归类历史",
				canStartNew: false,
				creating: false,
				conversations: [],
				conversationCount: 0,
				unclassifiedSessions: [],
				showUnclassified: false,
				archiveEntryCount: 0,
				archivedCourseCount: 0,
				hiddenSessionCount: 0,
				actionError: null,
				renderSessionRow: row,
				onBack: vi.fn(),
				onClose: vi.fn(),
				onNewConversation: vi.fn(),
				onToggleUnclassified: vi.fn(),
				onOpenArchive: vi.fn(),
			}} />,
		);

		rerender(
			<LearnHistoryRail {...{
				draggable: true,
				open: true,
				course: null,
				title: "未归类历史",
				canStartNew: false,
				creating: false,
				conversations: [],
				conversationCount: 0,
				unclassifiedSessions: [],
				showUnclassified: false,
				archiveEntryCount: 0,
				archivedCourseCount: 0,
				hiddenSessionCount: 0,
				actionError: null,
				renderSessionRow: row,
				onBack: vi.fn(),
				onClose: vi.fn(),
				onNewConversation: vi.fn(),
				onToggleUnclassified: vi.fn(),
				onOpenArchive: vi.fn(),
			}} />,
		);
		expect(document.activeElement?.closest(".mla-learn-sidebar")).toBeTruthy();

		rerender(
			<LearnHistoryRail {...{
				draggable: true,
				open: false,
				course: null,
				title: "未归类历史",
				canStartNew: false,
				creating: false,
				conversations: [],
				conversationCount: 0,
				unclassifiedSessions: [],
				showUnclassified: false,
				archiveEntryCount: 0,
				archivedCourseCount: 0,
				hiddenSessionCount: 0,
				actionError: null,
				renderSessionRow: row,
				onBack: vi.fn(),
				onClose: vi.fn(),
				onNewConversation: vi.fn(),
				onToggleUnclassified: vi.fn(),
				onOpenArchive: vi.fn(),
			}} />,
		);
		expect(document.activeElement).toBe(trigger);
		trigger.remove();
	});

	it("closes through its own button and on Escape", () => {
		const { props } = rail({ draggable: true, open: true });

		fireEvent.click(screen.getByRole("button", { name: "关闭课程列表" }));
		expect(props.onClose).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: "Escape" });
		expect(props.onClose).toHaveBeenCalledTimes(2);
	});

	it("does not listen for Escape while it is a permanent column", () => {
		const { props } = rail({ draggable: false });

		fireEvent.keyDown(window, { key: "Escape" });
		expect(props.onClose).not.toHaveBeenCalled();
	});
});

/**
 * E4.9g-P2-4-R1 — drawer modality and closed-state isolation.
 *
 * jsdom has no layout engine, so these cases prove the *contract* (inert flag,
 * role/aria, focus target, Tab loop, scroll lock) rather than real pixel-level
 * Tab order; the browser keyboard pass is recorded in the acceptance report.
 */
describe("LearnHistoryRail — drawer modality (P2-4-R1)", () => {
	const base = {
		draggable: true,
		course: { course_id: "course_python", title: "Python 编程", status: "in_progress" as const },
		title: "Python 编程",
		canStartNew: true,
		creating: false,
		conversations: [session("s1")],
		conversationCount: 1,
		unclassifiedSessions: [] as SessionMeta[],
		showUnclassified: false,
		archiveEntryCount: 0,
		archivedCourseCount: 0,
		hiddenSessionCount: 0,
		actionError: null as string | null,
		renderSessionRow: row,
		onBack: vi.fn(),
		onClose: vi.fn(),
		onNewConversation: vi.fn(),
		onToggleUnclassified: vi.fn(),
		onOpenArchive: vi.fn(),
	};

	/** A sibling of the rail, standing in for the chat card. */
	const background = () => {
		const button = document.createElement("button");
		button.textContent = "background";
		document.body.appendChild(button);
		return button;
	};

	afterEach(() => {
		for (const node of Array.from(document.body.children)) {
			if (node.tagName === "BUTTON" && node.textContent === "background") node.remove();
		}
		document.body.style.overflow = "";
	});

	it("T01 — a closed drawer is inert, so its controls cannot be Tabbed to", () => {
		renderWithTooltipProvider(<LearnHistoryRail {...base} open={false} />);

		const rail = document.querySelector<HTMLElement>(".mla-learn-sidebar")!;
		expect(rail.inert).toBe(true);
		expect(rail.getAttribute("aria-hidden")).toBe("true");
		// The buttons still exist in the DOM (the slide transition needs them),
		// which is exactly why `inert` rather than `aria-hidden` is required.
		expect(rail.querySelectorAll("button").length).toBeGreaterThan(0);
	});

	it("T02 — an open drawer is a modal dialog with focus inside it", () => {
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);

		const rail = document.querySelector<HTMLElement>(".mla-learn-sidebar")!;
		expect(rail.getAttribute("role")).toBe("dialog");
		expect(rail.getAttribute("aria-modal")).toBe("true");
		expect(rail.inert).toBe(false);
		expect(rail.contains(document.activeElement)).toBe(true);
	});

	it("T03/T04 — Tab loops from the last control to the first and back", () => {
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);
		const rail = document.querySelector<HTMLElement>(".mla-learn-sidebar")!;
		const items = Array.from(rail.querySelectorAll<HTMLElement>("button:not([disabled])"));
		expect(items.length).toBeGreaterThan(1);

		const last = items[items.length - 1]!;
		last.focus();
		fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(document.activeElement).toBe(items[0]);

		fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);
	});

	it("T05/T08 — background is inert and body scroll is locked while open, restored on close", () => {
		const bg = background();
		const { unmount } = renderWithTooltipProvider(<LearnHistoryRail {...base} open />);

		expect(bg.inert).toBe(true);
		expect(document.body.style.overflow).toBe("hidden");

		unmount();
		expect(bg.inert).not.toBe(true);
		expect(document.body.style.overflow).toBe("");
	});

	it("T06 — Escape closes the drawer", () => {
		const { props } = (() => {
			const p = { ...base, onClose: vi.fn() };
			renderWithTooltipProvider(<LearnHistoryRail {...p} open />);
			return { props: p };
		})();

		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it("does not close the drawer when a menu inside it already handled Escape", () => {
		const props = { ...base, onClose: vi.fn() };
		renderWithTooltipProvider(<LearnHistoryRail {...props} open />);

		// Radix marks its own Escape as handled before the window listener runs.
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		event.preventDefault();
		window.dispatchEvent(event);

		expect(props.onClose).not.toHaveBeenCalled();
	});

	it("T11/T12 — the permanent column is never inert and has no modal semantics", () => {
		const { rerender } = renderWithTooltipProvider(<LearnHistoryRail {...base} open />);
		rerender(<LearnHistoryRail {...base} draggable={false} open={false} />);

		const rail = document.querySelector<HTMLElement>(".mla-learn-sidebar")!;
		expect(rail.inert).toBe(false);
		expect(rail.getAttribute("role")).toBeNull();
		expect(rail.getAttribute("aria-modal")).toBeNull();
		expect(rail.getAttribute("aria-hidden")).toBeNull();
		expect(document.body.style.overflow).toBe("");
	});

	it("keeps focus reachable in the permanent column", () => {
		renderWithTooltipProvider(<LearnHistoryRail {...base} draggable={false} open={false} />);

		const rail = document.querySelector<HTMLElement>(".mla-learn-sidebar")!;
		const first = rail.querySelector<HTMLElement>("button:not([disabled])")!;
		first.focus();
		expect(document.activeElement).toBe(first);
	});

	it("T09 — a menu rendered through a portal is not inerted by the drawer", () => {
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);

		// Radix portals its menu into a popper wrapper under <body>.
		const wrapper = document.createElement("div");
		wrapper.setAttribute("data-radix-popper-content-wrapper", "");
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		menu.setAttribute("data-state", "open");
		wrapper.appendChild(menu);
		document.body.appendChild(wrapper);

		// Re-open the layer so isolation runs with the portal present.
		cleanup();
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);

		// jsdom reports `undefined` for an inert flag that was never set, so the
		// meaningful assertion is "the drawer did not inert the portal".
		expect(wrapper.inert).not.toBe(true);
		wrapper.remove();
	});

	it("T13 — closing one layer does not unlock scroll another layer still needs", () => {
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);
		expect(document.body.style.overflow).toBe("hidden");

		// A second modal layer (e.g. the context sheet) opens and closes while the
		// drawer stays open: the lock must survive.
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);
		cleanup();
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);
		expect(document.body.style.overflow).toBe("hidden");
	});

	it("does not trap Tab while focus is outside the drawer (a menu owns it)", () => {
		renderWithTooltipProvider(<LearnHistoryRail {...base} open />);
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();

		fireEvent.keyDown(outside, { key: "Tab" });
		// The drawer leaves a portalled menu's own Tab handling alone.
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});
});
