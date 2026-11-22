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
