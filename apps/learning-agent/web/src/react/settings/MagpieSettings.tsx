import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Plug, RefreshCw, Trash2 } from "lucide-react";
import { fetchMagpieCatalog, probeMagpieGateway, type MagpieModelInfo } from "../../api/settings.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoProviderModel, InnoSettings } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, Checkbox, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { SettingsCard } from "./primitives.js";
import { formatTokens } from "./shared.js";
import {
	MAGPIE_DEFAULT_GATEWAY_URL,
	MAGPIE_PROVIDER_ID,
	magpieModelBaseUrl,
	type MagpieProtocol,
} from "../../../../src/shared/magpie.js";

const PROTOCOLS: MagpieProtocol[] = ["openai-completions", "openai-responses", "anthropic-messages"];

const labelCls = "mb-0.5 block text-xs text-[var(--inno-text-muted)]";

function gatewayRoot(baseUrl: string | undefined): string {
	if (!baseUrl) return MAGPIE_DEFAULT_GATEWAY_URL;
	return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "") || MAGPIE_DEFAULT_GATEWAY_URL;
}

/**
 * Conservative defaults; the UI marks every missing field as unconfirmed.
 * The base URL is per model because Anthropic Messages is served at the
 * gateway root while the OpenAI protocols are served under `/v1`.
 */
function toProviderModel(model: MagpieModelInfo, api: MagpieProtocol, root: string): InnoProviderModel {
	return {
		id: model.id,
		name: model.displayName || model.id,
		reasoning: model.reasoning === true,
		api,
		baseUrl: magpieModelBaseUrl(root, api),
		input: model.input ?? ["text"],
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 8_192,
	};
}

function savedSignature(models: InnoProviderModel[] | undefined): string {
	return (models ?? []).map((model) => `${model.id}@${model.api ?? ""}`).join("|");
}

