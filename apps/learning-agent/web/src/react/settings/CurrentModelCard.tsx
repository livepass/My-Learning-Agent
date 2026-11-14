import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { verifyCurrentModel, type ModelVerifyResult } from "../../api/settings.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoModelInfo, InnoSettings } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { IconButton, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { SettingsCard } from "./primitives.js";
import { decodeModelKey, encodeModelKey, formatTokens } from "./shared.js";
import { findPreset } from "./provider-presets.js";
import { MAGPIE_PROVIDER_ID } from "../../../../src/shared/magpie.js";

/**
 * Readiness of the *current model*, never of its transport.
 *
 * A gateway answering /api/hello only proves the gateway is up; a configured
 * key only proves a credential exists. Neither is evidence that this model can
 * serve a request, so the card stays "未检测" until a real completion through
 * the active model succeeds. The Magpie panel owns the separate gateway
 * connection state; the two are never merged into one indicator.
 */
type Readiness =
	| { state: "unknown" }
	| { state: "checking" }
	| { state: "ready" }
	| { state: "failed"; message: string };

/** i18next `t` with an inline Chinese fallback, the project's migration form. */
type Translate = (key: string, fallback: string) => string;

function outcomeMessage(outcome: ModelVerifyResult, t: Translate): string | null {
	switch (outcome.status) {
		case "ok":
			return null;
		case "not_ready":
			switch (outcome.reason) {
				case "agent_not_initialized":
					return t("settings.models.verify.starting", "模型服务尚未就绪，请稍后重试。");
				case "no_model":
					return t("settings.models.verify.noModel", "当前没有选中的模型。");
				default:
					return t("settings.models.verify.noCredentials", "该模型缺少可用的 API Key。");
			}
		case "timeout":
			return t("settings.models.verify.timeout", "调用超时，未能确认模型可用。");
		case "aborted":
			return t("settings.models.verify.aborted", "检测已取消。");
		case "empty":
			return t("settings.models.verify.empty", "模型返回了空内容，未确认可用。");
		default:
			return outcome.message || t("settings.models.verify.failed", "模型调用失败。");
	}
}

/**
 * Source label so the card distinguishes direct API vendors from Magpie.
 *
 * A provider id is internal configuration (the `example` key is a placeholder
 * written by the config file, not something the learner named), so it must
 * never be shown verbatim. Known vendors keep their brand name; anything else
 * falls back to the channel the request actually goes through.
 */
function sourceLabel(provider: string, t: Translate): string {
	if (provider === MAGPIE_PROVIDER_ID) return t("settings.models.sourceMagpie", "Magpie 接入");
	return findPreset(provider)?.name ?? t("settings.models.sourceApi", "API 接入");
}

/**
 * Every option names its source, so two models with the same name from the
 * two channels stay distinguishable. The tag is a short "API"/"Magpie" marker
 * rather than the full label to keep the dropdown scannable.
 */
function modelOptionLabel(model: InnoModelInfo, t: Translate): string {
	const tag = model.provider === MAGPIE_PROVIDER_ID
		? t("settings.models.tagMagpie", "Magpie")
		: t("settings.models.tagApi", "API");
	return `${model.name || model.id} · ${tag}`;
}

