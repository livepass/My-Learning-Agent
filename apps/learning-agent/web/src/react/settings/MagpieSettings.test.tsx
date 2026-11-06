import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { ModelsSettings } from "./ModelsSettings.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";

const api = vi.hoisted(() => ({
	probeMagpieGateway: vi.fn(),
	fetchMagpieCatalog: vi.fn(),
	verifyCurrentModel: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }) }));
vi.mock("../../api/settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api/settings.js")>();
	return {
		...actual,
		probeMagpieGateway: api.probeMagpieGateway,
		fetchMagpieCatalog: api.fetchMagpieCatalog,
		verifyCurrentModel: api.verifyCurrentModel,
	};
});

const directModel = {
	id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", reasoning: false,
	input: ["text"] as Array<"text" | "image">, contextWindow: 64_000, maxTokens: 8_192,
};

function settings(overrides: Partial<InnoSettings> = {}): InnoSettings {
	return {
		defaultProvider: "deepseek",
		defaultModel: "deepseek-chat",
		configuredModels: [directModel],
		availableModels: [directModel],
		providers: {
			deepseek: {
				baseUrl: "https://api.deepseek.com/v1",
				apiKey: "****cret",
				api: "openai-completions",
				models: [{ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 8_192 }],
			},
		},
		...overrides,
	};
}

