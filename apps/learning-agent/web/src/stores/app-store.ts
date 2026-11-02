import { EventEmitter } from "./event-emitter.js";

/**
 * Learning shell UI state. The workbench layout state (sidebar width, workspace
 * panel mode, page routing) belonged to the removed full product; only the
 * settings overlay is still needed.
 */
export type SettingsTab = "general" | "models" | "about";

interface AppStoreEvents {
	change: void;
}

class AppStoreImpl extends EventEmitter<AppStoreEvents> {
	settingsOpen = getInitialSettingsOpen();
	activeSettingsTab: SettingsTab = "general";

	openSettings(tab: SettingsTab = "general") {
		this.settingsOpen = true;
		this.activeSettingsTab = tab;
		this.emit("change", undefined);
	}

	closeSettings() {
		if (!this.settingsOpen) return;
		this.settingsOpen = false;
		this.emit("change", undefined);
	}

	setSettingsTab(tab: SettingsTab) {
		if (this.activeSettingsTab === tab) return;
		this.activeSettingsTab = tab;
		this.emit("change", undefined);
	}
}

function getInitialSettingsOpen(): boolean {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("tab") === "settings";
}

export const appStore = new AppStoreImpl();
