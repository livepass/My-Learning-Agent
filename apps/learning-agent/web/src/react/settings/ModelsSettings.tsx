import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug, ServerCog } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { Tabs, TabPanel, getTabTriggerId } from "../ui/index.js";
import { CurrentModelCard } from "./CurrentModelCard.js";
import { AddProviderWizard } from "./AddProviderWizard.js";
import { MagpieSettings } from "./MagpieSettings.js";
import { MAGPIE_PROVIDER_ID } from "../../../../src/shared/magpie.js";

/**
 * Which configuration panel is open. This is a view preference, not the
 * active model: it starts on the channel that owns the current model so the
 * page opens on the configuration the user actually uses, and switching it
 * never changes the default model.
 */
type Channel = "api" | "magpie";

const TABS_ID = "settings-model-channel";

export function ModelsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const { storeError } = useStoreSnapshot(settingsStore, () => ({
		storeError: settingsStore.error,
	}));
	const [channel, setChannel] = useState<Channel>(() =>
		settings.defaultProvider === MAGPIE_PROVIDER_ID ? "magpie" : "api",
	);

	return (
		<div className="grid gap-4">
			<div>
				<h2 className="text-base font-semibold text-[var(--inno-text)]">{t("settings.models.title", "模型连接")}</h2>
				<p className="mt-1 text-sm text-[var(--inno-text-muted)]">
					{t("settings.sections.models.desc", "管理 AI 学习所使用的模型与接入方式")}
				</p>
			</div>

			{storeError ? <div className="rounded bg-[var(--inno-danger-bg)] p-2 text-sm text-[var(--inno-danger)]">{storeError}</div> : null}

			<CurrentModelCard settings={settings} />

			<div>
				<Tabs
					id={TABS_ID}
					value={channel}
					onValueChange={(next) => setChannel(next as Channel)}
					ariaLabel={t("settings.models.channelTabs", "接入方式")}
					size="sm"
					spacing="comfortable"
					items={[
						{ value: "api", label: <><Plug size={14} aria-hidden="true" /> {t("settings.models.channelApi", "API 接入")}</>, panelId: `${TABS_ID}-panel` },
						{ value: "magpie", label: <><ServerCog size={14} aria-hidden="true" /> {t("settings.models.channelMagpie", "Magpie 接入")}</>, panelId: `${TABS_ID}-panel` },
					]}
				/>
				<TabPanel labelledBy={getTabTriggerId(TABS_ID, channel)} className="mt-4">
					{channel === "api" ? (
						<div className="grid gap-2">
							<div className="flex flex-wrap items-end justify-between gap-2">
								<div>
									<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.models.vendorTitle", "选择模型厂商")}</h3>
									<p className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
										{t("settings.models.vendorDesc", "已保存的厂商配置与密钥继续可用；选择厂商后进入配置表单。")}
									</p>
								</div>
							</div>
							<AddProviderWizard providers={settings.providers} />
						</div>
					) : (
						<MagpieSettings settings={settings} />
					)}
				</TabPanel>
			</div>
		</div>
	);
}
