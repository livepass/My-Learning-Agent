import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, CheckCircle2, Plug, RefreshCw, Trash2 } from "lucide-react";
import { fetchMagpieCatalog, probeMagpieGateway, type MagpieModelInfo } from "../../api/settings.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoProviderModel, InnoSettings } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, Checkbox, IconButton, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
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

/**
 * A row in the model list. Discovery entries come from the gateway; saved
 * entries that the gateway no longer lists are merged in so a re-save cannot
 * silently drop them, and are marked as removed upstream.
 */
type Row = {
	id: string;
	name: string;
	ownedBy?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	vision?: boolean;
	confirmed: { contextWindow: boolean; maxTokens: boolean; reasoning: boolean; input: boolean };
	/** Saved in config.json, so it can be activated without another save. */
	saved: InnoProviderModel | null;
	removedFromCatalog: boolean;
};

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
	const [makeDefault, setMakeDefault] = useState(false);
	const [busy, setBusy] = useState<"health" | "catalog" | null>(null);
	const [switching, setSwitching] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	// After a save the settings object is replaced; keep the editable selection
	// in sync with what the server actually persisted.
	useEffect(() => {
		setSelected(new Set(savedModels.map((model) => model.id)));
		setProtocols(Object.fromEntries(savedModels.map((model) => [model.id, (model.api as MagpieProtocol) || "openai-completions"])));
	}, [savedSignature(savedModels)]);

	// Saved models stay in the list so a re-save can keep them even when the
	// gateway has stopped listing them; discovery entries are merged after.
	const rows: Row[] = [];
	for (const model of catalog ?? []) {
		rows.push({
			id: model.id,
			name: model.displayName || model.id,
			ownedBy: model.ownedBy,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning === true,
			vision: model.input?.includes("image") === true,
			confirmed: model.confirmed,
			saved: savedModels.find((entry) => entry.id === model.id) ?? null,
			removedFromCatalog: false,
		});
	}
	for (const model of savedModels) {
		if (rows.some((row) => row.id === model.id)) continue;
		rows.push({
			id: model.id,
			name: model.name || model.id,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			vision: model.input.includes("image"),
			confirmed: { contextWindow: true, maxTokens: true, reasoning: true, input: true },
			saved: model,
			removedFromCatalog: catalog !== null,
		});
	}
	// A re-save without a fresh fetch must reuse what the server already
	// confirmed; a discovery entry (or the conservative default) would
	// otherwise silently reset a model's saved capabilities to defaults.
	const savedById = new Map(savedModels.map((model) => [model.id, model]));

	const isCurrent = (id: string) => settings.defaultProvider === MAGPIE_PROVIDER_ID && settings.defaultModel === id;

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
		if (rows.some((row) => row.id === id)) {
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
			// A saved model the gateway no longer lists still stays in the list
			// (so it is not silently dropped from a re-save), but the learner is
			// told it is gone upstream instead of discovering it at chat time.
			const removed = savedModels.filter((model) => !result.models.some((entry) => entry.id === model.id));
			if (removed.length > 0) {
				freshWarnings.push(t("settings.magpie.removed", { ids: removed.map((model) => model.id).join(", ") }) ?? "");
			}
			setWarnings(freshWarnings);
			// A first-time setup with nothing saved yet starts with the first
			// discovered model checked, so the panel is immediately savable. This
			// only fills the save set: the current model is untouched, and once
			// anything is saved the saved set is kept as-is.
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
			.map((id) => savedById.get(id) ?? (catalog ?? []).find((model) => model.id === id))
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

	/**
	 * Activate an already-saved model through the existing switch endpoint.
	 * A failed switch leaves the previous selection untouched (the store only
	 * updates its snapshot after the server confirms).
	 */
	async function handleUse(modelId: string) {
		setError("");
		setNotice("");
		setSwitching(modelId);
		try {
			const ok = await settingsStore.switchModel(MAGPIE_PROVIDER_ID, modelId);
			if (!ok) setError(settingsStore.error ?? t("settings.magpie.switchFailed", "切换模型失败。") ?? "");
		} finally {
			setSwitching(null);
		}
	}

	return (
		<div className="grid gap-3">
			{/* --- Connection --- */}
			<SettingsCard>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.magpie.title", "Magpie 网关接入")}</h4>
						<p className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
							{t("settings.magpie.desc", "通过本机运行的 Magpie 网关使用其已启用的模型；学习 Agent 不参与上游账号登录。")}
						</p>
					</div>
					{/* Gateway reachability only. Model readiness is the status card's job. */}
					<span
						role="status"
						aria-live="polite"
						className={`inline-flex items-center gap-1 text-xs ${health ? "text-[var(--inno-success)]" : "text-[var(--inno-text-subtle)]"}`}
					>
						{health ? <CheckCircle2 size={14} aria-hidden="true" /> : null}
						{health
							? `${t("settings.magpie.connectedShort", "已连接 Magpie")}${health.version ? ` v${health.version.replace(/^v/, "")}` : ""}`
							: provider
								? t("settings.magpie.configured", "已配置，未检测")
								: t("settings.magpie.notConfigured", "未配置")}
					</span>
				</div>

				<div className="mt-3 grid gap-2 sm:grid-cols-2">
					<div>
						<label className={labelCls} htmlFor="magpie-gateway-url">{t("settings.magpie.gatewayUrl", "网关地址")}</label>
						<Input
							id="magpie-gateway-url"
							size="sm"
							className="w-full"
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
							className="w-full"
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
				</div>
			</SettingsCard>

			{/* --- Model list --- */}
			<SettingsCard>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.magpie.catalog", "可用模型")}</h4>
						<p className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
							{t("settings.magpie.catalogDesc", "来自 Magpie 的真实模型列表；勾选的模型会写入本机配置，点“使用”立即切换当前模型。")}
						</p>
					</div>
					<Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void handleCatalog()}>
						<RefreshCw size={14} className={busy === "catalog" ? "animate-spin" : ""} />
						{busy === "catalog" ? t("settings.magpie.fetching", "正在拉取…") : t("settings.magpie.refresh", "刷新模型列表")}
					</Button>
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

				<div className="mt-3 grid max-h-[420px] gap-1.5 overflow-y-auto pr-1">
					{catalog === null && savedModels.length === 0 ? (
						<p className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-6 text-center text-xs text-[var(--inno-text-muted)]">
							{t("settings.magpie.notFetched", "还没有模型列表。填写网关地址后点“刷新模型列表”从 Magpie 获取。")}
						</p>
					) : null}
					{catalog !== null && rows.length === 0 ? (
						<p className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-6 text-center text-xs text-[var(--inno-text-muted)]">
							{t("settings.magpie.empty", "网关没有返回聊天模型。可在 Magpie 中启用模型，或手动填写模型 ID。")}
						</p>
					) : null}

					{rows.map((row) => {
						const checked = selected.has(row.id);
						const current = isCurrent(row.id);
						const protocol = protocols[row.id] ?? "openai-completions";
						const protocolLabel = `${t("settings.magpie.protocol", "协议")} ${row.id}`;
						const protocolId = `magpie-protocol-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
						return (
							<div
								key={row.id}
								data-testid="magpie-model-row"
								data-current={current || undefined}
								className={`rounded-md border px-3 py-2.5 ${current ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)] bg-[var(--inno-surface)]"}`}
							>
								<div className="flex items-start gap-2.5">
									<Checkbox
										checked={checked}
										aria-label={t("settings.magpie.include", { id: row.id }) ?? row.id}
										onChange={(event) => event.target.checked ? selectModel(row.id) : unselectModel(row.id)}
									/>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="text-sm text-[var(--inno-text)]">{row.name}</span>
											{row.reasoning ? <Tag>{t("settings.form.reasoning")}</Tag> : null}
											{row.vision ? <Tag>{t("settings.wizard.vision", "视觉")}</Tag> : null}
											{current ? (
												<span className="inline-flex items-center gap-0.5 rounded bg-[var(--inno-surface)] px-1.5 py-0.5 text-xs font-medium text-[var(--inno-accent)]">
													<Check size={10} aria-hidden="true" /> {t("settings.models.currentTag", "当前使用")}
												</span>
											) : null}
											{row.removedFromCatalog ? (
												<span className="rounded bg-[var(--inno-warning-bg)] px-1.5 py-0.5 text-xs text-[var(--inno-warning)]">
													{t("settings.magpie.goneUpstream", "网关已不再提供")}
												</span>
											) : null}
										</div>
										<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--inno-text-subtle)]">
											<span className="break-all">{row.id}</span>
											{row.confirmed.contextWindow && row.contextWindow
												? <span>{formatTokens(row.contextWindow)} context</span>
												: <span>{t("settings.magpie.contextUnknownShort", "上下文未知")}</span>}
											{row.confirmed.maxTokens && row.maxTokens
												? <span>{formatTokens(row.maxTokens)} max</span>
												: <span>{t("settings.magpie.maxUnknownShort", "最大输出未知")}</span>}
										</div>
									</div>
								</div>

								{/* Controls sit on their own lines: a protocol dropdown squeezed
								    beside action buttons wraps its labels and mis-clicks. */}
								{checked ? (
									<div className="mt-2.5 border-t border-[var(--inno-border)] pt-2.5 pl-[26px]">
										<label className={labelCls} htmlFor={protocolId}>
											{t("settings.magpie.protocol", "协议")}
										</label>
										<div className="mt-1 flex flex-wrap items-center gap-3">
											<Select value={protocol} onValueChange={(value) => setProtocols((current) => ({ ...current, [row.id]: value as MagpieProtocol }))}>
												<SelectTrigger id={protocolId} className="w-full min-w-[200px] max-w-[280px] text-xs" aria-label={protocolLabel}>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{PROTOCOLS.map((value) => <SelectOption key={value} value={value} label={value} />)}
												</SelectContent>
											</Select>
											{row.saved && !current ? (
												<Button size="sm" variant="secondary" disabled={isSavingProvider || switching !== null} onClick={() => void handleUse(row.id)}>
													{switching === row.id ? t("settings.magpie.switching", "切换中…") : t("settings.use", "使用")}
												</Button>
											) : null}
											{row.saved && !current ? (
												<IconButton
													size="sm"
													variant="ghost"
													aria-label={`${t("common.delete")} ${row.id}`}
													title={t("common.delete")}
													disabled={isSavingProvider}
													onClick={() => {
														if (window.confirm(t("settings.confirmDelete", { id: `${MAGPIE_PROVIDER_ID}/${row.id}` }) ?? "")) {
															void handleDelete(row.id);
														}
													}}
												>
													<Trash2 size={14} />
												</IconButton>
											) : null}
										</div>
									</div>
								) : row.saved && !current ? (
									<div className="mt-2 flex flex-wrap items-center gap-3 pl-[26px]">
										<Button size="sm" variant="secondary" disabled={isSavingProvider || switching !== null} onClick={() => void handleUse(row.id)}>
											{switching === row.id ? t("settings.magpie.switching", "切换中…") : t("settings.use", "使用")}
										</Button>
										<IconButton
											size="sm"
											variant="ghost"
											aria-label={`${t("common.delete")} ${row.id}`}
											title={t("common.delete")}
											disabled={isSavingProvider}
											onClick={() => {
												if (window.confirm(t("settings.confirmDelete", { id: `${MAGPIE_PROVIDER_ID}/${row.id}` }) ?? "")) {
													void handleDelete(row.id);
												}
											}}
										>
											<Trash2 size={14} />
										</IconButton>
									</div>
								) : null}
							</div>
						);
					})}
				</div>

				<div className="mt-3 grid gap-1.5">
					<label className={labelCls} htmlFor="magpie-manual-id">
						{t("settings.magpie.manual", "手动填写模型 ID（尚未验证）")}
					</label>
					<div className="flex gap-2">
						<Input
							id="magpie-manual-id"
							size="sm"
							className="w-full"
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
			</SettingsCard>
		</div>
	);
}

function Tag({ children }: { children: React.ReactNode }) {
	return <span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-xs text-[var(--inno-text-muted)]">{children}</span>;
}
