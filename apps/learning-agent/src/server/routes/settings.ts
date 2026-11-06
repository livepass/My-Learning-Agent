import type { EffectiveCapabilities } from "../../shared/capabilities.js";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { probeProviderModels } from "../../agent/model-probe.js";
import {
	fetchMagpieCatalog,
	MAGPIE_LOCAL_CLIENT_ID,
	MAGPIE_PROVIDER_ID,
	normalizeMagpieGatewayUrl,
	probeMagpieGateway,
	MagpieError,
} from "../../agent/magpie.js";
import { parseThinkingLevel } from "../../agent/thinking-settings.js";
import {
	getAvailableModels,
	getSessionIfInitialized,
	refreshConfiguredProviders,
	switchModel,
	syncConfig,
} from "../../agent/pi-runner.js";
import {
	deleteModel,
	deleteProvider,
	normalizeUiConfig,
	saveConfig,
	setDefaultModel,
	upsertProvider,
	type InnoConfig,
	type InnoModelConfig,
	type InnoProviderConfig,
} from "../../config.js";
import { logger } from "../../logger.js";
import type { RuntimePaths } from "../../runtime.js";
import { applyProviderProxyBypass } from "../../utils/proxy-bypass.js";
import { json, readBody } from "../http-helpers.js";

/**
 * Server state the settings routes touch. `config` is reassigned on every
 * write endpoint, so it flows through getter/setter; the three callbacks are
 * owned by server.ts (they serve other route domains too).
 */
export interface SettingsRouteContext {
	capabilities?: EffectiveCapabilities;
	paths: RuntimePaths;
	getConfig: () => InnoConfig;
	setConfig: (config: InnoConfig) => void;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (only used by this route domain).
// ---------------------------------------------------------------------------

function maskSecret(value: string | undefined): string {
	return value ? `****${value.slice(-4)}` : "";
}

function providerModelToRuntimeModel(model: InnoModelConfig, provider: string, baseUrl: string) {
	return {
		id: model.id,
		name: model.name,
		provider,
		reasoning: model.reasoning,
		thinkingLevel: model.thinkingLevel,
		// Per-model overrides must survive into the settings payload: the
		// Magpie panel round-trips these back on the next save, and the chat
		// model picker identifies the wire protocol by them.
		...(model.api ? { api: model.api } : {}),
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl: model.baseUrl ?? baseUrl,
	};
}

function buildSafeSettings(config: InnoConfig) {
	// Settings are available while Agent extensions are still initializing.
	const session = getSessionIfInitialized();
	const currentModel = session?.model;
	const configuredModels = Object.entries(config.providers).flatMap(([providerId, providerConfig]) =>
		providerConfig.models.map((model) => providerModelToRuntimeModel(model, providerId, providerConfig.baseUrl)),
	);
	const availableModels = (session ? getAvailableModels() : configuredModels).map((model) => {
		const api = (model as { api?: unknown }).api;
		const modelBaseUrl = (model as { baseUrl?: unknown }).baseUrl;
		return {
			id: model.id,
			name: model.name,
			provider: model.provider,
			reasoning: model.reasoning,
			...(typeof api === "string" && api ? { api } : {}),
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			...(typeof modelBaseUrl === "string" && modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
		};
	});

	return {
		...config,
		defaultProvider: currentModel?.provider ?? config.defaultProvider,
		defaultModel: currentModel?.id ?? config.defaultModel,
		configuredModels,
		availableModels,
		providers: Object.fromEntries(
			Object.entries(config.providers).map(([providerId, providerConfig]) => [
				providerId,
				{
					...providerConfig,
					apiKey: maskSecret(providerConfig.apiKey),
					headers: providerConfig.headers
						? Object.fromEntries(Object.entries(providerConfig.headers).map(([key, value]) => [key, maskSecret(value)]))
						: undefined,
				},
			]),
		),
	};
}

function parseModelConfig(value: unknown): InnoModelConfig {
	if (!value || typeof value !== "object") throw new Error("Invalid model");
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) throw new Error("Model id is required");
	return {
		id,
		name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
		reasoning: Boolean(record.reasoning),
		...(record.thinkingLevel !== undefined ? { thinkingLevel: parseThinkingLevel(record.thinkingLevel) } : {}),
		...(typeof record.api === "string" && record.api.trim() ? { api: record.api.trim() } : {}),
		...(typeof record.baseUrl === "string" && record.baseUrl.trim() ? { baseUrl: record.baseUrl.trim() } : {}),
		input: ("input" in record)
			? (Array.isArray(record.input) && record.input.includes("image") ? ["text", "image"] : ["text"])
			: ["text", "image"],
		contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : Number(record.contextWindow ?? 128000),
		maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : Number(record.maxTokens ?? 8192),
	};
}

function parseStringHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		const normalizedKey = key.trim();
		if (normalizedKey && typeof headerValue === "string") {
			headers[normalizedKey] = headerValue;
		}
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseProviderPayload(body: Record<string, unknown>): {
	providerId: string;
	provider: InnoProviderConfig;
	makeDefault: boolean;
	preserveApiKey: boolean;
	preserveHeaders: boolean;
} {
	const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
		throw new Error("Provider id must use letters, numbers, dot, underscore, or dash");
	}
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
	const api = typeof body.api === "string" ? body.api.trim() : "openai-completions";
	const headers = parseStringHeaders(body.headers);
	const rawModels = Array.isArray(body.models) ? body.models : [];
	const models = rawModels.map(parseModelConfig);
	return {
		providerId,
		provider: {
			baseUrl,
			apiKey,
			api,
			...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
			...(body.authHeader === true ? { authHeader: true } : {}),
			...(body.bypassProxy === true ? { bypassProxy: true } : {}),
			models,
		},
		makeDefault: Boolean(body.makeDefault),
		preserveApiKey: Boolean(body.preserveApiKey),
		preserveHeaders: !Object.prototype.hasOwnProperty.call(body, "headers"),
	};
}

