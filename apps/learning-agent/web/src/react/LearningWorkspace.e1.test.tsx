import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { LearningWorkspace } from "./LearningWorkspace.js";
import { appStore } from "../stores/app-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { ApiError } from "../api/client.js";
import type { ChatMessage } from "../types/chat.js";
import type { InnoSettings } from "../types/settings.js";

const api = vi.hoisted(() => ({
	branch: vi.fn(),
	getLearningState: vi.fn(),
}));

vi.mock("../api/sessions.js", async () => {
	const actual = await vi.importActual<typeof import("../api/sessions.js")>("../api/sessions.js");
	return { ...actual, branchSessionBeforeMessage: api.branch };
});
vi.mock("../api/learning.js", async () => {
	const actual = await vi.importActual<typeof import("../api/learning.js")>("../api/learning.js");
	return { ...actual, getLearningState: api.getLearningState };
});
vi.mock("./MarkdownArtifact.js", () => ({
	MarkdownArtifact: ({ content }: { content: string }) => <div data-testid="assistant-content">{content}</div>,
}));

const settings = (overrides: Partial<InnoSettings> = {}): InnoSettings => ({
	defaultProvider: "fixture",
	defaultModel: "dummy",
	configuredModels: [
		{ id: "dummy", name: "Dummy", provider: "fixture", reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 2_000 },
		{ id: "other", name: "Other", provider: "fixture", reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 2_000 },
	],
	providers: {},
	...overrides,
});

const userMessage = (content: string, entryId = "u1", extra: Partial<ChatMessage> = {}): ChatMessage => ({
	role: "user", content, timestamp: 1, entryId, transient: false, complete: true, ...extra,
});
const assistantMessage = (content: string, entryId = "a1"): ChatMessage => ({
	role: "assistant", content, timestamp: 2, entryId,
});

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(settingsStore, "load").mockResolvedValue(undefined);
	vi.spyOn(settingsStore, "switchModel").mockResolvedValue(true);
	vi.spyOn(chatStore, "send").mockResolvedValue(undefined);
	settingsStore.settings = settings();
	settingsStore.isLoading = false;
	settingsStore.isSavingModel = false;
	settingsStore.error = null;
	sessionsStore.currentSessionId = "s1.jsonl";
	sessionsStore.openingSessionId = null;
	appStore.chatDraft = "普通草稿";
	chatStore.messages = [];
	chatStore.isSending = false;
	chatStore.isLoadingHistory = false;
	chatStore.streamingText = "";
	chatStore.streamingActivity = "";
	chatStore.streamingError = "";
	chatStore.lastSendOutcome = null;
	api.branch.mockResolvedValue({
		sessionId: "s1.jsonl", replacedEntryId: "u1", branchMarkerId: "m1", sessionRevision: "1:0",
	});
	api.getLearningState.mockResolvedValue({ exists: false });
	writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
	window.history.replaceState(null, "", "/?page=learn&session=s1.jsonl");
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	settingsStore.settings = null;
	sessionsStore.currentSessionId = null;
	chatStore.messages = [];
});

describe("E1 message display and copy", () => {
	it("copies a user message and an assistant reply with visible feedback", async () => {
		chatStore.messages = [userMessage("原始问题"), assistantMessage("完整回答")];
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "复制用户消息" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("原始问题"));
		expect(await screen.findByText("已复制")).toBeTruthy();
		expect(chatStore.send).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("完整回答"));
		expect(screen.getByText("已复制")).toBeTruthy();
	});

	it("reports a failed copy without sending or switching sessions", async () => {
		writeText.mockRejectedValueOnce(new Error("denied"));
		chatStore.messages = [userMessage("原始问题")];
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "复制用户消息" }));
		expect(await screen.findByText("复制失败，请手动选择文本")).toBeTruthy();
		expect(chatStore.send).not.toHaveBeenCalled();
		expect(sessionsStore.currentSessionId).toBe("s1.jsonl");
	});
});

