import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseThinkingLevel } from "./agent/thinking-settings.js";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePaths } from "./runtime.js";
import { writeJson } from "./storage/file-store.js";

export type InnoProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | string;
export type InnoModelInput = "text" | "image";

export interface InnoModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	/** Optional manual effort preference; omit to preserve existing defaults. */
	thinkingLevel?: ModelThinkingLevel;
	/**
	 * Optional per-model protocol override. Magpie serves OpenAI Chat
	 * Completions, OpenAI Responses and Anthropic Messages from one gateway;
	 * a model that needs a different wire protocol can carry it here instead of
	 * forcing the whole provider onto one API. Omitted → provider default.
	 */
	api?: InnoProviderApi;
	/**
	 * Optional per-model base URL. Magpie's Anthropic protocol lives at the
	 * gateway root while its OpenAI protocols live under `/v1`, so a mixed
	 * catalog cannot express both with the provider's single base URL.
	 * Omitted → provider base URL.
	 */
	baseUrl?: string;
	input: InnoModelInput[];
	contextWindow: number;
	maxTokens: number;
}

export interface InnoProviderConfig {
	baseUrl: string;
	apiKey: string;
	api?: InnoProviderApi;
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoModelConfig[];
}

export interface InnoMemoryConfig {
	/**
	 * When true (default), the L1 learner profile is active: the per-turn
	 * context pack (profile + recent events) is injected into the system prompt
	 * and the learner tools record/update the profile. When false, the profile
	 * is neither read into the prompt nor written by tools.
	 */
	l1Enabled: boolean;
	/**
	 * When true (default), L2 Wiki memory is active: the `l2_archive` /
	 * `l2_query` tools can write and read the knowledge base. When false, those
	 * tools become no-ops that report L2 is disabled.
	 */
	l2Enabled: boolean;
	/**
	 * When true (default), L3 cross-conversation recall is active: past sessions
	 * are searched via sqlite and relevant snippets are auto-injected / the
	 * `l3_recall` tool is exposed. When false, replies use only the current
	 * workspace contents and the current session context.
	 */
	l3Enabled: boolean;
}

/** What should happen when the desktop window's close button is clicked. */
export type InnoCloseBehavior = "ask" | "hide" | "quit";

/**
 * Permission policy template selected via the settings UI. "default" asks on
 * bash commands outside the read-only allowlist; "auto" auto-approves all
 * bash; "yolo" auto-approves every surface (the plugin's yoloMode rewrites
 * ask → allow). All three keep the hard-deny floor (destructive commands,
 * credential paths) — yoloMode cannot rewrite a deny.
 */
export type PermissionPolicyMode = "default" | "auto" | "yolo";

export interface InnoUiConfig {
	theme: string;
	closeBehavior: InnoCloseBehavior;
	/** Allow $...$ inline math. Disabled by default so currency stays plain text. */
	mathSingleDollar: boolean;
}

export interface InnoConfig {
	defaultProvider: string;
	defaultModel: string;
	providers: Record<string, InnoProviderConfig>;
	server?: {
		port: number;
	};
	memory?: InnoMemoryConfig;
	ui?: InnoUiConfig;
	/**
	 * Third-party PI extensions bundled with the app.
	 *
	 * - `permissionSystem` (@gotgenes/pi-permission-system): allow/ask/deny
	 *   policy gate for tool calls, bash commands, MCP, skills and file paths.
	 *   Policy lives in `<configDir>/extensions/pi-permission-system/config.json`
	 *   (managed default on first run). In server mode `ask` verdicts are
	 *   answered by the web approval card via the `inno-web` authorizer link
	 *   (permission-bridge.ts); no answer → deny (fail-closed). `mode` selects
	 *   the managed policy template ("default" asks on non-allowlisted bash,
	 *   "auto" auto-approves bash, "yolo" auto-approves every surface); the
	 *   hard-deny floor (destructive commands, credential paths) applies in all
	 *   three. Switching modes rewrites the plugin config file from the
	 *   template — hand edits to that file are lost on a mode switch.
	 */
	plugins?: {
		permissionSystem?: { enabled?: boolean; mode?: PermissionPolicyMode };
	};
}

