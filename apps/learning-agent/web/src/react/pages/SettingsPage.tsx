import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Archive, Cpu, Info, Settings2 } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { GeneralSettings } from "../settings/GeneralSettings.js";
import { ModelsSettings } from "../settings/ModelsSettings.js";
import { AboutSettings } from "../settings/AboutSettings.js";
import { ArchiveSettings } from "../settings/ArchiveSettings.js";
import { useLocationSearch } from "../shell/use-location-search.js";
import {
	isLegacySettingsTab,
	navigate,
	resolveSettingsTab,
	SETTINGS_TAB_PARAM,
	type SettingsTab,
} from "../shell/navigation.js";

/**
 * Learning-only settings: general, models, archive, about.
 *
 * The tab lives in the URL (`?page=settings&tab=…`) and nowhere else. A click
 * pushes one history entry, browser Back/Forward re-reads the parameter, and a
 * refresh or a shared link lands on the same panel. The removed workbench
 * settings (MCP, workspace, terminal, Office, market) are not restored here.
 *
 * E4.8e merged 「归档会话」 and 「归档课程」 into one 「归档」 tab placed before
 * 「关于」. The retired ids still resolve to it; the address is rewritten with
 * `replace` so the old tab does not linger as a separate history entry.
 */
const TABS: Array<{ id: SettingsTab; labelKey: string; icon: typeof Settings2 }> = [
	{ id: "general", labelKey: "settingsPage.tabs.general", icon: Settings2 },
	{ id: "models", labelKey: "settingsPage.tabs.models", icon: Cpu },
	{ id: "archive", labelKey: "settingsPage.tabs.archive", icon: Archive },
	{ id: "about", labelKey: "settingsPage.tabs.about", icon: Info },
];

export function SettingsPage() {
	const { t } = useTranslation();
	// Subscribe to the URL: the shell does not re-render on a same-page
	// parameter change, so a tab click and Back/Forward both need this read.
	const search = useLocationSearch();
	const requested = new URLSearchParams(search).get(SETTINGS_TAB_PARAM);
	const tab: SettingsTab = resolveSettingsTab(requested) ?? "general";
	const { settings, isLoading, error } = useStoreSnapshot(settingsStore, () => ({
		settings: settingsStore.settings,
		isLoading: settingsStore.isLoading,
		error: settingsStore.error,
	}));

	useEffect(() => {
		void settingsStore.load();
	}, []);

	// A retired archive tab is only a link format: normalise the address in
	// place (replace), so Back does not return to a tab that no longer exists.
	useEffect(() => {
		if (!isLegacySettingsTab(requested)) return;
		navigate("settings", { history: "replace", settingsTab: "archive" });
	}, [requested]);

	return (
		<>
			<div className="mla-page-head">
				<div>
					<h1>{t("settingsPage.title")}</h1>
					<p>{t("settingsPage.subtitle")}</p>
				</div>
			</div>

			<nav className="mla-section-nav" aria-label={t("settingsPage.navLabel")}>
				{TABS.map(({ id, labelKey, icon: Icon }) => (
					<button
						key={id}
						type="button"
						aria-pressed={tab === id}
						onClick={() => {
							if (id === tab) return;
							navigate("settings", { history: "push", settingsTab: id });
						}}
					>
						<Icon size={16} aria-hidden="true" />
						{t(labelKey)}
					</button>
				))}
			</nav>

			{error ? (
				<p className="mla-small" style={{ color: "var(--inno-danger)" }}>{error}</p>
			) : null}

			{tab === "general" ? <GeneralSettings /> : null}
			{tab === "models" ? (
				settings ? <ModelsSettings settings={settings} /> : (
					<p className="mla-small mla-muted">
						{isLoading ? t("settingsPage.loading") : t("settingsPage.unavailable")}
					</p>
				)
			) : null}
			{tab === "archive" ? <ArchiveSettings /> : null}
			{tab === "about" ? <AboutSettings /> : null}
		</>
	);
}
