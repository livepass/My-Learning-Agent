import type { InnoModelInfo } from "../../types/settings.js";

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

export function modelKey(model: InnoModelInfo): string {
	return `${model.provider}:${model.id}`;
}

/**
 * Round-trip key for a model option value. Model ids may contain `:` (Magpie
 * routing groups and `provider/model` ids), so the separator form above cannot
 * be parsed back reliably; JSON keeps the pair unambiguous.
 */
export function encodeModelKey(provider: string, model: string): string {
	return JSON.stringify([provider, model]);
}

export function decodeModelKey(value: string): { provider: string; model: string } | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
			return { provider: parsed[0], model: parsed[1] };
		}
	} catch {
		// A malformed option value simply selects nothing.
	}
	return null;
}
