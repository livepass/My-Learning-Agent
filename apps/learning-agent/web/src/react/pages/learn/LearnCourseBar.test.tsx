// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../../test-utils.js";
import i18n from "../../../i18n/index.js";
import type { CourseSummary, LearningStartTaskView } from "../../../api/courses.js";
import { LearnCourseBar, type LearnCourseBarCourse } from "./LearnCourseBar.js";

const course = (overrides: Partial<CourseSummary> = {}): CourseSummary => ({
	course_id: "course_python",
	title: "Python 编程",
	description: "",
	status: "in_progress",
	created_at: "2026-11-01T00:00:00.000Z",
	updated_at: "2026-11-02T00:00:00.000Z",
	counts: { goals: 0, plans: 1, tasks: 1, sessions: 1, sources: 0 },
	...overrides,
});

const barCourse: LearnCourseBarCourse = {
	course_id: "course_python",
	title: "Python 编程",
	status: "in_progress",
};

const task: LearningStartTaskView = {
	task_id: "task_1",
	title: "理解装饰器的求值顺序",
	status: "in_progress",
	stage_id: "stage_1",
	plan_id: "plan_1",
	estimated_minutes: 25,
	concept_ids: [],
};

function bar(overrides: Partial<Parameters<typeof LearnCourseBar>[0]> = {}) {
	const props = {
		course: barCourse,
		courses: [course(), course({ course_id: "course_en", title: "英语学术写作" })],
		task: task as LearningStartTaskView | null,
		stageTitle: "第一阶段：函数与作用域" as string | null,
		warnings: [] as string[],
		contextReady: true,
		unclassified: false,
		canStartNew: true,
		creating: false,
		statusOpen: true,
		navOpen: false,
		onOpenNav: vi.fn(),
		onSelectCourse: vi.fn(),
		onNewConversation: vi.fn(),
		onToggleStatus: vi.fn(),
		onOpenPlan: vi.fn(),
		...overrides,
	};
	render(<LearnCourseBar {...props} />);
	return props;
}

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

describe("LearnCourseBar — context", () => {
	it("shows the course, status, server task and stage in one labelled bar", () => {
		bar();
		const region = screen.getByLabelText("当前课程任务");

		expect(within(region).getByText("Python 编程")).toBeTruthy();
		expect(within(region).getByText("进行中")).toBeTruthy();
		expect(within(region).getByText("理解装饰器的求值顺序")).toBeTruthy();
		expect(within(region).getByText("阶段：第一阶段：函数与作用域")).toBeTruthy();
		expect(within(region).getByText("当前任务")).toBeTruthy();
	});

	it("does not invent a task or stage before the context has loaded", () => {
		bar({ contextReady: false, task: null, stageTitle: null });
		const region = screen.getByLabelText("当前课程任务");

		expect(within(region).queryByText("当前任务")).toBeNull();
		expect(within(region).queryByText("自由学习")).toBeNull();
		expect(within(region).queryByText(/阶段：/)).toBeNull();
	});

	it("marks a course-bound conversation without a task as free learning", () => {
		bar({ task: null, stageTitle: null });
		const region = screen.getByLabelText("当前课程任务");

		expect(within(region).getByText("自由学习")).toBeTruthy();
		expect(within(region).queryByText("当前任务")).toBeNull();
	});

	it("keeps unclassified history labelled and free of course actions", () => {
		bar({ course: null, task: null, stageTitle: null, unclassified: true, canStartNew: false });
		const region = screen.getByLabelText("课程栏");

		expect(within(region).getByText("未归类对话")).toBeTruthy();
		expect(within(region).getByText("未归类")).toBeTruthy();
		expect(within(region).queryByText("当前任务")).toBeNull();
		expect(screen.queryByRole("button", { name: "课程计划" })).toBeNull();
		expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
	});

	it("shows archived status without a task and still exposes the plan entry", () => {
		bar({ course: { ...barCourse, status: "archived" }, task: null, stageTitle: null, canStartNew: false });
		const region = screen.getByLabelText("当前课程任务");

		expect(within(region).getByText("已归档")).toBeTruthy();
		expect(within(region).getByText("自由学习")).toBeTruthy();
		expect(screen.getByRole("button", { name: "课程计划" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "新建对话" })).toBeNull();
	});
});

