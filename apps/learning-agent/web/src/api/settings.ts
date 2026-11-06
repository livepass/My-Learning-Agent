import { apiFetch } from "./client.js";
import type { InnoSettings, UpsertProviderRequest, WindowCloseBehavior } from "../types/settings.js";

export async function getSettings(): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings");
}

export async function switchBackendModel(provider: string, model: string): Promise<Pick<InnoSettings, "defaultProvider" | "defaultModel">> {
	return apiFetch<Pick<InnoSettings, "defaultProvider" | "defaultModel">>("/api/settings/model", {
		method: "POST",
		body: JSON.stringify({ provider, model }),
	});
}

export async function upsertProvider(payload: UpsertProviderRequest): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export async function deleteProviderApi(providerId: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
		method: "DELETE",
	});
}

export async function deleteModelApi(providerId: string, modelId: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>(
		`/api/settings/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
		{ method: "DELETE" },
	);
}

export interface ProbeModelsRequest {
	baseUrl: string;
	apiKey?: string;
	providerId?: string;
	api?: string;
}

export async function probeProviderModels(payload: ProbeModelsRequest): Promise<{ models: string[] }> {
	return apiFetch<{ models: string[] }>("/api/settings/providers/probe-models", {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export interface MagpieGatewayHealth {
	name: string;
	version?: string;
}

export interface MagpieModelInfo {
	id: string;
	displayName: string;
	ownedBy?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: Array<"text" | "image">;
	confirmed: {
		contextWindow: boolean;
		maxTokens: boolean;
		reasoning: boolean;
		input: boolean;
	};
}

export interface MagpieCatalogResponse {
	ok: true;
	gateway: MagpieGatewayHealth;
	gatewayUrl: string;
	models: MagpieModelInfo[];
	warnings: string[];
}

export async function probeMagpieGateway(payload: { gatewayUrl: string; gatewayKey?: string }): Promise<{ ok: true; gateway: MagpieGatewayHealth; gatewayUrl: string }> {
	return apiFetch("/api/settings/magpie/health", {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export async function fetchMagpieCatalog(payload: { gatewayUrl: string; gatewayKey?: string }): Promise<MagpieCatalogResponse> {
	return apiFetch("/api/settings/magpie/models", {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export async function saveThemeSettings(theme: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/theme", {
		method: "PUT",
		body: JSON.stringify({ theme }),
	});
}

export async function saveCloseBehavior(closeBehavior: WindowCloseBehavior): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/close-behavior", {
		method: "PUT",
		body: JSON.stringify({ closeBehavior }),
	});
}

export async function saveMarkdownSettings(mathSingleDollar: boolean): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/markdown", {
		method: "PUT",
		body: JSON.stringify({ mathSingleDollar }),
	});
}