describe("E1 user message editing", () => {
	it("edits only persisted text messages and keeps the normal draft separate", async () => {
		chatStore.messages = [
			userMessage("原始问题"),
			userMessage("临时消息", "temp", { transient: true }),
			userMessage("图片消息", "img", { images: [{ previewUrl: "blob:x", mimeType: "image/png" }] }),
		];
		render(<LearningWorkspace />);

		const editButtons = screen.getAllByRole("button", { name: "编辑用户消息" });
		expect(editButtons).toHaveLength(1);
		fireEvent.click(editButtons[0]);
		const editor = await screen.findByRole("textbox", { name: "编辑消息内容" });
		expect((editor as HTMLTextAreaElement).value).toBe("原始问题");
		expect(appStore.chatDraft).toBe("普通草稿");
		expect((screen.getByRole("textbox", { name: "学习问题" }) as HTMLTextAreaElement).value).toBe("普通草稿");

		fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
		expect(screen.queryByRole("textbox", { name: "编辑消息内容" })).toBeNull();
		expect(appStore.chatDraft).toBe("普通草稿");
		expect((screen.getByRole("textbox", { name: "学习问题" }) as HTMLTextAreaElement).value).toBe("普通草稿");
	});

	it("branches before the original message and resends the edited text", async () => {
		chatStore.messages = [userMessage("旧问题"), assistantMessage("旧回答")];
		(chatStore.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			chatStore.lastSendOutcome = "completed";
		});
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "编辑用户消息" }));
		const editor = await screen.findByRole("textbox", { name: "编辑消息内容" });
		fireEvent.change(editor, { target: { value: "新问题" } });
		fireEvent.click(screen.getByRole("button", { name: "发送修改" }));

		await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith("新问题"));
		expect(api.branch).toHaveBeenCalledWith("s1.jsonl", "u1");
		expect(api.branch.mock.invocationCallOrder[0]).toBeLessThan(
			(chatStore.send as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
		);
		expect(screen.queryByText("旧回答")).toBeNull();
		expect(screen.queryByRole("textbox", { name: "编辑消息内容" })).toBeNull();
		expect(appStore.chatDraft).toBe("普通草稿");
	});

	it("keeps the edit draft and an explicit error when the branch fails", async () => {
		api.branch.mockRejectedValue(new ApiError(409, "not_active_branch", { code: "not_active_branch" }));
		chatStore.messages = [userMessage("旧问题"), assistantMessage("旧回答")];
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "编辑用户消息" }));
		const editor = await screen.findByRole("textbox", { name: "编辑消息内容" });
		fireEvent.change(editor, { target: { value: "新问题" } });
		fireEvent.click(screen.getByRole("button", { name: "发送修改" }));

		expect(await screen.findByText("这条消息已不在当前对话分支，无法编辑。")).toBeTruthy();
		expect((screen.getByRole("textbox", { name: "编辑消息内容" }) as HTMLTextAreaElement).value).toBe("新问题");
		expect(chatStore.send).not.toHaveBeenCalled();
		expect(appStore.chatDraft).toBe("普通草稿");
	});

	it("keeps the edit draft when the branch landed but the resend failed", async () => {
		chatStore.messages = [userMessage("旧问题"), assistantMessage("旧回答")];
		(chatStore.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			chatStore.lastSendOutcome = "error";
		});
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "编辑用户消息" }));
		const editor = await screen.findByRole("textbox", { name: "编辑消息内容" });
		fireEvent.change(editor, { target: { value: "新问题" } });
		fireEvent.click(screen.getByRole("button", { name: "发送修改" }));

		expect(await screen.findByText(/新分支已建立，但修改后的消息发送失败/)).toBeTruthy();
		expect((screen.getByRole("textbox", { name: "编辑消息内容" }) as HTMLTextAreaElement).value).toBe("新问题");
		expect(chatStore.send).toHaveBeenCalledWith("新问题");
		expect(screen.queryByText("旧回答")).toBeNull();
	});

	it("cancels an open editor when the learner switches sessions", async () => {
		chatStore.messages = [userMessage("旧问题")];
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "编辑用户消息" }));
		await screen.findByRole("textbox", { name: "编辑消息内容" });

		sessionsStore.selectSession("s2.jsonl");

		await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑消息内容" })).toBeNull());
		expect(api.branch).not.toHaveBeenCalled();
		expect(chatStore.send).not.toHaveBeenCalled();
		expect(appStore.chatDraft).toBe("普通草稿");
	});

	it("refuses to edit when formal learning evidence exists", async () => {
		api.getLearningState.mockResolvedValue({
			exists: true,
			checkpoint: {
				revision: 3, status: "active", step: "feedback", updated_at: "2026-11-05T00:00:00.000Z",
				last_completed_attempt_id: "a1",
			},
			attempts: [],
		});
		chatStore.messages = [userMessage("旧问题"), assistantMessage("旧回答")];
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "编辑用户消息" }));
		expect(await screen.findByText(/正式记录的学习证据/)).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "编辑消息内容" })).toBeNull();
		expect(api.branch).not.toHaveBeenCalled();
		expect(chatStore.send).not.toHaveBeenCalled();
	});

	it("does not send on Ctrl/Cmd+Enter and still sends from the button", async () => {
		render(<LearningWorkspace />);
		const composer = screen.getByRole("textbox", { name: "学习问题" });
		fireEvent.change(composer, { target: { value: "换行优先" } });

		fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
		fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
		expect(chatStore.send).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() => expect(chatStore.send).toHaveBeenCalledWith("换行优先"));
	});

	it("disables model switching and sending while a model switch is in flight", async () => {
		appStore.chatDraft = "等待模型";
		settingsStore.isSavingModel = true;
		render(<LearningWorkspace />);

		expect((screen.getByRole("button", { name: "选择模型" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
		expect(chatStore.send).not.toHaveBeenCalled();
	});

	it("disables editing while a reply is streaming and renders the live text", async () => {
		chatStore.messages = [userMessage("旧问题")];
		chatStore.isSending = true;
		chatStore.streamingText = "正在生成的内容";
		chatStore.streamingActivity = "正在组织回复";
		render(<LearningWorkspace />);

		expect((screen.getByRole("button", { name: "编辑用户消息" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "选择模型" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
		expect(screen.getByTestId("assistant-content").textContent).toBe("正在生成的内容");
	});
});

describe("E1 composer model picker", () => {
	const openModelMenu = async () => {
		fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, pointerType: "mouse" });
	};

	it("switches through the server and only then shows the new selection", async () => {
		vi.mocked(settingsStore.switchModel).mockImplementation(async (provider, model) => {
			settingsStore.settings = settings({ defaultProvider: provider, defaultModel: model });
			(settingsStore as unknown as { emit: (event: "change", data: undefined) => void }).emit("change", undefined);
			return true;
		});
		render(<LearningWorkspace />);
		expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("Dummy");

		await openModelMenu();
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /Other/ }));

		await waitFor(() => expect(settingsStore.switchModel).toHaveBeenCalledWith("fixture", "other"));
		expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("Other");
	});

	it("keeps the old model and reports a failed switch", async () => {
		vi.mocked(settingsStore.switchModel).mockImplementation(async () => {
			settingsStore.error = "模型不可用";
			return false;
		});
		render(<LearningWorkspace />);

		await openModelMenu();
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /Other/ }));

		expect(await screen.findByText("模型不可用")).toBeTruthy();
		expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("Dummy");
		expect(chatStore.send).not.toHaveBeenCalled();
	});

	it("offers a direct entry to model settings when no model is configured", async () => {
		settingsStore.settings = settings({ configuredModels: [] });
		render(<LearningWorkspace />);

		fireEvent.click(screen.getByRole("button", { name: "连接模型" }));
		expect(appStore.activePage).toBe("settings");
		const params = new URLSearchParams(window.location.search);
		expect(params.get("page")).toBe("settings");
		expect(params.get("tab")).toBe("models");
	});
});