export function MagpieSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const { isSavingProvider } = useStoreSnapshot(settingsStore, () => ({
		isSavingProvider: settingsStore.isSavingProvider,
	}));
	const provider = settings.providers[MAGPIE_PROVIDER_ID];
	const savedModels = provider?.models ?? [];

	const [gatewayUrl, setGatewayUrl] = useState(() => gatewayRoot(provider?.baseUrl));
	const [gatewayKey, setGatewayKey] = useState("");
	const [health, setHealth] = useState<{ version?: string } | null>(null);
	const [catalog, setCatalog] = useState<MagpieModelInfo[] | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [selected, setSelected] = useState<Set<string>>(() => new Set(savedModels.map((model) => model.id)));
	const [protocols, setProtocols] = useState<Record<string, MagpieProtocol>>(() =>
		Object.fromEntries(savedModels.map((model) => [model.id, (model.api as MagpieProtocol) || "openai-completions"])),
	);
	const [manualId, setManualId] = useState("");
	const [makeDefault, setMakeDefault] = useState(!provider);
	const [busy, setBusy] = useState<"health" | "catalog" | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	// After a save the settings object is replaced; keep the editable selection
	// in sync with what the server actually persisted.
	useEffect(() => {
		setSelected(new Set(savedModels.map((model) => model.id)));
		setProtocols(Object.fromEntries(savedModels.map((model) => [model.id, (model.api as MagpieProtocol) || "openai-completions"])));
	}, [savedSignature(savedModels)]);

	// Saved models stay in the picker so a re-save can keep them even when the
	// gateway has stopped listing them; discovery entries are merged after.
	const modelsForPicker = [
		...(catalog ?? []),
		...savedModels.filter((model) => !(catalog ?? []).some((entry) => entry.id === model.id)),
	];
	// A re-save without a fresh fetch must reuse what the server already
	// confirmed; a discovery entry (or the conservative default) would
	// otherwise silently reset a model's saved capabilities to defaults.
	const savedById = new Map(savedModels.map((model) => [model.id, model]));

	function selectModel(id: string) {
		setManualId("");
		setNotice("");
		setSelected((current) => new Set(current).add(id));
		setProtocols((current) => current[id] ? current : { ...current, [id]: "openai-completions" });
	}

	function unselectModel(id: string) {
		setSelected((current) => {
			const next = new Set(current);
			next.delete(id);
			return next;
		});
	}

	function addManualModel() {
		const id = manualId.trim();
		if (!id) return;
		if (modelsForPicker.some((model) => model.id === id)) {
			selectModel(id);
			return;
		}
		const manual: MagpieModelInfo = {
			id,
			displayName: id,
			confirmed: { contextWindow: false, maxTokens: false, reasoning: false, input: false },
		};
		// Only discovery entries live in `catalog`; saved models are merged in.
		setCatalog([...(catalog ?? []), manual]);
		setSelected((current) => new Set(current).add(id));
		setProtocols((current) => ({ ...current, [id]: "openai-completions" }));
		setManualId("");
		setNotice(t("settings.magpie.manualUnverified", "该模型 ID 尚未经过网关验证，保存后将按默认能力使用。"));
	}

	async function handleHealth() {
		setBusy("health");
		setError("");
		setNotice("");
		try {
			const result = await probeMagpieGateway({ gatewayUrl, gatewayKey });
			setHealth(result.gateway);
			setNotice(t("settings.magpie.connected", { version: result.gateway.version ?? "" }) ?? "");
		} catch (err) {
			setHealth(null);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	async function handleCatalog() {
		setBusy("catalog");
		setError("");
		setNotice("");
		try {
			const result = await fetchMagpieCatalog({ gatewayUrl, gatewayKey });
			setHealth(result.gateway);
			setCatalog(result.models);
			const freshWarnings = [...(result.warnings ?? [])];
			// A saved model the gateway no longer lists still shows in the picker
			// (so it is not silently dropped from a re-save), but the learner is
			// told it is gone upstream instead of discovering it at chat time.
			const removed = savedModels.filter((model) => !result.models.some((entry) => entry.id === model.id));
			if (removed.length > 0) {
				freshWarnings.push(t("settings.magpie.removed", { ids: removed.map((model) => model.id).join(", ") }) ?? "");
			}
			setWarnings(freshWarnings);
			setSelected((current) => {
				if (current.size > 0) return current;
				return result.models.length > 0 ? new Set([result.models[0].id]) : current;
			});
			if (result.models.length > 0) {
				setNotice(t("settings.magpie.modelsFound", { count: result.models.length }) ?? "");
			}
		} catch (err) {
			setCatalog(null);
			setWarnings([]);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	async function handleSave() {
		setError("");
		setNotice("");
		const root = gatewayRoot(gatewayUrl);
		const chosen = [...selected]
			.map((id) => savedById.get(id) ?? modelsForPicker.find((model) => model.id === id))
			.filter((model): model is MagpieModelInfo | InnoProviderModel => Boolean(model));
		if (chosen.length === 0) {
			setError(t("settings.magpie.selectOne", "请至少选择一个模型后再保存。") ?? "");
			return;
		}
		await settingsStore.saveProvider({
			providerId: MAGPIE_PROVIDER_ID,
			baseUrl: `${root}/v1`,
			apiKey: gatewayKey,
			api: "openai-completions",
			models: chosen.map((model) => {
				const api = protocols[model.id] ?? "openai-completions";
				// An already-saved model keeps its server-confirmed capabilities.
				if ("confirmed" in model) return toProviderModel(model, api, root);
				return { ...model, api, baseUrl: magpieModelBaseUrl(root, api) };
			}),
			makeDefault,
			// Empty key keeps the stored gateway key; the server stores the
			// documented local client id when there is no stored key yet.
			preserveApiKey: true,
		});
		if (settingsStore.error) {
			setError(settingsStore.error);
			return;
		}
		setNotice(t("settings.magpie.saved", "Magpie 配置已保存。") ?? "");
		setGatewayKey("");
	}

	async function handleDelete(modelId: string) {
		setError("");
		setNotice("");
		await settingsStore.deleteModel(MAGPIE_PROVIDER_ID, modelId);
		if (settingsStore.error) setError(settingsStore.error);
	}

	async function handleUse(modelId: string) {
		setError("");
		setNotice("");
		const ok = await settingsStore.switchModel(MAGPIE_PROVIDER_ID, modelId);
		if (!ok) setError(settingsStore.error ?? t("settings.magpie.switchFailed", "切换模型失败。") ?? "");
	}

	const isCurrent = (id: string) => settings.defaultProvider === MAGPIE_PROVIDER_ID && settings.defaultModel === id;

	return (
		<SettingsCard>
			<div className="mb-3 flex items-start justify-between gap-3">
				<div>
					<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.magpie.title", "Magpie 网关接入")}</h4>
					<p className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
						{t("settings.magpie.desc", "通过本机运行的 Magpie 网关使用其已启用的模型；学习 Agent 不参与上游账号登录。")}
					</p>
				</div>
				<span className={`rounded px-2 py-1 text-xs ${provider ? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]"}`}>
					{provider
						? t("settings.magpie.configured", "已配置")
						: t("settings.magpie.notConfigured", "未配置")}
				</span>
			</div>

			<div className="grid gap-2 sm:grid-cols-2">
				<div>
					<label className={labelCls} htmlFor="magpie-gateway-url">{t("settings.magpie.gatewayUrl", "网关地址")}</label>
					<Input
						id="magpie-gateway-url"
						size="sm"
						value={gatewayUrl}
						onChange={(event) => setGatewayUrl(event.target.value)}
						placeholder={MAGPIE_DEFAULT_GATEWAY_URL}
						disabled={busy !== null}
					/>
				</div>
				<div>
					<label className={labelCls} htmlFor="magpie-gateway-key">{t("settings.magpie.gatewayKey", "网关密钥")}</label>
					<Input
						id="magpie-gateway-key"
						size="sm"
						type="password"
						value={gatewayKey}
						onChange={(event) => setGatewayKey(event.target.value)}
						placeholder={provider?.apiKey
							? t("settings.magpie.keyPreserved", "留空保留已保存的密钥") ?? ""
							: t("settings.magpie.keyLocalHint", "本机可留空，默认使用 magpie-my-learning-agent") ?? ""}
						disabled={busy !== null}
					/>
				</div>
			</div>
			<p className="mt-1 text-xs text-[var(--inno-text-subtle)]">
				{t("settings.magpie.keyHint", "跨机器或正式授权时填写 Magpie 中创建的 Gateway Key；本机调用会自动使用客户端标识。")}
			</p>

			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void handleHealth()}>
					<Plug size={14} /> {busy === "health" ? t("settings.magpie.checking", "正在检测…") : t("settings.magpie.check", "检测连接")}
				</Button>
				<Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void handleCatalog()}>
					<RefreshCw size={14} /> {busy === "catalog" ? t("settings.magpie.fetching", "正在拉取…") : t("settings.magpie.fetch", "拉取模型列表")}
				</Button>
				{health ? <span className="text-xs text-[var(--inno-success)]">{t("settings.magpie.connectedShort", "已连接 Magpie")} {health.version ? `v${health.version.replace(/^v/, "")}` : ""}</span> : null}
			</div>

			{error ? (
				<div role="alert" className="mt-2 rounded bg-[var(--inno-danger-bg)] px-2 py-1.5 text-xs text-[var(--inno-danger)]">
					{error}
				</div>
			) : null}
			{notice ? <div className="mt-2 text-xs text-[var(--inno-text-muted)]">{notice}</div> : null}
			{warnings.map((warning) => (
				<div key={warning} className="mt-1 flex items-start gap-1.5 text-xs text-[var(--inno-warning)]">
					<AlertTriangle size={12} className="mt-0.5 shrink-0" /> {warning}
				</div>
			))}

			{catalog !== null ? (
				<div className="mt-3">
					<div className="mb-1.5 text-xs font-medium text-[var(--inno-text)]">{t("settings.magpie.catalog", "网关模型")}</div>
					{catalog.length === 0 ? (
						<p className="text-xs text-[var(--inno-text-muted)]">{t("settings.magpie.empty", "网关没有返回聊天模型。可在 Magpie 中启用模型，或手动填写模型 ID。")}</p>
					) : (
						<div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
							{catalog.map((model) => {
								const checked = selected.has(model.id);
								const protocol = protocols[model.id] ?? "openai-completions";
								return (
									<div key={model.id} className={`rounded border p-2.5 ${checked ? "border-[var(--inno-accent-soft)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)] bg-[var(--inno-surface)]"}`}>
										<div className="flex items-start gap-2">
											<Checkbox checked={checked} onChange={(event) => event.target.checked ? selectModel(model.id) : unselectModel(model.id)} />
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-[var(--inno-text)]">
													{model.displayName || model.id}
													{model.reasoning === true && model.confirmed.reasoning ? <span className="rounded bg-[var(--inno-surface-muted)] px-1 py-px text-[11px] font-normal">{t("settings.form.reasoning")}</span> : null}
													{model.input?.includes("image") ? <span className="rounded bg-[var(--inno-surface-muted)] px-1 py-px text-[11px] font-normal">{t("settings.wizard.vision", "视觉")}</span> : null}
												</div>
												<div className="break-all text-[11px] text-[var(--inno-text-subtle)]">{model.id}{model.ownedBy ? ` · ${model.ownedBy}` : ""}</div>
												<div className="mt-0.5 text-[11px] text-[var(--inno-text-muted)]">
													{model.confirmed.contextWindow && model.contextWindow
														? `${formatTokens(model.contextWindow)} context`
														: t("settings.magpie.contextUnknown", "上下文未提供（保存用默认值）")}
													{" · "}
													{model.confirmed.maxTokens && model.maxTokens
														? `${formatTokens(model.maxTokens)} max`
														: t("settings.magpie.maxUnknown", "最大输出未提供（保存用默认值）")}
												</div>
											</div>
											{checked ? (
												<Select value={protocol} onValueChange={(value) => setProtocols((current) => ({ ...current, [model.id]: value as MagpieProtocol }))}>
													<SelectTrigger className="h-7 w-[132px] text-[11px]" aria-label={t("settings.magpie.protocol", "协议")}>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{PROTOCOLS.map((value) => <SelectOption key={value} value={value} label={value} />)}
													</SelectContent>
												</Select>
											) : null}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			) : null}

			<div className="mt-3 grid gap-1.5">
				<label className={labelCls} htmlFor="magpie-manual-id">
					{t("settings.magpie.manual", "手动填写模型 ID（尚未验证）")}
				</label>
				<div className="flex gap-2">
					<Input
						id="magpie-manual-id"
						size="sm"
						value={manualId}
						onChange={(event) => setManualId(event.target.value)}
						placeholder="provider/model 或路由组名称"
					/>
					<Button size="sm" variant="secondary" disabled={!manualId.trim()} onClick={addManualModel}>
						{t("settings.magpie.addManual", "加入选择")}
					</Button>
				</div>
			</div>

			<label className="mt-3 flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
				<Checkbox checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
				{t("settings.magpie.makeDefault", "保存后设为默认模型")}
			</label>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button size="sm" variant="primary" disabled={isSavingProvider || busy !== null} onClick={() => void handleSave()}>
					{isSavingProvider ? t("settings.savingProvider") : t("settings.magpie.save", "保存 Magpie 配置")}
				</Button>
				<span className="text-xs text-[var(--inno-text-subtle)]">{t("settings.magpie.saveHint", "只写入 magpie 这一项，不会改动直接 API 的厂商配置。")}</span>
			</div>

			{savedModels.length > 0 ? (
				<div className="mt-4 border-t border-[var(--inno-border)] pt-3">
					<div className="mb-2 text-xs font-medium text-[var(--inno-text)]">{t("settings.magpie.savedModels", "已保存的 Magpie 模型")}</div>
					<div className="grid gap-2">
						{savedModels.map((model) => (
							<div
								key={model.id}
								data-testid="magpie-saved-model"
								className={`flex items-center justify-between gap-2 rounded border p-2.5 ${isCurrent(model.id) ? "border-[var(--inno-accent-soft)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)] bg-[var(--inno-surface)]"}`}
							>
								<div className="min-w-0">
									<div className="flex items-center gap-1.5 text-xs font-medium text-[var(--inno-text)]">
										{model.name || model.id}
										{isCurrent(model.id) ? <span className="rounded bg-[var(--inno-surface)] px-1 py-px text-[11px] text-[var(--inno-accent)]">{t("settings.current")}</span> : null}
									</div>
									<div className="break-all text-[11px] text-[var(--inno-text-subtle)]">{model.id} · {model.api ?? "openai-completions"}</div>
								</div>
								<div className="flex items-center gap-1.5">
									{isCurrent(model.id) ? <Check size={14} className="text-[var(--inno-accent)]" /> : (
										<>
											<button
												className="rounded border border-[var(--inno-border)] px-2 py-1 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
												disabled={isSavingProvider}
												onClick={() => void handleUse(model.id)}
											>
												{t("settings.use")}
											</button>
											<button
												className="rounded p-1 text-[var(--inno-text-subtle)] hover:text-[var(--inno-danger)] disabled:opacity-50"
												title={t("common.delete")}
												aria-label={`${t("common.delete")} ${model.id}`}
												disabled={isSavingProvider}
												onClick={() => {
													if (window.confirm(t("settings.confirmDelete", { id: `${MAGPIE_PROVIDER_ID}/${model.id}` }) ?? "")) {
														void handleDelete(model.id);
													}
												}}
											>
												<Trash2 size={14} />
											</button>
										</>
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			) : null}
		</SettingsCard>
	);
}
