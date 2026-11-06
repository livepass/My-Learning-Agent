import type { EffectiveCapabilities } from "../../../src/shared/capabilities.js";
export type InnoThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface InnoModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	thinkingLevel?: InnoThinkingLevel;
	/** Per-model protocol override (Magpie mixed catalogs). */
	api?: string;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	baseUrl?: string;
}

export interface InnoProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevel?: InnoThinkingLevel;
	/** Per-model protocol override; omitted → provider API. */
	api?: string;
	/** Per-model base URL override; omitted → provider base URL. */
	baseUrl?: string;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
}

export interface InnoProviderSettings {
	baseUrl: string;
	apiKey: string; // masked
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoProviderModel[];
}

export interface UpsertProviderRequest {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoProviderModel[];
	makeDefault?: boolean;
	preserveApiKey?: boolean;
}

export type WindowCloseBehavior = "ask" | "hide" | "quit";

export interface InnoSettings {
	effectiveCapabilities?: EffectiveCapabilities;
	defaultProvider: string;
	defaultModel: string;
	configuredModels?: InnoModelInfo[];
	availableModels?: InnoModelInfo[];
	providers: Record<string, InnoProviderSettings>;
	server?: { port: number };
	memory?: { l1Enabled: boolean; l2Enabled: boolean; l3Enabled: boolean };
	plugins?: {
		permissionSystem?: { enabled?: boolean; mode?: PermissionPolicyMode };
	};
	ui?: { theme: string; closeBehavior: WindowCloseBehavior; mathSingleDollar: boolean };
}

export type PermissionPolicyMode = "default" | "auto" | "yolo";
