import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { App } from "./App.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { chatStore } from "../stores/chat-store.js";
import { appStore } from "../stores/app-store.js";
import { learningStore } from "../stores/learning-store.js";
import { navigate } from "./shell/navigation.js";
import type { ShellPage } from "../stores/app-store.js";

vi.mock("./MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));

function setPage(page: ShellPage) {
	navigate(page, { history: "replace" });
}

beforeEach(() => {
	window.history.replaceState(null, "", "/?page=learn");
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(learningStore, "load").mockResolvedValue(undefined);
	sessionsStore.currentSessionId = "fixture.jsonl";
	sessionsStore.sessions = [];
	chatStore.messages = [];
	chatStore.isSending = false;
	appStore.chatDraft = "";
	appStore.activePage = "learn";
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	sessionsStore.currentSessionId = null;
	document.documentElement.removeAttribute("data-theme");
});

describe.each(["light", "dark"])("learning shell in %s", (theme) => {
	it("keeps the existing chat owner and offers no removed workbench controls", async () => {
		document.documentElement.setAttribute("data-theme", theme);
		const send = vi.spyOn(chatStore, "send").mockResolvedValue(undefined);
		render(<App />);

		expect(screen.queryByRole("button", { name: /终端|上传|权限|MCP|Office/ })).toBeNull();

		fireEvent.change(screen.getByRole("textbox", { name: "学习问题" }), { target: { value: "解释工具调用" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() => expect(send).toHaveBeenCalledWith("解释工具调用"));
	});

	it("navigates all five pages from the main navigation", async () => {
		render(<App />);
		for (const label of ["今日学习", "练习与反馈", "我的学习档案", "系统设置", "AI 学习"]) {
			const buttons = screen.getAllByRole("button", { name: label });
			fireEvent.click(buttons[0]);
			await waitFor(() =>
				expect(screen.getAllByRole("button", { name: label })[0].getAttribute("aria-current")).toBe("page"),
			);
		}
		// Back on the learn page the composer is present again.
		expect(screen.getByRole("textbox", { name: "学习问题" })).toBeTruthy();
		expect(new URL(window.location.href).searchParams.get("page")).toBe("learn");
	});

	it("renders a sidebar nav and a mobile bottom nav with the same five pages", async () => {
		render(<App />);
		const primary = screen.getByRole("navigation", { name: "主导航" });
		const bottom = screen.getByRole("navigation", { name: "主导航（移动端）" });
		expect(primary.querySelectorAll("button")).toHaveLength(5);
		expect(bottom.querySelectorAll("button")).toHaveLength(5);
		// Short labels exist so 320px keeps five readable items.
		expect(bottom.textContent).toContain("今日");
		expect(bottom.textContent).toContain("设置");
	});

	it("keeps the composer draft when switching pages", async () => {
		render(<App />);
		fireEvent.change(screen.getByRole("textbox", { name: "学习问题" }), { target: { value: "未发送的草稿" } });
		expect(appStore.chatDraft).toBe("未发送的草稿");

		setPage("today");
		await waitFor(() => expect(screen.getAllByText("今日学习").length).toBeGreaterThan(0));

		setPage("learn");
		await waitFor(() => expect(screen.getByRole("textbox", { name: "学习问题" })).toHaveProperty("value", "未发送的草稿"));
	});
});