interface LegacyInnoConfig extends Partial<InnoConfig> {
	openai?: InnoProviderConfig;
}

const LEGACY_OPENAI_PROVIDER_ID = "openai-custom";

function firstConfiguredModel(providers: Record<string, InnoProviderConfig>): { provider: string; model: string } | undefined {
	for (const [provider, providerConfig] of Object.entries(providers)) {
		const model = providerConfig.models[0];
		if (model) return { provider, model: model.id };
	}
	return undefined;
}

export function normalizeModelConfig(model: Partial<InnoModelConfig> & { id: string }): InnoModelConfig {
	const id = model.id.trim();
	if (!id) throw new Error("Model id is required");
	const contextWindow = model.contextWindow;
	const maxTokens = model.maxTokens;
	// Vision support is controlled by the optional `input` array. For legacy
	// configs that predate this field, preserve the historical behavior
	// (text+image) instead of silently downgrading vision-capable models
	// (Claude/GPT-4o) to text-only. Only configs that explicitly set `input`
	// without "image" are treated as text-only.
	const hasInputField = "input" in model;
	const supportsImages = hasInputField
		? Array.isArray(model.input) && model.input.includes("image")
		: true;
	const api = typeof model.api === "string" && model.api.trim() ? model.api.trim() : undefined;
	const baseUrl = typeof model.baseUrl === "string" && model.baseUrl.trim() ? model.baseUrl.trim() : undefined;
	return {
		id,
		name: (model.name?.trim() || id),
		reasoning: Boolean(model.reasoning),
		...(model.thinkingLevel !== undefined ? { thinkingLevel: parseThinkingLevel(model.thinkingLevel) } : {}),
		...(api ? { api } : {}),
		...(baseUrl ? { baseUrl } : {}),
		input: supportsImages ? ["text", "image"] : ["text"],
		contextWindow: contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0 ? Math.trunc(contextWindow) : 128000,
		maxTokens: maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.trunc(maxTokens) : 8192,
	};
}

