import { EventEmitter } from "./event-emitter.js";
import { getSettings, switchBackendModel, upsertProvider, deleteProviderApi, deleteModelApi, saveCloseBehavior, saveMarkdownSettings } from "../api/settings.js";
import type { WindowCloseBehavior } from "../types/settings.js";
import type { InnoSettings, UpsertProviderRequest } from "../types/settings.js";

interface SettingsStoreEvents {
	change: void;
}

class SettingsStoreImpl extends EventEmitter<SettingsStoreEvents> {
	settings: InnoSettings | null = null;
	isLoading = false;
	isSavingModel = false;
	isSavingProvider = false;
	isSavingCloseBehavior = false;
	isSavingMarkdown = false;
	error: string | null = null;

	async load(): Promise<void> {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await getSettings();
		} catch (err) {
			this.settings = null;
			this.error = err instanceof Error ? err.message : "Failed to load settings";
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	/** Returns true only after the server confirmed the switch and settings reloaded. */
	async switchModel(provider: string, model: string): Promise<boolean> {
		this.isSavingModel = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Switch model timed out")), 10_000),
			);
			const next = await Promise.race([switchBackendModel(provider, model), timeout]);
			if (this.settings) {
				this.settings = {
					...this.settings,
					defaultProvider: next.defaultProvider,
					defaultModel: next.defaultModel,
				};
			}
			await this.load();
			return true;
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to switch model";
			this.emit("change", undefined);
			return false;
		} finally {
			this.isSavingModel = false;
			this.emit("change", undefined);
		}
	}

	async saveProvider(payload: UpsertProviderRequest): Promise<void> {
		this.isSavingProvider = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await upsertProvider(payload);
			await this.load();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save provider";
			this.emit("change", undefined);
		} finally {
			this.isSavingProvider = false;
			this.emit("change", undefined);
		}
	}

	async deleteProvider(providerId: string): Promise<void> {
		this.isSavingProvider = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await deleteProviderApi(providerId);
			await this.load();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to delete provider";
			this.emit("change", undefined);
		} finally {
			this.isSavingProvider = false;
			this.emit("change", undefined);
		}
	}

	async deleteModel(providerId: string, modelId: string): Promise<void> {
		this.isSavingProvider = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await deleteModelApi(providerId, modelId);
			await this.load();
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to delete model";
			this.emit("change", undefined);
		} finally {
			this.isSavingProvider = false;
			this.emit("change", undefined);
		}
	}








	async saveCloseBehavior(closeBehavior: WindowCloseBehavior): Promise<void> {
		this.isSavingCloseBehavior = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await saveCloseBehavior(closeBehavior);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save close behavior";
			this.emit("change", undefined);
			throw err;
		} finally {
			this.isSavingCloseBehavior = false;
			this.emit("change", undefined);
		}
	}

	async saveMathSingleDollar(enabled: boolean): Promise<void> {
		this.isSavingMarkdown = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.settings = await saveMarkdownSettings(enabled);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Failed to save Markdown settings";
			this.emit("change", undefined);
			throw err;
		} finally {
			this.isSavingMarkdown = false;
			this.emit("change", undefined);
		}
	}




}

export const settingsStore = new SettingsStoreImpl();
