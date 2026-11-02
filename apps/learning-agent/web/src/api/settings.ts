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
