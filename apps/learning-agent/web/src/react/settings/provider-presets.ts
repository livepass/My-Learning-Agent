/**
 * Guided provider presets for the "add model" wizard, in the spirit of
 * cc-switch's preset catalog. Each preset pre-fills the OpenAI-compatible
 * endpoint, links to the console where the user gets an API key, and carries
 * brand metadata (icon asset + glyph fallback + color) used across the settings UI.
 */

export interface ProviderPreset {
	/** Default provider id written into config.json */
	id: string;
	/** Display name */
	name: string;
	/**
	 * Translation key for the one-line description on the picker card (E4.9b).
	 * This module stays data-only: the render site resolves the key with `t()`.
	 */
	descriptionKey: string;
	/** Brand color used for the icon tile */
	brandColor: string;
	/** Optional local brand icon. The glyph remains the fallback for custom/unknown providers. */
	iconSrc?: string;
	/** Short glyph rendered inside the icon tile (letter mark) */
	glyph: string;
	/** Pre-filled API base URL (OpenAI-compatible unless api says otherwise) */
	baseUrl: string;
	api: string;
	/** Console page where the user creates/copies an API key */
	consoleUrl: string;
	/** API documentation page */
	docsUrl: string;
	/** Optional hint shown under the model field (e.g. endpoint-id note). */
	modelHintKey?: string;
}

/**
 * The six brand presets rendered as cards. "Custom" is deliberately not one of
 * them (E3.1 UI v2.1): it has its own entry point — the "add provider" button
 * beside the vendor list — so a seventh peer card would duplicate that action.
 */
export const BRAND_PRESETS: ProviderPreset[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		descriptionKey: "settings.presets.deepseek.description",
		brandColor: "#4D6BFE",
		iconSrc: "/provider-icons/deepseek.png",
		glyph: "DS",
		baseUrl: "https://api.deepseek.com/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.deepseek.com/api_keys",
		docsUrl: "https://api-docs.deepseek.com/zh-cn/",
	},
	{
		id: "kimi",
		name: "Kimi",
		descriptionKey: "settings.presets.kimi.description",
		brandColor: "#6366F1",
		iconSrc: "/provider-icons/kimi-rounded.png",
		glyph: "K",
		baseUrl: "https://api.moonshot.cn/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.moonshot.cn/console/api-keys",
		docsUrl: "https://platform.moonshot.cn/docs",
	},
	{
		id: "minimax",
		name: "MiniMax",
		descriptionKey: "settings.presets.minimax.description",
		brandColor: "#FF6B6B",
		iconSrc: "/provider-icons/minimax-user-icon.png",
		glyph: "MM",
		baseUrl: "https://api.minimaxi.com/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		docsUrl: "https://platform.minimaxi.com/document",
	},
	{
		id: "volcengine",
		name: "Volcengine",
		descriptionKey: "settings.presets.volcengine.description",
		brandColor: "#F5582E",
		iconSrc: "/provider-icons/volcengine-icon.svg",
		glyph: "V",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		api: "openai-completions",
		consoleUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
		docsUrl: "https://www.volcengine.com/docs/82379",
		modelHintKey: "settings.presets.volcengine.modelHint",
	},
	{
		id: "xiaomimimo",
		name: "Xiaomi MiMo",
		descriptionKey: "settings.presets.xiaomimimo.description",
		brandColor: "#FF6900",
		iconSrc: "/provider-icons/xiaomi-mi.png",
		glyph: "Mi",
		baseUrl: "https://api.xiaomimimo.com/v1",
		api: "openai-completions",
		consoleUrl: "https://platform.xiaomimimo.com",
		docsUrl: "https://platform.xiaomimimo.com",
	},
	{
		id: "bailian",
		name: "Bailian",
		descriptionKey: "settings.presets.bailian.description",
		brandColor: "#624AFF",
		iconSrc: "/provider-icons/bailian.svg",
		glyph: "B",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		api: "openai-completions",
		consoleUrl: "https://bailian.console.aliyun.com/#/api-key",
		docsUrl: "https://help.aliyun.com/zh/model-studio/",
	},
];

/**
 * The custom-provider form's own preset. It carries no endpoint or brand, and
 * the wizard opens it from the "add provider" button instead of a card, so the
 * vendor grid stays six brand entries.
 */
export const CUSTOM_PRESET: ProviderPreset = {
	id: "custom",
	// The display name is translated at the render site (settings.presets.custom.name).
	name: "Custom",
	descriptionKey: "settings.presets.custom.description",
	brandColor: "#8A8F98",
	glyph: "+",
	baseUrl: "",
	api: "openai-completions",
	consoleUrl: "",
	docsUrl: "",
};

/** Every known preset. Kept for branding lookups; the custom entry is never a card. */
export const PROVIDER_PRESETS: ProviderPreset[] = [...BRAND_PRESETS, CUSTOM_PRESET];

/**
 * Look up a brand preset by provider id (used to brand existing providers).
 * "Custom" never matches: it has no brand, and a user-named provider must not
 * be labelled with the preset's own name.
 */
export function findPreset(providerId: string): ProviderPreset | undefined {
	const lower = providerId.toLowerCase();
	return BRAND_PRESETS.find((p) => p.id === lower || lower.includes(p.id));
}