export function CurrentModelCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const { isSavingModel } = useStoreSnapshot(settingsStore, () => ({
		isSavingModel: settingsStore.isSavingModel,
	}));
	const models = settings.configuredModels ?? [];
	const current = models.find(
		(model) => model.provider === settings.defaultProvider && model.id === settings.defaultModel,
	);
	const isMagpie = settings.defaultProvider === MAGPIE_PROVIDER_ID;
	const [readiness, setReadiness] = useState<Readiness>({ state: "unknown" });

	// A different model is a different call path: the previous verdict says
	// nothing about it, so the card returns to "未检测" instead of showing a
	// stale "已就绪".
	useEffect(() => {
		setReadiness({ state: "unknown" });
	}, [settings.defaultProvider, settings.defaultModel]);

	async function handleVerify() {
		setReadiness({ state: "checking" });
		try {
			const outcome = await verifyCurrentModel();
			const message = outcomeMessage(outcome, t);
			setReadiness(message ? { state: "failed", message } : { state: "ready" });
		} catch (err) {
			setReadiness({ state: "failed", message: err instanceof Error ? err.message : String(err) });
		}
	}

	const meta = current && current.contextWindow > 0 && current.maxTokens > 0
		? `${formatTokens(current.contextWindow)} context · ${formatTokens(current.maxTokens)} max`
		: "";

	return (
		<SettingsCard>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0">
					<h3 className="text-xs font-medium text-[var(--inno-text-muted)]">{t("settings.models.currentModel", "当前模型")}</h3>
					{current ? (
						<>
							<div className="mt-1 flex flex-wrap items-center gap-2">
								<span className="text-lg font-medium break-all text-[var(--inno-text)]">{current.name || current.id}</span>
								<span className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]">
									{sourceLabel(current.provider, t)}
								</span>
							</div>
							{meta ? <p className="mt-1 text-xs text-[var(--inno-text-subtle)]">{meta}</p> : null}
							{isMagpie ? (
								<p className="mt-1 text-xs text-[var(--inno-text-subtle)]">
									{t("settings.models.magpieMetaNote", "上下文与最大输出取自已保存的 Magpie 配置；网关未提供的字段使用保守默认值。")}
								</p>
							) : null}
						</>
					) : (
						<p className="mt-1 text-sm text-[var(--inno-text-muted)]">
							{t("settings.models.noCurrent", "当前模型不在已保存的配置中，请在下方重新选择。")}
						</p>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Select
						value={current ? encodeModelKey(current.provider, current.id) : ""}
						disabled={isSavingModel || models.length === 0}
						onValueChange={(next) => {
							const parsed = decodeModelKey(next);
							if (parsed) void settingsStore.switchModel(parsed.provider, parsed.model);
						}}
					>
						<SelectTrigger
							className="w-[220px] max-w-full text-xs"
							aria-label={t("settings.models.switch", "切换模型")}
							title={models.length === 0 ? t("settings.models.noModels", "还没有可切换的模型") : undefined}
						>
							<SelectValue placeholder={t("settings.models.switch", "切换模型")} />
						</SelectTrigger>
						<SelectContent>
							{models.map((model) => (
								<SelectOption
									key={encodeModelKey(model.provider, model.id)}
									value={encodeModelKey(model.provider, model.id)}
									label={modelOptionLabel(model, t)}
								/>
							))}
						</SelectContent>
					</Select>
					<ReadinessChip readiness={readiness} />
					<IconButton
						size="sm"
						aria-label={t("settings.models.verifyAction", "重新检测当前模型")}
						title={t("settings.models.verifyAction", "重新检测当前模型")}
						disabled={!current || readiness.state === "checking" || isSavingModel}
						onClick={() => void handleVerify()}
					>
						<RefreshCw size={14} className={readiness.state === "checking" ? "animate-spin" : ""} />
					</IconButton>
				</div>
			</div>

			{readiness.state === "failed" ? (
				<div role="alert" className="mt-3 rounded bg-[var(--inno-danger-bg)] px-2 py-1.5 text-xs text-[var(--inno-danger)]">
					{readiness.message}
				</div>
			) : null}
		</SettingsCard>
	);
}

function ReadinessChip({ readiness }: { readiness: Readiness }) {
	const { t } = useTranslation();
	const base = "inline-flex items-center gap-1 text-xs";
	if (readiness.state === "ready") {
		return (
			<span role="status" aria-live="polite" className={`${base} text-[var(--inno-success)]`}>
				<CheckCircle2 size={14} aria-hidden="true" /> {t("settings.models.ready", "模型已就绪")}
			</span>
		);
	}
	if (readiness.state === "failed") {
		return (
			<span role="status" aria-live="polite" className={`${base} text-[var(--inno-danger)]`}>
				<CircleAlert size={14} aria-hidden="true" /> {t("settings.models.notReady", "模型未就绪")}
			</span>
		);
	}
	if (readiness.state === "checking") {
		return (
			<span role="status" aria-live="polite" className={`${base} text-[var(--inno-text-muted)]`}>
				<RefreshCw size={14} className="animate-spin" aria-hidden="true" /> {t("settings.models.checking", "检测中…")}
			</span>
		);
	}
	return (
		<span role="status" aria-live="polite" className={`${base} text-[var(--inno-text-subtle)]`}>
			{t("settings.models.unverified", "未检测")}
		</span>
	);
}
