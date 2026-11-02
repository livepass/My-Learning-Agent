import { useEffect, useState } from "react";
import { Cpu, Info, Settings2 } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { GeneralSettings } from "../settings/GeneralSettings.js";
import { ModelsSettings } from "../settings/ModelsSettings.js";
import { AboutSettings } from "../settings/AboutSettings.js";

/** Learning-only settings: appearance/general, models, about. */
const TABS = [
	{ id: "general", label: "通用与外观", icon: Settings2 },
	{ id: "models", label: "模型连接", icon: Cpu },
	{ id: "about", label: "关于", icon: Info },
] as const;

type SettingsTabId = (typeof TABS)[number]["id"];

/**
 * 系统设置 — reuses the existing general/model/about settings components.
 * The removed workbench settings (MCP, workspace, terminal, Office, market)
 * are not restored here.
 */
export function SettingsPage() {
	const [tab, setTab] = useState<SettingsTabId>("general");
	const { settings, isLoading, error } = useStoreSnapshot(settingsStore, () => ({
		settings: settingsStore.settings,
		isLoading: settingsStore.isLoading,
		error: settingsStore.error,
	}));

	useEffect(() => {
		void settingsStore.load();
	}, []);

	return (
		<>
			<div className="mla-page-head">
				<div>
					<h1>系统设置</h1>
					<p>配置模型与学习记忆，让学习过程清楚、可靠。</p>
				</div>
			</div>

			<nav className="mla-section-nav" aria-label="系统设置内容">
				{TABS.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						aria-pressed={tab === id}
						onClick={() => setTab(id)}
					>
						<Icon size={16} aria-hidden="true" />
						{label}
					</button>
				))}
			</nav>

			{error ? (
				<p className="mla-small" style={{ color: "var(--inno-danger)" }}>{error}</p>
			) : null}

			{tab === "general" ? <GeneralSettings /> : null}
			{tab === "models" ? (
				settings ? <ModelsSettings settings={settings} /> : (
					<p className="mla-small mla-muted">{isLoading ? "正在读取设置…" : "设置暂不可用。"}</p>
				)
			) : null}
			{tab === "about" ? <AboutSettings /> : null}
		</>
	);
}