function normalizeProviderHeaders(headers: InnoProviderConfig["headers"] | undefined): Record<string, string> | undefined {
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
	const normalized = Object.fromEntries(
		Object.entries(headers)
			.map(([key, value]) => [key.trim(), value] as const)
			.filter(([key, value]) => key.length > 0 && typeof value === "string"),
	);
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeProviderConfig(provider: Partial<InnoProviderConfig>): InnoProviderConfig {
	const baseUrl = provider.baseUrl?.trim() ?? "";
	if (!baseUrl) throw new Error("Provider baseUrl is required");
	const models = (provider.models ?? []).map((model) => normalizeModelConfig(model));
	if (models.length === 0) throw new Error("Provider must include at least one model");
	const headers = normalizeProviderHeaders(provider.headers);
	return {
		baseUrl,
		apiKey: provider.apiKey ?? "",
		api: provider.api?.trim() || "openai-completions",
		...(headers ? { headers } : {}),
		...(provider.authHeader === true ? { authHeader: true } : {}),
		...(provider.bypassProxy === true ? { bypassProxy: true } : {}),
		models,
	};
}

export function normalizeMemoryConfig(memory: Partial<InnoMemoryConfig> | undefined): InnoMemoryConfig {
	// All three memory layers default to ON; only an explicit `false` disables one.
	return {
		l1Enabled: memory?.l1Enabled !== false,
		l2Enabled: memory?.l2Enabled !== false,
		l3Enabled: memory?.l3Enabled !== false,
	};
}

/** Normalize one extension: lowercase, strip whitespace, ensure a leading dot. */
export function normalizeSmartInputExtension(raw: string): string | null {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return null;
	const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
	// Must contain at least one letter beyond the dot to be a real extension.
	if (!/^\.[a-z0-9][a-z0-9]*$/.test(withDot)) return null;
	return withDot;
}

/**
 * Normalize smart-input rules: trim keywords, drop empty/duplicate keywords
 * (system presets win duplicate keywords), normalize/dedupe allowed and
 * excluded extensions, backfill stable ids for rules saved without one, and
 * restore any missing built-in rules. A rule with no allowed extensions is
 * valid but matches nothing until the user either adds one or enables
 * all-formats mode.
 */
export function normalizeUiConfig(ui: Partial<InnoUiConfig> | undefined): InnoUiConfig {
	const theme = typeof ui?.theme === "string" && ui.theme.trim() ? ui.theme.trim() : "light";
	const closeBehavior: InnoCloseBehavior = ui?.closeBehavior === "hide" || ui?.closeBehavior === "quit"
		? ui.closeBehavior
		: "ask";
	return { theme, closeBehavior, mathSingleDollar: ui?.mathSingleDollar === true };
}

export function normalizeConfig(config: LegacyInnoConfig): InnoConfig {
	const providers: Record<string, InnoProviderConfig> = {};
	for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
		const id = providerId.trim();
		if (!id) continue;
		providers[id] = normalizeProviderConfig(providerConfig);
	}

	if (Object.keys(providers).length === 0 && config.openai) {
		providers[LEGACY_OPENAI_PROVIDER_ID] = normalizeProviderConfig(config.openai);
	}

	if (Object.keys(providers).length === 0) {
		throw new Error("Config must define at least one provider in providers");
	}

	const fallback = firstConfiguredModel(providers);
	if (!fallback) throw new Error("Config must define at least one model");

	const defaultProvider = config.defaultProvider?.trim() || fallback.provider;
	const defaultModel = config.defaultModel?.trim() || fallback.model;
	const defaultProviderConfig = providers[defaultProvider];
	const hasDefaultModel = defaultProviderConfig?.models.some((model) => model.id === defaultModel);

	return {
		defaultProvider: hasDefaultModel ? defaultProvider : fallback.provider,
		defaultModel: hasDefaultModel ? defaultModel : fallback.model,
		providers,
		server: config.server,
		memory: normalizeMemoryConfig(config.memory),
		ui: normalizeUiConfig(config.ui),
		plugins: config.plugins,
	} as InnoConfig;
}

/**
 * Load the inno-agent config from the resolved runtime config path.
 */
