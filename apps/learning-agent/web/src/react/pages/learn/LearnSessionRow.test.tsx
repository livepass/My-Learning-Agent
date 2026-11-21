// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../../../api/sessions.js";
import { LearnSessionRow } from "./LearnSessionRow.js";

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
	id: "s1",
	name: "交叉验证",
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	messageCount: 4,
	preview: "如果训练集很小，K 该怎么选？",
	channels: ["web"],
	origin: "web",
	archived: false,
	course: { course_id: "c1", title: "机器学习基础", archived: false, task_id: "t1" },
	daily_visible: true,
	...overrides,
});

function renderRow(overrides: Partial<Parameters<typeof LearnSessionRow>[0]> = {}) {
	const props = {
		session: session(),
		active: false,
		busy: false,
		pending: false,
		unclassified: false,
		onOpen: vi.fn(),
		onRename: vi.fn(),
		onArchive: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
	const view = render(<LearnSessionRow {...props} />);
	return { ...props, ...view };
}

function openMenu() {
	fireEvent.pointerDown(screen.getByRole("button", { name: "会话操作：交叉验证" }), {
		button: 0,
		pointerType: "mouse",
	});
}

afterEach(cleanup);

describe("LearnSessionRow", () => {
	it("renders the name, preview, course-task label and the active state", () => {
		const { rerender } = render(
			// The active row is the one the current conversation points at.
			<LearnSessionRow
				session={session()}
				active={false}
				busy={false}
				pending={false}
				unclassified={false}
				onOpen={vi.fn()}
				onRename={vi.fn()}
				onArchive={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		expect(screen.getByText("交叉验证")).toBeTruthy();
		expect(screen.getByText("如果训练集很小，K 该怎么选？")).toBeTruthy();
		expect(screen.getByText("课程任务")).toBeTruthy();
		expect(screen.queryByText(" · 未归类")).toBeNull();
		expect(screen.getByRole("button", { name: /^交叉验证/ }).getAttribute("aria-current")).toBeNull();

		rerender(
			<LearnSessionRow
				session={session()}
				active
				busy={false}
				pending={false}
				unclassified={false}
				onOpen={vi.fn()}
				onRename={vi.fn()}
				onArchive={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: /^交叉验证/ }).getAttribute("aria-current")).toBe("true");
	});

	it("keeps the unnamed, empty, free-chat, archived and unclassified labels", () => {
		render(
			<LearnSessionRow
				session={session({
					name: "",
					preview: "",
					messageCount: 0,
					archived: true,
					course: null,
				})}
				active={false}
				busy={false}
				pending={false}
				unclassified
				onOpen={vi.fn()}
				onRename={vi.fn()}
				onArchive={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		expect(screen.getByText("未命名对话")).toBeTruthy();
		expect(screen.getByText("暂无消息")).toBeTruthy();
		expect(screen.getByText("已归档")).toBeTruthy();
		expect(screen.getByText("自由学习 · 未归类")).toBeTruthy();
		expect(screen.getByRole("button", { name: "会话操作：未命名对话" })).toBeTruthy();
	});

	it("disables the row while busy and only spins the row that owns the action", () => {
		const { container } = renderRow({ busy: true, pending: true });

		expect((screen.getByRole("button", { name: /^交叉验证/ }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "会话操作：交叉验证" }) as HTMLButtonElement).disabled).toBe(true);
		expect(container.querySelectorAll(".mla-spin").length).toBe(1);
	});

	it("does not spin other rows when they are merely disabled by an in-flight action", () => {
		const { container } = renderRow({ busy: true, pending: false });

		expect((screen.getByRole("button", { name: /^交叉验证/ }) as HTMLButtonElement).disabled).toBe(true);
		expect(container.querySelector(".mla-spin")).toBeNull();
	});

	it("opens the conversation through the page callback", () => {
		const onOpen = vi.fn();
		renderRow({ onOpen });

		fireEvent.click(screen.getByRole("button", { name: /^交叉验证/ }));
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("routes rename, archive and delete through the menu callbacks", () => {
		const onRename = vi.fn();
		const onArchive = vi.fn();
		const onDelete = vi.fn();
		renderRow({ onRename, onArchive, onDelete });

		openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
		expect(onRename).toHaveBeenCalledTimes(1);

		cleanup();
		renderRow({ onArchive });
		openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "归档会话" }));
		expect(onArchive).toHaveBeenCalledTimes(1);

		cleanup();
		renderRow({ onDelete });
		openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "永久删除" }));
		expect(onDelete).toHaveBeenCalledTimes(1);
	});
});