describe("LearnCourseBar — actions", () => {
	it("routes plan, status and new-conversation clicks to the page callbacks", () => {
		const props = bar();

		fireEvent.click(screen.getByRole("button", { name: "课程计划" }));
		expect(props.onOpenPlan).toHaveBeenCalledTimes(1);

		const status = screen.getByRole("button", { name: "学习状态" });
		expect(status.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(status);
		expect(props.onToggleStatus).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
		expect(props.onNewConversation).toHaveBeenCalledTimes(1);
	});

	it("disables new conversation while one is being created", () => {
		bar({ creating: true });
		const button = screen.getByRole("button", { name: "新建对话" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});

	it("lists switchable courses and reports the picked course", async () => {
		const props = bar();
		const trigger = screen.getByRole("button", { name: "切换课程" });
		fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });

		const options = await screen.findAllByRole("menuitemradio");
		expect(options.map((item) => item.textContent)).toEqual([
			expect.stringContaining("Python 编程"),
			expect.stringContaining("英语学术写作"),
		]);
		fireEvent.click(screen.getByRole("menuitemradio", { name: /英语学术写作/ }));
		expect(props.onSelectCourse).toHaveBeenCalledWith("course_en");
	});

	it("closes the course menu with Escape and returns focus to the trigger", async () => {
		bar();
		const trigger = screen.getByRole("button", { name: "切换课程" });
		trigger.focus();
		fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
		await screen.findByRole("menu");

		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});

	it("switches its visible labels with the language", async () => {
		bar({ task: null, stageTitle: null });

		await act(async () => {
			await i18n.changeLanguage("en");
		});
		expect(screen.getByRole("button", { name: "Course plan" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Learning status" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy();
		expect(screen.getByText("Free learning")).toBeTruthy();

		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(screen.getByRole("button", { name: "课程计划" })).toBeTruthy();
	});
});

/**
 * E4.9g-P2-2-R1 — the learning warnings must be readable without a mouse.
 *
 * The old marker was a `role="img"` span whose text lived in `title` and
 * `aria-label`: a touch screen shows no title, and no keyboard could open it.
 * These cases pin the replacement: a real button, a popover listing every
 * server string verbatim, Escape closing it, and focus coming back.
 */
describe("LearnCourseBar — warnings", () => {
	const warnings = [
		"该会话与另一段学习共用同一任务，已保留原有绑定。",
		"上一次启动时未写入学习检查点，本段会话从自由学习开始。",
	];

	it("renders no warning entry when the server sent no warnings", () => {
		bar({ warnings: [] });

		expect(screen.queryByRole("button", { name: /查看学习提示/ })).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens a single warning with its full server text on click", async () => {
		bar({ warnings: [warnings[0]!] });

		const trigger = screen.getByRole("button", { name: "查看学习提示（1 条）" });
		fireEvent.click(trigger);

		const popover = await screen.findByRole("dialog", { name: "学习提示" });
		expect(within(popover).getByText(warnings[0]!)).toBeTruthy();
		// The text is a text node, never HTML parsed from the server payload.
		expect(popover.querySelector("li")?.textContent).toBe(warnings[0]);
	});

	it("lists every warning instead of only the first", async () => {
		bar({ warnings });

		fireEvent.click(screen.getByRole("button", { name: "查看学习提示（2 条）" }));

		const popover = await screen.findByRole("dialog", { name: "学习提示" });
		const items = within(popover).getAllByRole("listitem");
		expect(items.map((item) => item.textContent)).toEqual(warnings);
	});

	it("exposes a native button so Enter and Space activate it", () => {
		bar({ warnings });

		const trigger = screen.getByRole("button", { name: "查看学习提示（2 条）" });
		// Enter/Space activation comes from the element type: a real <button>
		// fires `click` on both. A span with a title (the old marker) could not.
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("type")).toBe("button");
		expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});

	it("closes with Escape and returns focus to the trigger", async () => {
		bar({ warnings });

		const trigger = screen.getByRole("button", { name: "查看学习提示（2 条）" });
		trigger.focus();
		fireEvent.click(trigger);

		const popover = await screen.findByRole("dialog", { name: "学习提示" });
		await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
		await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));

		fireEvent.keyDown(document.activeElement ?? popover, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps the warning entry labelled in both languages", async () => {
		bar({ warnings: [warnings[0]!] });
		expect(screen.getByRole("button", { name: "查看学习提示（1 条）" })).toBeTruthy();

		await act(async () => {
			await i18n.changeLanguage("en");
		});
		expect(screen.getByRole("button", { name: "View learning notices (1)" })).toBeTruthy();
	});
});
