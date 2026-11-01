import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { LearningWorkspace } from "./LearningWorkspace.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { chatStore } from "../stores/chat-store.js";
import { appStore } from "../stores/app-store.js";

vi.mock("./MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock("./settings/SettingsOverlay.js", () => ({ SettingsOverlay: () => <div role="dialog">学习设置</div> }));
beforeEach(() => {
	vi.spyOn(sessionsStore, "load").mockResolvedValue(undefined);
	sessionsStore.currentSessionId = "fixture.jsonl";
	sessionsStore.sessions = [];
	chatStore.messages = [];
	chatStore.isSending = false;
	appStore.settingsOpen = false;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionsStore.currentSessionId = null; appStore.settingsOpen = false; document.documentElement.removeAttribute("data-theme"); });
describe.each(["light", "dark"])("learning workspace in %s", theme => {
	it("uses the existing chat owner and offers no terminal, file or permission controls", async () => {
		document.documentElement.setAttribute("data-theme", theme);
		const send = vi.spyOn(chatStore, "send").mockResolvedValue(undefined);
		render(<LearningWorkspace />);
		expect(screen.queryByRole("button", { name: /终端|上传|权限|MCP|Office/ })).toBeNull();
		fireEvent.change(screen.getByRole("textbox", { name: "学习问题" }), { target: { value: "解释工具调用" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() => expect(send).toHaveBeenCalledWith("解释工具调用"));
		fireEvent.click(screen.getByRole("button", { name: "设置" }));
		expect(await screen.findByRole("dialog")).not.toBeNull();
	});
});
