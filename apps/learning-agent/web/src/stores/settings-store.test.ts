import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InnoSettings } from "../types/settings.js";

const api = vi.hoisted(() => ({
	getSettings: vi.fn(),
	switchBackendModel: vi.fn(),
}));

vi.mock("../api/settings.js", async () => {
	const actual = await vi.importActual<typeof import("../api/settings.js")>("../api/settings.js");
	return { ...actual, getSettings: api.getSettings, switchBackendModel: api.switchBackendModel };
});

import { settingsStore } from "./settings-store.js";

const base = (provider: string, model: string): InnoSettings => ({
	defaultProvider: provider,
	defaultModel: model,
	providers: {},
	configuredModels: [],
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	settingsStore.settings = base("old-provider", "old-model");
	settingsStore.isSavingModel = false;
	settingsStore.error = null;
});

describe("settingsStore.switchModel", () => {
	it("keeps the old selection until the server confirms, then updates it", async () => {
		const gate = deferred<void>();
		api.switchBackendModel.mockImplementation(async () => {
			await gate.promise;
			return { defaultProvider: "new-provider", defaultModel: "new-model" };
		});
		api.getSettings.mockResolvedValue(base("new-provider", "new-model"));

		const switching = settingsStore.switchModel("new-provider", "new-model");
		expect(settingsStore.isSavingModel).toBe(true);
		expect(settingsStore.settings?.defaultModel).toBe("old-model");

		gate.resolve();
		await expect(switching).resolves.toBe(true);
		expect(settingsStore.isSavingModel).toBe(false);
		expect(settingsStore.settings?.defaultProvider).toBe("new-provider");
		expect(settingsStore.settings?.defaultModel).toBe("new-model");
		expect(settingsStore.error).toBeNull();
	});

	it("returns false and keeps the old selection when the server rejects", async () => {
		api.switchBackendModel.mockRejectedValue(new Error("模型不可用"));

		await expect(settingsStore.switchModel("new-provider", "new-model")).resolves.toBe(false);
		expect(settingsStore.settings?.defaultProvider).toBe("old-provider");
		expect(settingsStore.settings?.defaultModel).toBe("old-model");
		expect(settingsStore.error).toBe("模型不可用");
		expect(settingsStore.isSavingModel).toBe(false);
	});
});
