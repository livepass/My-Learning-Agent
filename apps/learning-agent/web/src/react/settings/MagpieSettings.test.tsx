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
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }) }));
vi.mock("../../api/settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api/settings.js")>();
	return {
		...actual,
		probeMagpieGateway: api.probeMagpieGateway,
		fetchMagpieCatalog: api.fetchMagpieCatalog,
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
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Magpie settings (E3.1)", () => {
	it("keeps all seven direct-API entries and adds a separate Magpie section", () => {
		expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
			"deepseek", "kimi", "minimax", "volcengine", "xiaomimimo", "bailian", "custom",
		]);
		render(<ModelsSettings settings={settings()} />);
		expect(screen.getByText("settings.magpie.directTitle")).toBeTruthy();
		expect(screen.getByText("settings.magpie.gatewayTitle")).toBeTruthy();
		expect(screen.getByText("settings.magpie.title")).toBeTruthy();
		fireEvent.click(screen.getByText("settings.newProvider"));
		for (const preset of PROVIDER_PRESETS) {
			expect(screen.getAllByText(preset.name).length).toBeGreaterThan(0);
		}
	});

	it("shows the connected gateway identity after a successful check", async () => {
		render(<ModelsSettings settings={settings()} />);
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
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.check/ }));
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "无法连接 Magpie 网关，请确认它正在运行");
		expect(settingsStore.saveProvider).not.toHaveBeenCalled();
		expect(screen.getByText("DeepSeek Chat")).toBeTruthy();
	});

	it("renders real metadata, preserves model ids and saves only the magpie provider", async () => {
		render(<ModelsSettings settings={settings()} />);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.fetch/ }));
		expect((await screen.findAllByText(/bailian\/qwen3.8-flash/)).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/routing\/study/).length).toBeGreaterThan(0);
		expect(screen.getByText(/131k context/)).toBeTruthy();
		// Missing metadata is not presented as confirmed.
		expect(screen.getByText(/settings\.magpie\.contextUnknown/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.save/ }));
		await waitFor(() => expect(settingsStore.saveProvider).toHaveBeenCalledOnce());
		const payload = vi.mocked(settingsStore.saveProvider).mock.calls[0][0];
		expect(payload.providerId).toBe("magpie");
		expect(payload.baseUrl).toBe("http://127.0.0.1:3425/v1");
		expect(payload.preserveApiKey).toBe(true);
		expect(payload.models.map((model) => model.id)).toEqual(["bailian/qwen3.8-flash"]);
		expect(payload.models[0]).toMatchObject({
			name: "Qwen 3.8 Flash",
			reasoning: true,
			api: "openai-completions",
			// OpenAI protocols live under /v1 on the gateway.
			baseUrl: "http://127.0.0.1:3425/v1",
			input: ["text", "image"],
			contextWindow: 131_072,
		});
	});

	it("gives an Anthropic model the gateway root so it does not POST to /v1/v1/messages", async () => {
		render(<ModelsSettings settings={settings()} />);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.fetch/ }));
		await screen.findAllByText(/bailian\/qwen3.8-flash/);
		const select = screen.getByLabelText("settings.magpie.protocol");
		fireEvent.click(select);
		const option = await screen.findByText("anthropic-messages");
		fireEvent.click(option);

		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.save/ }));
		await waitFor(() => expect(settingsStore.saveProvider).toHaveBeenCalledOnce());
		const payload = vi.mocked(settingsStore.saveProvider).mock.calls[0][0];
		expect(payload.models[0]).toMatchObject({
			id: "bailian/qwen3.8-flash",
			api: "anthropic-messages",
			baseUrl: "http://127.0.0.1:3425",
		});
	});

	it("re-saving without a fresh fetch keeps the saved model's confirmed capabilities", async () => {
		render(<ModelsSettings settings={magpieSettings()} />);
		// No fetch: the picker has no discovery entries, only the saved models.
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.save/ }));
		await waitFor(() => expect(settingsStore.saveProvider).toHaveBeenCalledOnce());
		const payload = vi.mocked(settingsStore.saveProvider).mock.calls[0][0];
		expect(payload.models.map((model) => model.id)).toEqual(["bailian/qwen3.8-flash", "routing/study"]);
		// The saved context/max output are not reset to the conservative defaults.
		expect(payload.models[0]).toMatchObject({ contextWindow: 131_072, maxTokens: 8_192 });
		// The saved per-model protocol survives, and each model carries its own base URL.
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
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.fetch/ }));
		expect(await screen.findByText("网关当前没有启用的聊天模型，请在 Magpie 中启用后再刷新。")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("settings.magpie.manual"), { target: { value: "vendor/manual-model" } });
		fireEvent.click(screen.getByRole("button", { name: "settings.magpie.addManual" }));
		expect(screen.getAllByText("vendor/manual-model").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.save/ }));
		await waitFor(() => expect(settingsStore.saveProvider).toHaveBeenCalled());
		const payload = vi.mocked(settingsStore.saveProvider).mock.calls[0][0];
		expect(payload.models[0]).toMatchObject({ id: "vendor/manual-model", contextWindow: 128_000, maxTokens: 8_192 });
	});

	it("surfaces a failed switch without claiming the model is active", async () => {
		vi.mocked(settingsStore.switchModel).mockResolvedValue(false);
		settingsStore.error = "Model magpie/routing/study not found";
		render(<ModelsSettings settings={magpieSettings()} />);
		const rows = screen.getAllByTestId("magpie-saved-model");
		const other = rows.find((row) => row.textContent?.includes("routing/study"));
		fireEvent.click(within(other!).getByRole("button", { name: "settings.use" }));
		await waitFor(() => expect(settingsStore.switchModel).toHaveBeenCalledWith("magpie", "routing/study"));
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Model magpie/routing/study not found");
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
		fireEvent.click(screen.getByRole("button", { name: /settings.magpie.fetch/ }));
		// routing/study is saved but gone from the catalog.
		expect(await screen.findByText(/settings\.magpie\.removed/)).toBeTruthy();
		expect(screen.getAllByText(/routing\/study/).length).toBeGreaterThan(0);
	});

	it("switches and deletes saved Magpie models, hiding delete for the current one", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<ModelsSettings settings={magpieSettings()} />);
		expect(screen.getByText("settings.magpie.savedModels")).toBeTruthy();
		const rows = screen.getAllByTestId("magpie-saved-model");
		const current = rows.find((row) => row.textContent?.includes("bailian/qwen3.8-flash"));
		const other = rows.find((row) => row.textContent?.includes("routing/study"));
		expect(current).toBeTruthy();
		expect(other).toBeTruthy();
		expect(within(current!).queryByRole("button", { name: "common.delete bailian/qwen3.8-flash" })).toBeNull();

		fireEvent.click(within(other!).getByRole("button", { name: "settings.use" }));
		await waitFor(() => expect(settingsStore.switchModel).toHaveBeenCalledWith("magpie", "routing/study"));

		fireEvent.click(within(other!).getByRole("button", { name: "common.delete routing/study" }));
		await waitFor(() => expect(settingsStore.deleteModel).toHaveBeenCalledWith("magpie", "routing/study"));
	});
});