function magpieSettings(): InnoSettings {
	const base = settings();
	return {
		...base,
		defaultProvider: "magpie",
		defaultModel: "bailian/qwen3.8-flash",
		configuredModels: [
			directModel,
			{ id: "bailian/qwen3.8-flash", name: "Qwen", provider: "magpie", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 8_192 },
			{ id: "routing/study", name: "Study", provider: "magpie", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
		],
		providers: {
			...base.providers,
			magpie: {
				baseUrl: "http://127.0.0.1:3425/v1",
				apiKey: "****gent",
				api: "openai-completions",
				models: [
					{ id: "bailian/qwen3.8-flash", name: "Qwen", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 8_192 },
					{ id: "routing/study", name: "Study", reasoning: true, api: "anthropic-messages", input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
				],
			},
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Radix Select scrolls its highlighted item into view, which jsdom does not
	// implement; without the stub opening the menu throws from a passive effect.
	Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), writable: true, configurable: true });
	settingsStore.error = null;
	settingsStore.isSavingProvider = false;
	settingsStore.isSavingModel = false;
	vi.spyOn(settingsStore, "saveProvider").mockResolvedValue(undefined);
	vi.spyOn(settingsStore, "switchModel").mockResolvedValue(true);
	vi.spyOn(settingsStore, "deleteModel").mockResolvedValue(undefined);
	vi.spyOn(settingsStore, "load").mockResolvedValue(undefined);
	api.probeMagpieGateway.mockResolvedValue({
		ok: true,
		gateway: { name: "magpie", version: "0.1.2626" },
		gatewayUrl: "http://127.0.0.1:3425",
	});
	api.fetchMagpieCatalog.mockResolvedValue({
		ok: true,
		gateway: { name: "magpie", version: "0.1.2626" },
		gatewayUrl: "http://127.0.0.1:3425",
		models: [
			{
				id: "bailian/qwen3.8-flash",
				displayName: "Qwen 3.8 Flash",
				ownedBy: "bailian",
				reasoning: true,
				contextWindow: 131_072,
				maxTokens: 8_192,
				input: ["text", "image"],
				confirmed: { contextWindow: true, maxTokens: true, reasoning: true, input: true },
			},
			{
				id: "routing/study",
				displayName: "Study route",
				confirmed: { contextWindow: false, maxTokens: false, reasoning: false, input: false },
			},
		],
		warnings: ["部分模型未提供上下文或最大输出信息，保存时会使用保守默认值，且不会标记为已确认。"],
	});
	api.verifyCurrentModel.mockResolvedValue({ status: "ok", defaultProvider: "deepseek", defaultModel: "deepseek-chat" });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Models settings page (E3.1 UI v2)", () => {
	it("renders title, current-model card, channel tabs, then the vendor grid", () => {
		render(<ModelsSettings settings={settings()} />);
		expect(screen.getByText("settings.models.title")).toBeTruthy();
		expect(screen.getByText("settings.models.currentModel")).toBeTruthy();
		expect(screen.getByRole("tab", { name: /settings.models.channelApi/ })).toBeTruthy();
		expect(screen.getByRole("tab", { name: /settings.models.channelMagpie/ })).toBeTruthy();
		expect(screen.getByText("settings.models.vendorTitle")).toBeTruthy();
		// The old configured-model list is not back.
		expect(screen.queryByText("settings.models")).toBeNull();
		expect(screen.queryByRole("button", { name: "common.edit" })).toBeNull();
	});

	it("keeps all seven direct-API vendor entries in the API panel", () => {
		expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
			"deepseek", "kimi", "minimax", "volcengine", "xiaomimimo", "bailian", "custom",
		]);
		render(<ModelsSettings settings={settings()} />);
		for (const preset of PROVIDER_PRESETS) {
			expect(screen.getAllByText(preset.name).length).toBeGreaterThan(0);
		}
		// The grid is the page's content now, not a collapsed "add model" disclosure.
		expect(screen.queryByText("settings.newProvider")).toBeNull();
	});

	it("opens the channel that owns the current model and keeps it a view preference", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		const magpieTab = screen.getByRole("tab", { name: /settings.models.channelMagpie/ });
		expect(magpieTab.getAttribute("aria-selected")).toBe("true");
		// The Magpie panel is open; no vendor grid in this panel.
		expect(screen.getByText("settings.magpie.title")).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: /settings.models.channelApi/ }));
		await waitFor(() => expect(screen.getByText("settings.models.vendorTitle")).toBeTruthy());
		// Switching panels never switches the model.
		expect(settingsStore.switchModel).not.toHaveBeenCalled();
	});

	it("never prints an internal provider id as the current model's source", () => {
		// `example` is the placeholder key written into config.json; the learner
		// never named it, so the card must fall back to the channel label.
		const base = settings();
		render(<ModelsSettings
			settings={{
				...base,
				defaultProvider: "example",
				defaultModel: "qwen3.8-flash",
				configuredModels: [{ id: "qwen3.8-flash", name: "qwen3.8-flash", provider: "example", reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096 }],
			}}
		/>);
		expect(screen.queryByText("example")).toBeNull();
		expect(screen.getAllByText("settings.models.sourceApi").length).toBeGreaterThan(0);
	});

	it("keeps the brand name for a known vendor and hides unknown ids", () => {
		render(<ModelsSettings settings={settings()} />);
		expect(screen.getAllByText("DeepSeek").length).toBeGreaterThan(0);
		expect(screen.queryByText("deepseek")).toBeNull();
	});

	it("switches the current model across both channels and shows its source", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		const picker = screen.getByLabelText("settings.models.switch");
		fireEvent.click(picker);
		const option = await screen.findByText("DeepSeek Chat · settings.models.tagApi");
		fireEvent.click(option);
		await waitFor(() => expect(settingsStore.switchModel).toHaveBeenCalledWith("deepseek", "deepseek-chat"));
		// Both sources are offered in one picker, and the card keeps showing the
		// confirmed model until the store reports a successful switch.
		expect(screen.getAllByText("Qwen").length).toBeGreaterThan(0);
	});

	it("keeps the old model and surfaces the error when switching fails", async () => {
		vi.mocked(settingsStore.switchModel).mockResolvedValue(false);
		settingsStore.error = "Model magpie/routing/study not found";
		render(<ModelsSettings settings={magpieSettings()} />);
		fireEvent.click(screen.getByLabelText("settings.models.switch"));
		const option = await screen.findByText("Study · settings.models.tagMagpie");
		fireEvent.click(option);
		await waitFor(() => expect(settingsStore.switchModel).toHaveBeenCalledWith("magpie", "routing/study"));
		// The failure banner comes from the store; the card itself never claims
		// the new model became current.
		expect(await screen.findByText("Model magpie/routing/study not found")).toBeTruthy();
		expect(screen.queryByText("settings.models.ready")).toBeNull();
	});

	it("never equates a reachable gateway with a ready model", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		// Gateway check succeeds, but the model has not been called yet.
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.check/ }));
		expect(await screen.findByText(/settings.magpie.connectedShort/)).toBeTruthy();
		expect(screen.getByText("settings.models.unverified")).toBeTruthy();
		expect(screen.queryByText("settings.models.ready")).toBeNull();
		expect(api.verifyCurrentModel).not.toHaveBeenCalled();
	});

	it("reports model readiness only after a real completion", async () => {
		render(<ModelsSettings settings={settings()} />);
		fireEvent.click(screen.getByRole("button", { name: "settings.models.verifyAction" }));
		await waitFor(() => expect(api.verifyCurrentModel).toHaveBeenCalledOnce());
		expect(await screen.findByText("settings.models.ready")).toBeTruthy();
	});

	it("does not claim readiness when the model call fails", async () => {
		api.verifyCurrentModel.mockResolvedValue({ status: "not_ready", reason: "no_credentials" });
		render(<ModelsSettings settings={settings()} />);
		fireEvent.click(screen.getByRole("button", { name: "settings.models.verifyAction" }));
		expect(await screen.findByText("settings.models.notReady")).toBeTruthy();
		expect(screen.getByText("settings.models.verify.noCredentials")).toBeTruthy();
		expect(screen.queryByText("settings.models.ready")).toBeNull();
	});

	it("shows the connected gateway identity and version", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.check/ }));
		await waitFor(() => expect(api.probeMagpieGateway).toHaveBeenCalledWith({
			gatewayUrl: "http://127.0.0.1:3425",
			gatewayKey: "",
		}));
		expect(await screen.findByText(/settings.magpie.connectedShort/)).toBeTruthy();
		expect(api.fetchMagpieCatalog).not.toHaveBeenCalled();
	});

	it("surfaces a gateway failure without saving anything", async () => {
		api.probeMagpieGateway.mockRejectedValue(new Error("无法连接 Magpie 网关，请确认它正在运行"));
		render(<ModelsSettings settings={settings()} />);
		// The API panel is open; switch to Magpie to reach its controls.
		fireEvent.click(screen.getByRole("tab", { name: /settings.models.channelMagpie/ }));
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.check/ }));
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "无法连接 Magpie 网关，请确认它正在运行");
		expect(settingsStore.saveProvider).not.toHaveBeenCalled();
		// The direct-API model is still current and still selectable.
		expect(screen.getByLabelText("settings.models.switch")).toBeTruthy();
	});

	it("lists discovered models with real metadata and marks the current one", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.refresh/ }));
		expect((await screen.findAllByText(/bailian\/qwen3.8-flash/)).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/routing\/study/).length).toBeGreaterThan(0);
		// The status card also shows the current model's context; assert within
		// the model row instead of the whole page.
		const currentRow = screen.getAllByTestId("magpie-model-row").find((row) => row.getAttribute("data-current") === "true");
		expect(currentRow?.textContent).toContain("131k context");
		// Missing metadata is not presented as confirmed.
		expect(screen.getByText("settings.magpie.contextUnknownShort")).toBeTruthy();
		expect(currentRow?.textContent).toContain("settings.models.currentTag");
	});

	it("refresh does not change the default model", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.refresh/ }));
		await screen.findAllByText(/bailian\/qwen3.8-flash/);
		expect(settingsStore.switchModel).not.toHaveBeenCalled();
		expect(settingsStore.saveProvider).not.toHaveBeenCalled();
	});

	it("saves only the magpie provider with per-model protocol and base URL", async () => {
		render(<ModelsSettings settings={settings()} />);
		fireEvent.click(screen.getByRole("tab", { name: /settings.models.channelMagpie/ }));
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.refresh/ }));
		await screen.findAllByText(/bailian\/qwen3.8-flash/);
		const select = screen.getByLabelText("settings.magpie.protocol bailian/qwen3.8-flash");
		fireEvent.click(select);
		fireEvent.click(await screen.findByText("anthropic-messages"));

		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.save/ }));
		await waitFor(() => expect(settingsStore.saveProvider).toHaveBeenCalledOnce());
		const payload = vi.mocked(settingsStore.saveProvider).mock.calls[0][0];
		expect(payload.providerId).toBe("magpie");
		expect(payload.baseUrl).toBe("http://127.0.0.1:3425/v1");
		expect(payload.preserveApiKey).toBe(true);
		expect(payload.models[0]).toMatchObject({
			id: "bailian/qwen3.8-flash",
			api: "anthropic-messages",
			baseUrl: "http://127.0.0.1:3425",
			contextWindow: 131_072,
		});
	});

	it("puts the protocol label, dropdown and actions on their own lines", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		const row = screen.getAllByTestId("magpie-model-row").find((item) => item.getAttribute("data-current") === "true");
		expect(row).toBeTruthy();
		const select = screen.getByLabelText("settings.magpie.protocol bailian/qwen3.8-flash");
		const label = document.querySelector('label[for="magpie-protocol-bailian-qwen3-8-flash"]');
		expect(label?.textContent).toBe("settings.magpie.protocol");
		// The label is a sibling above the control, not inline beside the name.
		expect(label?.parentElement?.contains(select)).toBe(true);
		expect(row!.querySelector("input[type=checkbox]")).toBeTruthy();
		// The dropdown is wide enough for every protocol name without wrapping.
		expect(select.className).toContain("min-w-[200px]");
	});

	it("re-saving without a fresh fetch keeps the saved model's confirmed capabilities", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.save/ }));
		await waitFor(() => expect(settingsStore.saveProvider).toHaveBeenCalledOnce());
		const payload = vi.mocked(settingsStore.saveProvider).mock.calls[0][0];
		expect(payload.models.map((model) => model.id)).toEqual(["bailian/qwen3.8-flash", "routing/study"]);
		expect(payload.models[0]).toMatchObject({ contextWindow: 131_072, maxTokens: 8_192 });
		expect(payload.models[1]).toMatchObject({ api: "anthropic-messages", baseUrl: "http://127.0.0.1:3425" });
	});

	it("allows an unverified manual model id when discovery returns nothing", async () => {
		api.fetchMagpieCatalog.mockResolvedValue({
			ok: true,
			gateway: { name: "magpie" },
			gatewayUrl: "http://127.0.0.1:3425",
			models: [],
			warnings: ["网关当前没有启用的聊天模型，请在 Magpie 中启用后再刷新。"],
		});
		render(<ModelsSettings settings={settings()} />);
		fireEvent.click(screen.getByRole("tab", { name: /settings.models.channelMagpie/ }));
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.refresh/ }));
		expect(await screen.findByText("网关当前没有启用的聊天模型，请在 Magpie 中启用后再刷新。")).toBeTruthy();
		expect(screen.getByText("settings.magpie.empty")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("settings.magpie.manual"), { target: { value: "vendor/manual-model" } });
		fireEvent.click(screen.getByRole("button", { name: "settings.magpie.addManual" }));
		expect(screen.getAllByText("vendor/manual-model").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.save/ }));
		await waitFor(() => expect(settingsStore.saveProvider).toHaveBeenCalled());
		const payload = vi.mocked(settingsStore.saveProvider).mock.calls[0][0];
		expect(payload.models[0]).toMatchObject({ id: "vendor/manual-model", contextWindow: 128_000, maxTokens: 8_192 });
	});

	it("warns about saved models the gateway no longer lists but keeps them selectable", async () => {
		api.fetchMagpieCatalog.mockResolvedValue({
			ok: true,
			gateway: { name: "magpie" },
			gatewayUrl: "http://127.0.0.1:3425",
			models: [{
				id: "bailian/qwen3.8-flash",
				displayName: "Qwen 3.8 Flash",
				confirmed: { contextWindow: true, maxTokens: true, reasoning: false, input: false },
				contextWindow: 131_072,
				maxTokens: 8_192,
			}],
			warnings: [],
		});
		render(<ModelsSettings settings={magpieSettings()} />);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.refresh/ }));
		expect(await screen.findByText(/settings\.magpie\.removed/)).toBeTruthy();
		expect(screen.getByText("settings.magpie.goneUpstream")).toBeTruthy();
		expect(screen.getAllByText(/routing\/study/).length).toBeGreaterThan(0);
	});

	it("activates a saved Magpie model through the switch endpoint", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		const rows = screen.getAllByTestId("magpie-model-row");
		const other = rows.find((row) => row.textContent?.includes("routing/study"));
		fireEvent.click(within(other!).getByRole("button", { name: "settings.use" }));
		await waitFor(() => expect(settingsStore.switchModel).toHaveBeenCalledWith("magpie", "routing/study"));
	});

	it("deletes a saved Magpie model and hides delete for the current one", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ModelsSettings settings={magpieSettings()} />);
		const rows = screen.getAllByTestId("magpie-model-row");
		const current = rows.find((row) => row.getAttribute("data-current") === "true");
		const other = rows.find((row) => row.textContent?.includes("routing/study"));
		expect(current).toBeTruthy();
		expect(within(current!).queryByRole("button", { name: "common.delete bailian/qwen3.8-flash" })).toBeNull();
		fireEvent.click(within(other!).getByRole("button", { name: "common.delete routing/study" }));
		await waitFor(() => expect(settingsStore.deleteModel).toHaveBeenCalledWith("magpie", "routing/study"));
	});

	it("never echoes the stored gateway key in plain text", () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		const keyInput = screen.getByLabelText("settings.magpie.gatewayKey") as HTMLInputElement;
		expect(keyInput.type).toBe("password");
		expect(keyInput.value).toBe("");
		expect(document.body.textContent).not.toContain("****gent");
	});
});
