import { useTranslation } from "react-i18next";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { SettingsSection } from "./primitives.js";
import { decodeModelKey, encodeModelKey } from "./shared.js";
import { AddProviderWizard } from "./AddProviderWizard.js";
import { MagpieSettings } from "./MagpieSettings.js";

/* ---------- Current model ---------- */

/**
 * The page no longer lists configured models, so this picker is the one place
 * in settings where a saved model can be made current. It reads the same
 * `configuredModels` list the chat composer uses, so both entry points agree.
 */
function CurrentModelPicker({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const { isSavingModel } = useStoreSnapshot(settingsStore, () => ({
		isSavingModel: settingsStore.isSavingModel,
	}));
	const models = settings.configuredModels ?? [];
	const value = encodeModelKey(settings.defaultProvider, settings.defaultModel);
	const current = models.find(
		(model) => model.provider === settings.defaultProvider && model.id === settings.defaultModel,
	);

	return (
		<div className="max-w-md">
			<label className="mb-1 block text-xs font-medium text-[var(--inno-text)]" htmlFor="current-model-select">
				{t("settings.magpie.currentModel", "当前模型")}
			</label>
			<Select
				value={value}
				disabled={isSavingModel || models.length === 0}
				onValueChange={(next) => {
					const parsed = decodeModelKey(next);
					if (parsed) void settingsStore.switchModel(parsed.provider, parsed.model);
				}}
			>
				<SelectTrigger id="current-model-select" className="w-full text-xs" aria-label={t("settings.magpie.currentModel", "当前模型")}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{models.map((model) => (
						<SelectOption
							key={encodeModelKey(model.provider, model.id)}
							value={encodeModelKey(model.provider, model.id)}
							label={`${model.name || model.id} · ${model.provider}`}
						/>
					))}
				</SelectContent>
			</Select>
			<p className="mt-1 text-xs text-[var(--inno-text-subtle)]">
				{current ? current.id : t("settings.magpie.currentModelHint", "模型来自下方已保存的配置；在对话页也可以直接切换。")}
			</p>
		</div>
	);
}

/* ---------- Models category page ---------- */

export function ModelsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const { storeError } = useStoreSnapshot(settingsStore, () => ({
		storeError: settingsStore.error,
	}));

	return (
		<SettingsSection title={t("settings.tabs.models")} description={t("settings.sections.models.desc", "配置模型提供商与默认模型")}>
			{storeError ? <div className="rounded bg-[var(--inno-danger-bg)] p-2 text-sm text-[var(--inno-danger)]">{storeError}</div> : null}
			<CurrentModelPicker settings={settings} />

			<div>
				<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.magpie.directTitle", "A. 直接 API 接入")}</h3>
				<p className="mb-2 text-xs text-[var(--inno-text-muted)]">
					{t("settings.magpie.directDesc", "保留原有厂商配置；已保存的密钥与模型继续可用。")}
				</p>
				<AddProviderWizard providers={settings.providers} />
			</div>

			<div className="mt-7">
				<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.magpie.gatewayTitle", "B. Magpie 本地网关接入")}</h3>
				<p className="mb-2 text-xs text-[var(--inno-text-muted)]">
					{t("settings.magpie.gatewayDesc", "适用于本机已安装 Magpie 的情况；它自行管理 ZCode、Trae、Codex 等上游账号。")}
				</p>
				<MagpieSettings settings={settings} />
			</div>
		</SettingsSection>
	);
}