export function loadConfig(configPathOrDir: string): InnoConfig {
	const configPath = configPathOrDir.endsWith(".json")
		? configPathOrDir
		: join(configPathOrDir, "config.json");
	try {
		const raw = readFileSync(configPath, "utf-8");
		// Best-effort permission fix-up for configs written before saveConfig
		// started enforcing 0o600 — a config that is never re-saved would
		// otherwise stay world-readable forever.
		try {
			chmodSync(configPath, 0o600);
		} catch {
			// read-only FS / Windows — permissions are best-effort
		}
		return normalizeConfig(JSON.parse(raw) as LegacyInnoConfig);
	} catch (error) {
		throw new Error(
			`Failed to load Inno config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function saveConfig(configPathOrDir: string, config: InnoConfig): InnoConfig {
	const configPath = configPathOrDir.endsWith(".json")
		? configPathOrDir
		: join(configPathOrDir, "config.json");
	const normalized = normalizeConfig(config);
	// Atomic write (tmp + rename): a crash mid-write must not leave a truncated
	// config.json — the server hot-rewrites this file on every model switch.
	// 0o600: the file carries plaintext provider API keys and the bridge token.
	writeJson(configPath, normalized, { mode: 0o600 });
	return normalized;
}

export function setDefaultModel(config: InnoConfig, provider: string, model: string): InnoConfig {
	const providerId = provider.trim();
	const modelId = model.trim();
	if (!providerId || !modelId) throw new Error("Provider and model are required");
	const providerConfig = config.providers[providerId];
	if (!providerConfig) throw new Error(`Provider ${providerId} not found`);
	if (!providerConfig.models.some((m) => m.id === modelId)) {
		throw new Error(`Model ${providerId}/${modelId} not found in config`);
	}
	config.defaultProvider = providerId;
	config.defaultModel = modelId;
	return normalizeConfig(config);
}

export function upsertProvider(
	config: InnoConfig,
	providerId: string,
	provider: InnoProviderConfig,
	options: { makeDefault?: boolean; preserveApiKey?: boolean; preserveHeaders?: boolean } = {},
): InnoConfig {
	const id = providerId.trim();
	if (!id) throw new Error("Provider id is required");
	const existing = config.providers[id];
	const normalized = normalizeProviderConfig({
		...provider,
		headers: options.preserveHeaders && existing && provider.headers === undefined
			? existing.headers
			: provider.headers,
		apiKey:
			options.preserveApiKey && existing && (!provider.apiKey || provider.apiKey.startsWith("****"))
				? existing.apiKey
				: provider.apiKey,
	});
	config.providers[id] = normalized;
	if (options.makeDefault) {
		config.defaultProvider = id;
		config.defaultModel = normalized.models[0].id;
	}
	return normalizeConfig(config);
}

export function deleteProvider(config: InnoConfig, providerId: string): InnoConfig {
	const id = providerId.trim();
	if (!id) throw new Error("Provider id is required");
	if (!config.providers[id]) throw new Error(`Provider ${id} not found`);
	const remaining = Object.keys(config.providers).filter((k) => k !== id);
	if (remaining.length === 0) throw new Error("Cannot delete the last provider");
	delete config.providers[id];
	return normalizeConfig(config);
}

/**
 * Remove a single model from a provider. If the model was the provider's last
 * one, the provider itself is removed. Refuses to delete the very last model
 * across all providers (the config must always retain at least one model).
 */
export function deleteModel(config: InnoConfig, providerId: string, modelId: string): InnoConfig {
	const id = providerId.trim();
	const mid = modelId.trim();
	if (!id) throw new Error("Provider id is required");
	if (!mid) throw new Error("Model id is required");
	const provider = config.providers[id];
	if (!provider) throw new Error(`Provider ${id} not found`);
	if (!provider.models.some((m) => m.id === mid)) throw new Error(`Model ${id}/${mid} not found`);
	if (id === config.defaultProvider && mid === config.defaultModel) {
		throw new Error("Cannot delete the default model; switch to another model first");
	}

	const totalModels = Object.values(config.providers).reduce((sum, p) => sum + p.models.length, 0);
	if (totalModels <= 1) throw new Error("Cannot delete the last model");

	const remainingModels = provider.models.filter((m) => m.id !== mid);
	if (remainingModels.length === 0) {
		delete config.providers[id];
	} else {
		config.providers[id] = { ...provider, models: remainingModels };
	}
	return normalizeConfig(config);
}

export function getConfiguredPort(config: InnoConfig, override?: number): number {
	if (override) return override;
	const envPort = process.env.INNO_PORT ? Number.parseInt(process.env.INNO_PORT, 10) : undefined;
	if (envPort && Number.isFinite(envPort)) return envPort;
	return config.server?.port ?? 3000;
}

/**
 * Get the data directory path for the project.
 */
export function getDataDir(projectDir: string): string {
	return join(projectDir, "data");
}

export function getRuntimeDataDir(paths: RuntimePaths): string {
	return paths.dataDir;
}

/**
 * Get the learner data directory path.
 */
export function getLearnerDataDir(projectDir: string): string {
	return join(projectDir, "data", "learner");
}

/**
 * Get the session directory path.
 */
export function getSessionDir(projectDir: string): string {
	return join(projectDir, "data", "sessions");
}

/**
 * Get the jobs directory path.
 */
export function getJobsDir(projectDir: string): string {
	return join(projectDir, "data", "jobs");
}

/**
 * Get the Inno Agent skills directory loaded by the PI resource loader.
 */
export function getSkillsDir(projectDir: string): string {
	return join(projectDir, ".inno", "skills");
}

/**
 * Get the L2 Wiki memory data directory path.
 */
export function getL2DataDir(projectDir: string): string {
	return join(projectDir, "data", "l2");
}