/**
 * /api/settings* and /api/mcp* route domain. Returns true when the request
 * was handled. Extracted verbatim from server.ts during the P2 route split —
 * behavior unchanged.
 */
export async function handleSettingsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SettingsRouteContext,
): Promise<boolean> {
	const { paths } = ctx;
	// Per-request view of the mutable config; every save mirrors back via
	// ctx.setConfig so subsequent requests (and other domains) see the write.
	let config = ctx.getConfig();
	const settingsView = () => {
		const view = buildSafeSettings(config);
		const { defaultProvider, defaultModel, configuredModels, availableModels, providers, memory, ui } = view;
		return { defaultProvider, defaultModel, configuredModels, availableModels, providers, memory, ui, effectiveCapabilities: ctx.capabilities };
	};
	const save = (next: InnoConfig): void => {
		config = next;
		ctx.setConfig(next);
	};

	if (method === "GET" && url === "/api/settings") {
		json(res, 200, settingsView());
		return true;
	}

	if (method === "POST" && url === "/api/settings/model") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (Object.hasOwn(body, "profile") || Object.hasOwn(body, "effectiveCapabilities")) { json(res, 400, { error: "Runtime profile cannot be changed through HTTP" }); return true; }
		const provider = typeof body.provider === "string" ? body.provider.trim() : "";
		const model = typeof body.model === "string" ? body.model.trim() : "";
		if (!provider || !model) {
			json(res, 400, { error: "Missing provider or model" });
			return true;
		}

		// Persist selections immediately; startup reconciles them once the runtime exists.
		const nextConfig = setDefaultModel({ ...config }, provider, model);
		if (getSessionIfInitialized()) await switchModel(provider, model);
		save(saveConfig(paths.configPath, nextConfig));
		syncConfig(config);
		const currentModel = getSessionIfInitialized()?.model;
		json(res, 200, {
			defaultProvider: currentModel?.provider ?? provider,
			defaultModel: currentModel?.id ?? model,
		});
		return true;
	}

	if ((method === "PUT" || method === "POST" || method === "PATCH") && url === "/api/settings/providers") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (Object.hasOwn(body, "profile") || Object.hasOwn(body, "effectiveCapabilities")) { json(res, 400, { error: "Runtime profile cannot be changed through HTTP" }); return true; }
		let payload: ReturnType<typeof parseProviderPayload>;
		try { payload = parseProviderPayload(body); } catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}
		// A Magpie provider may only point at a loopback/LAN gateway; the same
		// guard as the probe endpoints keeps the config from becoming an open
		// proxy for a later chat call.
		if (payload.providerId === MAGPIE_PROVIDER_ID) {
			try {
				await normalizeMagpieGatewayUrl(payload.provider.baseUrl);
			} catch (err) {
				if (err instanceof MagpieError) {
					json(res, err.status, { error: err.message, code: err.code });
					return true;
				}
				throw err;
			}
			// A local gateway accepts any key, and Magpie attributes the call
			// by the `magpie-<app-id>` value. Saving an empty key would make the
			// runtime send its generic `local` placeholder instead, so a
			// first save with no typed key stores the documented client id.
			const stored = config.providers?.[MAGPIE_PROVIDER_ID]?.apiKey ?? "";
			if (payload.preserveApiKey && (!payload.provider.apiKey || payload.provider.apiKey.startsWith("****"))) {
				payload.provider.apiKey = stored || MAGPIE_LOCAL_CLIENT_ID;
			}
		}
		save(saveConfig(
			paths.configPath,
			upsertProvider(config, payload.providerId, payload.provider, {
				makeDefault: payload.makeDefault,
				preserveApiKey: payload.preserveApiKey,
				preserveHeaders: payload.preserveHeaders,
			}),
		));
		applyProviderProxyBypass(config);
		const session = getSessionIfInitialized();
		if (session) await refreshConfiguredProviders(config);
		const active = session?.model;
		const editingActive = active?.provider === payload.providerId && payload.provider.models.some(m => m.id === active.id);
		if (session && (payload.makeDefault || editingActive)) {
			await switchModel(payload.makeDefault ? config.defaultProvider : active!.provider, payload.makeDefault ? config.defaultModel : active!.id);
			if (payload.makeDefault) save(saveConfig(paths.configPath, setDefaultModel(config, config.defaultProvider, config.defaultModel)));
		}
		json(res, 200, settingsView());
		return true;
	}

	// --- Magpie local gateway (E3.1) ---
	// Health and catalog live server-side for the same reason as the generic
	// probe: no CORS, no key in the browser. The URL is user-supplied, so
	// magpie.ts validates it as a loopback/LAN destination and refuses redirects.
	if (method === "POST" && (url === "/api/settings/magpie/health" || url === "/api/settings/magpie/models")) {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (Object.hasOwn(body, "profile") || Object.hasOwn(body, "effectiveCapabilities")) {
			json(res, 400, { error: "Runtime profile cannot be changed through HTTP" });
			return true;
		}
		const gatewayUrl = typeof body.gatewayUrl === "string" ? body.gatewayUrl : "";
		const typedKey = typeof body.gatewayKey === "string" ? body.gatewayKey.trim() : "";
		// Empty or masked key → the stored Magpie key; first run → local client id.
		const storedKey = config.providers?.[MAGPIE_PROVIDER_ID]?.apiKey ?? "";
		const gatewayKey = !typedKey || typedKey.startsWith("****") ? storedKey : typedKey;
		try {
			if (url.endsWith("/health")) {
				const result = await probeMagpieGateway({ gatewayUrl, gatewayKey });
				json(res, 200, { ok: true, gateway: result.gateway, gatewayUrl: result.gatewayUrl });
			} else {
				const catalog = await fetchMagpieCatalog({ gatewayUrl, gatewayKey });
				json(res, 200, { ok: true, ...catalog });
			}
		} catch (err) {
			if (err instanceof MagpieError) {
				json(res, err.status, { error: err.message, code: err.code });
				return true;
			}
			throw err;
		}
		return true;
	}

	// Probe a provider's model list server-side (the browser can't call
	// provider APIs directly due to CORS + API key exposure). If apiKey is
	// omitted, fall back to the stored key of an existing provider.
	if (method === "POST" && url === "/api/settings/providers/probe-models") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (Object.hasOwn(body, "profile") || Object.hasOwn(body, "effectiveCapabilities")) { json(res, 400, { error: "Runtime profile cannot be changed through HTTP" }); return true; }
		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
		const api = typeof body.api === "string" ? body.api : undefined;
		let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
		if ((!apiKey || apiKey.startsWith("****")) && providerId) {
			apiKey = config.providers?.[providerId]?.apiKey ?? "";
		}
		try {
			const result = await probeProviderModels({ baseUrl, apiKey, api });
			json(res, 200, result);
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	// Delete a single model from a provider. Must be matched before the
	// provider-delete route below (which uses startsWith on the same prefix).
	if (method === "DELETE" && /^\/api\/settings\/providers\/[^/]+\/models\/[^/]+$/.test(url)) {
		const rest = url.slice("/api/settings/providers/".length);
		const [providerPart, modelPart] = rest.split("/models/");
		const providerId = decodeURIComponent(providerPart);
		const modelId = decodeURIComponent(modelPart);
		if (!providerId || !modelId) {
			json(res, 400, { error: "Missing provider or model id" });
			return true;
		}
		try {
			save(saveConfig(paths.configPath, deleteModel(config, providerId, modelId)));
			if (getSessionIfInitialized()) await refreshConfiguredProviders(config);
		} catch (err) {
			logger.error({ err, providerId, modelId }, "failed to delete model");
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}
		json(res, 200, settingsView());
		return true;
	}

	if (method === "DELETE" && url.startsWith("/api/settings/providers/")) {
		const providerId = decodeURIComponent(url.slice("/api/settings/providers/".length));
		if (!providerId) {
			json(res, 400, { error: "Missing provider id" });
			return true;
		}
		try {
			save(saveConfig(paths.configPath, deleteProvider(config, providerId)));
			if (getSessionIfInitialized()) await refreshConfiguredProviders(config);
		} catch (err) {
			logger.error({ err }, "failed to update channel settings");
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}
		json(res, 200, settingsView());
		return true;
	}

	// --- Channels Settings ---
	if (method === "PUT" && url === "/api/settings/theme") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (Object.hasOwn(body, "profile") || Object.hasOwn(body, "effectiveCapabilities")) { json(res, 400, { error: "Runtime profile cannot be changed through HTTP" }); return true; }
		const theme = typeof body.theme === "string" ? body.theme.trim() : "";
		// Legacy values (warm/ocean/innospark) stay accepted so older clients do
		// not break; the web UI normalizes them to "light" on read.
		const ALLOWED_THEMES = ["light", "dark", "system", "warm", "ocean", "innospark"];
		if (!ALLOWED_THEMES.includes(theme)) {
			json(res, 400, { error: `Invalid theme. Allowed: ${ALLOWED_THEMES.join(", ")}` });
			return true;
		}
		config.ui = { ...normalizeUiConfig(config.ui), theme };
		save(saveConfig(paths.configPath, config));
		json(res, 200, settingsView());
		return true;
	}

	// PUT /api/settings/close-behavior — persist the cross-platform window-close preference
	if (method === "PUT" && url === "/api/settings/close-behavior") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (Object.hasOwn(body, "profile") || Object.hasOwn(body, "effectiveCapabilities")) { json(res, 400, { error: "Runtime profile cannot be changed through HTTP" }); return true; }
		const closeBehavior = body.closeBehavior;
		if (closeBehavior !== "ask" && closeBehavior !== "hide" && closeBehavior !== "quit") {
			json(res, 400, { error: "closeBehavior must be one of ask, hide, quit" });
			return true;
		}
		config.ui = {
			...normalizeUiConfig(config.ui),
			closeBehavior,
		};
		save(saveConfig(paths.configPath, config));
		json(res, 200, settingsView());
		return true;
	}

	// PUT /api/settings/markdown — persist user-facing Markdown parsing preferences
	if (method === "PUT" && url === "/api/settings/markdown") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (Object.hasOwn(body, "profile") || Object.hasOwn(body, "effectiveCapabilities")) { json(res, 400, { error: "Runtime profile cannot be changed through HTTP" }); return true; }
		if (typeof body.mathSingleDollar !== "boolean") {
			json(res, 400, { error: "mathSingleDollar must be a boolean" });
			return true;
		}
		config.ui = {
			...normalizeUiConfig(config.ui),
			mathSingleDollar: body.mathSingleDollar,
		};
		save(saveConfig(paths.configPath, config));
		json(res, 200, settingsView());
		return true;
	}

	return false;
}
