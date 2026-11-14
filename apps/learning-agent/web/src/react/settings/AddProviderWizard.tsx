import { ThinkingLevelField } from "./ThinkingLevelField.js";
import type { InnoThinkingLevel } from "../../types/settings.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, ExternalLink, RefreshCw, Check } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { probeProviderModels } from "../../api/settings.js";
import type { InnoProviderModel as ProviderModel, InnoProviderSettings } from "../../types/settings.js";
import { Button, Checkbox, IconButton, Input, SearchableSelect, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { formatTokens } from "./shared.js";
import { BRAND_PRESETS, CUSTOM_PRESET, findPreset, type ProviderPreset } from "./provider-presets.js";
import { inferModelMetadata } from "./model-metadata.js";

const apiOptions = ["openai-completions", "openai-responses", "anthropic-messages"];

/**
 * Icon tile for a preset, with its colored glyph as the fallback.
 *
 * Takes the preset itself rather than an id: the custom entry is not a brand
 * preset (`findPreset` deliberately skips it), so the form header must still
 * render its own "+" glyph instead of falling back to the first letter of the
 * internal "custom" id.
 */
function PresetIcon({ preset, size = 28 }: { preset: ProviderPreset; size?: number }) {
	const { brandColor, glyph, iconSrc } = preset;
	// Track the failed src instead of a boolean so a different provider's icon
	// (or the same one after a rebuild) gets a fresh attempt. A missing brand
	// asset must degrade to the glyph tile — the browser's broken-image icon
	// inside a transparent tile is never an acceptable state.
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const showImage = Boolean(iconSrc) && failedSrc !== iconSrc;
	return (
		<span
			className="flex shrink-0 items-center justify-center overflow-hidden rounded-md font-semibold text-white"
			style={{ width: size, height: size, backgroundColor: showImage ? "transparent" : brandColor, fontSize: Math.round(size * 0.38) }}
		>
			{showImage ? (
				<img src={iconSrc} alt="" aria-hidden="true" className="h-full w-full object-contain" onError={() => setFailedSrc(iconSrc ?? null)} />
			) : glyph}
		</span>
	);
}

/** Brand icon for a provider id, with a colored glyph tile as the fallback. */
export function ProviderIcon({ providerId, size = 28 }: { providerId: string; size?: number }) {
	const preset = findPreset(providerId);
	return (
		<PresetIcon
			size={size}
			preset={preset ?? {
				id: providerId,
				name: providerId,
				descriptionKey: "",
				brandColor: "#8A8F98",
				glyph: providerId.trim().charAt(0).toUpperCase() || "?",
				baseUrl: "",
				api: "openai-completions",
				consoleUrl: "",
				docsUrl: "",
			}}
		/>
	);
}

interface WizardFormState {
	thinkingLevel?: InnoThinkingLevel;
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	modelId: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	supportsImages: boolean;
	authHeader: boolean;
	bypassProxy: boolean;
	makeDefault: boolean;
}

function formFromPreset(preset: ProviderPreset, existingProviders: Record<string, InnoProviderSettings>): WizardFormState {
	return {
		providerId: preset.id === "custom" ? "" : preset.id,
		baseUrl: preset.baseUrl,
		apiKey: "",
		api: preset.api,
		modelId: "",
		contextWindow: "128000",
		maxTokens: "8192",
		reasoning: false,
		supportsImages: false,
		authHeader: false,
		bypassProxy: false,
		// First configured model becomes the default automatically.
		makeDefault: Object.keys(existingProviders).length === 0,
	};
}

const labelCls = "mb-0.5 block text-xs text-[var(--inno-text-muted)]";

/**
 * Guided add-model wizard (cc-switch style): pick a preset, paste an API key,
 * pull the model list from the provider, pick a model — context and
 * capability fields are auto-filled and tucked into an advanced section.
 *
 * The vendor grid is always visible (E3.1 UI v2): the settings page no longer
 * lists configured models, so the vendor entries are the page's main content
 * rather than a collapsed disclosure. Choosing one swaps the grid for the
 * guided form; "更换厂商" returns to the grid. E3.1 UI v2.1 keeps the grid to
 * the six brand presets and gives the custom form its own header button.
 */
export function AddProviderWizard({ providers }: { providers: Record<string, InnoProviderSettings> }) {
	const { t } = useTranslation();
	const [preset, setPreset] = useState<ProviderPreset | null>(null);
	const [form, setForm] = useState<WizardFormState | null>(null);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [probing, setProbing] = useState(false);
	const [probeError, setProbeError] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const existingProviders = providers;

	function reset() {
		setPreset(null);
		setForm(null);
		setShowAdvanced(false);
		setFetchedModels(null);
		setModelPickerOpen(false);
		setProbeError(null);
		setFormError(null);
	}

	function selectPreset(p: ProviderPreset) {
		setPreset(p);
		setForm(formFromPreset(p, existingProviders));
		setFetchedModels(null);
		setModelPickerOpen(false);
		setProbeError(null);
		setFormError(null);
	}

	function applyModel(modelId: string) {
		if (!form) return;
		const meta = inferModelMetadata(modelId);
		setForm({
			...form,
			modelId,
			thinkingLevel: undefined,
			contextWindow: String(meta.contextWindow),
			maxTokens: String(meta.maxTokens),
			reasoning: meta.reasoning,
			supportsImages: meta.supportsImages,
		});
	}

	function selectModel(modelId: string) {
		applyModel(modelId);
		setModelPickerOpen(false);
	}

	/** Arrow keys open the shared model selector from the editable model field. */
	function handleModelKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (!fetchedModels?.length) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setModelPickerOpen(true);
		}
	}

	async function handleProbe() {
		if (!form) return;
		setProbing(true);
		setProbeError(null);
		try {
			const existing = existingProviders[form.providerId];
			const result = await probeProviderModels({
				baseUrl: form.baseUrl,
				apiKey: form.apiKey,
				providerId: existing?.apiKey ? form.providerId : undefined,
				api: form.api,
			});
			const models = [...new Set(result.models.map((id) => id.trim()).filter(Boolean))];
			setFetchedModels(models);
			setModelPickerOpen(false);
			if (models.length > 0 && !form.modelId) applyModel(models[0]);
		} catch (err) {
			setFetchedModels(null);
			setProbeError(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(false);
		}
	}

	async function handleSave() {
		if (!form) return;
		const contextWindow = Number(form.contextWindow);
		const maxTokens = Number(form.maxTokens);
		if (!form.providerId.trim()) return setFormError(t("settings.errors.providerRequired"));
		if (!form.baseUrl.trim()) return setFormError(t("settings.errors.baseUrlRequired"));
		if (!form.modelId.trim()) return setFormError(t("settings.errors.modelRequired"));
		if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
			return setFormError(t("settings.errors.tokensInvalid"));
		}
		setSaving(true);
		setFormError(null);
		try {
			const providerId = form.providerId.trim();
			const existing = existingProviders[providerId];
			const model: ProviderModel = {
				id: form.modelId.trim(),
				name: form.modelId.trim(),
				reasoning: form.reasoning,
				thinkingLevel: form.thinkingLevel,
				input: form.supportsImages ? ["text", "image"] : ["text"],
				contextWindow: Math.trunc(contextWindow),
				maxTokens: Math.trunc(maxTokens),
			};
			// Adding to an existing provider merges with its models instead of
			// replacing them; the new model goes first so makeDefault targets it
			// (the backend takes models[0] as the default). Leaving the key
			// blank keeps the stored one.
			const models = [model, ...(existing?.models ?? []).filter((m) => m.id !== model.id)];
			await settingsStore.saveProvider({
				providerId,
				baseUrl: form.baseUrl.trim(),
				apiKey: form.apiKey,
				api: form.api,
				authHeader: form.authHeader,
				bypassProxy: form.bypassProxy,
				models,
				makeDefault: form.makeDefault,
				preserveApiKey: true,
			});
			reset();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div>
			{/* Step 1: vendor grid — the page's primary content, always visible. */}
			{!form && (
				<div className="grid gap-2">
					<div className="flex flex-wrap items-end justify-between gap-2">
						<div>
							<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.models.vendorTitle", "选择模型厂商")}</h3>
							<p className="mt-0.5 text-xs text-[var(--inno-text-muted)]">
								{t("settings.models.vendorDesc", "已保存的厂商配置与密钥继续可用；选择厂商后进入配置表单。")}
							</p>
						</div>
						{/* The custom form has its own entry point instead of a seventh
						    card, so the grid holds exactly the six brand presets. */}
						<Button variant="secondary" size="sm" onClick={() => selectPreset(CUSTOM_PRESET)}>
							<Plus size={14} aria-hidden="true" />
							{t("settings.models.addProvider", "新增模型厂商")}
						</Button>
					</div>
					<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{BRAND_PRESETS.map((p) => (
							<button
								key={p.id}
								className="flex items-center gap-3 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-3.5 text-left transition-colors hover:border-[var(--inno-accent)] hover:bg-[var(--inno-surface-muted)]"
								onClick={() => selectPreset(p)}
							>
								<ProviderIcon providerId={p.id} size={32} />
								<span className="min-w-0">
									<span className="block truncate text-sm font-medium text-[var(--inno-text)]">{p.name}</span>
									<span className="block truncate text-xs text-[var(--inno-text-subtle)]">
										{t(p.descriptionKey)}
									</span>
								</span>
							</button>
						))}
					</div>
				</div>
			)}

					{/* Step 2: guided form */}
					{form && preset && (
						<div>
							<div className="mb-3 flex items-center justify-between">
								<div className="flex items-center gap-2.5">
									<PresetIcon preset={preset} size={26} />
									<span className="text-sm font-medium text-[var(--inno-text)]">{preset.name}</span>
									{preset.docsUrl && (
										<a className="flex items-center gap-0.5 text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-accent)]" href={preset.docsUrl} target="_blank" rel="noreferrer">
											{t("settings.wizard.docs", "文档")} <ExternalLink size={10} />
										</a>
									)}
								</div>
								<button className="text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]" onClick={reset}>
									{t("settings.wizard.changePreset", "更换提供方")}
								</button>
							</div>

							<div className="grid gap-2">
								{/* Custom providers need an identity and endpoint before they can be saved. */}
								{preset.id === "custom" && (
									<>
										<div>
											<label className={labelCls}>{t("settings.form.providerId")}</label>
											<Input
												size="sm"
												className="w-full"
												value={form.providerId}
												onChange={(e) => setForm({ ...form, providerId: e.target.value })}
												required
											/>
										</div>
										<div>
											<label className={labelCls}>{t("settings.form.baseUrl")}</label>
											<Input
												size="sm"
												className="w-full"
												type="url"
												placeholder="https://api.example.com/v1"
												value={form.baseUrl}
												onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
												required
											/>
										</div>
									</>
								)}

								{/* API key + console link */}
								<div>
									<div className="mb-0.5 flex items-center justify-between">
										<label className="text-xs text-[var(--inno-text-muted)]">{t("settings.form.apiKey")}</label>
										{preset.consoleUrl && (
											<a className="flex items-center gap-0.5 text-xs text-[var(--inno-accent)] hover:underline" href={preset.consoleUrl} target="_blank" rel="noreferrer">
												{t("settings.wizard.getApiKey", "获取 API Key")} <ExternalLink size={10} />
											</a>
										)}
									</div>
									<Input
										size="sm"
										className="w-full"
										type="password"
										placeholder={existingProviders[form.providerId] ? t("settings.form.apiKeyPreserved") ?? "" : "sk-..."}
										value={form.apiKey}
										onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
									/>
								</div>

								{/* Model fetch + pick */}
								<div>
									<div className="mb-0.5 flex items-center justify-between">
										<label className="text-xs text-[var(--inno-text-muted)]">{t("settings.form.modelId")}</label>
										<button
											className="flex items-center gap-1 text-xs text-[var(--inno-accent)] hover:underline disabled:opacity-50"
											disabled={probing || !form.baseUrl.trim()}
											onClick={() => void handleProbe()}
										>
											<RefreshCw size={10} className={probing ? "animate-spin" : ""} />
											{probing
												? t("settings.wizard.fetching", "拉取中…")
												: fetchedModels
													? t("settings.wizard.fetchedCount", { count: fetchedModels.length })
													: t("settings.wizard.fetchModels", "拉取模型列表")}
										</button>
									</div>
									<div className="relative">
										<Input
											size="sm"
											className={`w-full${fetchedModels?.length ? " pr-8" : ""}`}
											placeholder={t("settings.wizard.modelPlaceholder", "输入或从拉取的列表中选择") ?? ""}
											value={form.modelId}
											onChange={(e) => applyModel(e.target.value)}
											onKeyDown={handleModelKeyDown}
										/>
										{fetchedModels?.length ? (
											<SearchableSelect
												trigger={(
													<IconButton
														variant="ghost"
														size="xs"
														className="absolute right-0 top-0"
														aria-label={modelPickerOpen ? t("settings.wizard.collapseModelList", "收起模型列表") : t("settings.wizard.expandModelList", "展开模型列表")}
														title={modelPickerOpen ? t("settings.wizard.collapseModelList", "收起模型列表") : t("settings.wizard.expandModelList", "展开模型列表")}
													>
														<ChevronDown size={14} className={`transition-transform${modelPickerOpen ? " rotate-180" : ""}`} />
													</IconButton>
												)}
												sections={[{
													id: "fetched-models",
													options: fetchedModels.map((id) => ({ value: id, label: id })),
												}]}
												value={form.modelId}
												open={modelPickerOpen}
												onOpenChange={setModelPickerOpen}
												onValueChange={selectModel}
												searchPlaceholder={t("settings.wizard.searchFetchedModels", "搜索已获取的模型")}
													clearSearchLabel={t("common.clearSearch", "清除搜索")}
													emptyMessage={t("settings.wizard.noMatchingModels", "没有匹配的模型")}
												ariaLabel={t("settings.wizard.selectFetchedModel", "选择已获取的模型")}
												align="end"
												maxListHeight={224}
											/>
										) : null}
									</div>
									{preset.modelHintKey ? (
										<p className="mt-1 text-xs text-[var(--inno-text-subtle)]">{t(preset.modelHintKey)}</p>
									) : null}
									{probeError && <p className="mt-1 text-xs text-[var(--inno-danger)]">{probeError}</p>}
									{form.modelId && (
										<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
											<span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-xs text-[var(--inno-text-muted)]">{formatTokens(Number(form.contextWindow) || 0)} context</span>
											<span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-xs text-[var(--inno-text-muted)]">{formatTokens(Number(form.maxTokens) || 0)} max</span>
											{form.reasoning && <span className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]">{t("settings.form.reasoning")}</span>}
											{form.supportsImages && <span className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]">{t("settings.wizard.vision", "视觉")}</span>}
											<span className="flex items-center gap-0.5 text-xs text-[var(--inno-success)]"><Check size={10} />{t("settings.wizard.autoFilled", "参数已自动填充")}</span>
										</div>
									)}
								</div>

								{/* Advanced */}
								<button
									className="mt-1 flex items-center gap-1 text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]"
									onClick={() => setShowAdvanced((v) => !v)}
								>
									{showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
									{t("settings.wizard.advanced", "高级选项")}
								</button>
								{showAdvanced && (
									<div className="grid grid-cols-2 gap-2 rounded-md bg-[var(--inno-surface-muted)] p-2.5">
										{preset.id !== "custom" && (
											<div>
												<label className={labelCls}>{t("settings.form.providerId")}</label>
												<Input size="sm" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} />
											</div>
										)}
										<div>
											<label className={labelCls}>{t("settings.form.apiType", "API Type")}</label>
										<Select value={form.api} onValueChange={(api) => setForm({ ...form, api })}>
											<SelectTrigger className="w-full text-xs" aria-label={t("settings.form.apiType", "API Type")}><SelectValue /></SelectTrigger>
											<SelectContent>
												{apiOptions.map((api) => <SelectOption key={api} value={api} label={api} />)}
											</SelectContent>
										</Select>
										</div>
										{preset.id !== "custom" && (
											<div className="col-span-2">
												<label className={labelCls}>{t("settings.form.baseUrl")}</label>
												<Input size="sm" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
											</div>
										)}
										<div>
											<label className={labelCls}>{t("settings.form.contextWindow")}</label>
											<Input size="sm" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} />
										</div>
										<div>
											<label className={labelCls}>{t("settings.form.maxTokens")}</label>
											<Input size="sm" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
										</div>
										<div className="col-span-2 flex flex-wrap items-center gap-3 text-xs text-[var(--inno-text-muted)]">
											<label className="flex items-center gap-1.5"><Checkbox checked={form.reasoning} onChange={(e) => setForm({ ...form, reasoning: e.target.checked })} /> {t("settings.form.reasoning")}</label>
											<label className="flex items-center gap-1.5"><Checkbox checked={form.supportsImages} onChange={(e) => setForm({ ...form, supportsImages: e.target.checked })} /> {t("settings.form.supportsImages")}</label>
											<label className="flex items-center gap-1.5"><Checkbox checked={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.checked })} /> {t("settings.form.authHeader")}</label>
											<label className="flex items-center gap-1.5"><Checkbox checked={form.bypassProxy} onChange={(e) => setForm({ ...form, bypassProxy: e.target.checked })} /> {t("settings.form.bypassProxy")}</label>
										</div>
										<ThinkingLevelField enabled={form.reasoning} value={form.thinkingLevel} onChange={thinkingLevel => setForm({ ...form, thinkingLevel })} />
									</div>
								)}

								<label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
									<Checkbox checked={form.makeDefault} onChange={(e) => setForm({ ...form, makeDefault: e.target.checked })} />
									{t("settings.form.makeDefault")}
								</label>
							</div>

							{formError ? <div className="mt-2 rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{formError}</div> : null}
							<div className="mt-3 flex gap-2">
								<Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
									{saving ? t("settings.savingProvider") : t("settings.saveProvider")}
								</Button>
								<Button variant="secondary" size="sm" onClick={reset}>
									{t("common.cancel", "Cancel")}
								</Button>
							</div>
						</div>
					)}
		</div>
	);
}
