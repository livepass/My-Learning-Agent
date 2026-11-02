import { resolveCapabilities } from "../shared/capabilities.js";
import { registerLearningExtension } from "./learning-extension.js";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { saveConfig, setDefaultModel, type InnoConfig } from "../config.js";
import { manualThinkingLevelMap, setThinkingLevelResolver } from "./thinking-settings.js";
import { logger } from "../logger.js";
import type { RuntimePaths } from "../runtime.js";

/**
 * Create the inno-agent extension factory.
 *
 * The learning product registers configured model providers, persists model
 * preference changes, and delegates all tools/prompt hooks to
 * `registerLearningExtension`. The workbench-only registrations (learner CLI
 * tools, scheduler, channels, MCP, subagents, codemode, computer-use, office,
 * OCR, Tavily, practice lab) were removed with the legacy feature set.
 */
export interface ConfigHolder {
	current: InnoConfig;
}

export interface InnoExtensionDeps {
	capabilities?: import("../shared/capabilities.js").EffectiveCapabilities;
}

/**
 * Inno's own slash commands. Each expands into a user message that steers the
 * agent to the right memory tool — no TUI overlay needed, so they work
 * identically from the web composer palette and the CLI. The name set is
 * exported so pi-runner.listSlashCommands() can mark them webSafe (inline
 * extension factories receive a synthetic "<inline:N>" sourceInfo, making the
 * command's origin path unusable for this).
 */
interface InnoSlashCommand {
	name: string;
	description: string;
	buildMessage: (args: string) => string;
}

const INNO_SLASH_COMMANDS: InnoSlashCommand[] = [
	{
		name: "recall",
		description: "回忆过去的对话（L3 跨会话记忆）。用法: /recall <问题>",
		buildMessage: (query) =>
			query
				? `请使用 l3_recall 工具检索我们过去的对话，并结合检索结果回答：${query}`
				: "请使用 l3_recall 工具回顾我们之前的对话，总结一下最近学过的重点。",
	},
	{
		name: "remember",
		description: "把关于你的事实写入学习者画像（L1）。用法: /remember <事实>",
		buildMessage: (fact) =>
			fact
				? `请将以下关于我的信息记录到学习者画像（L1），并简短确认你记住了什么：${fact}`
				: "我想让你记住一些关于我学习情况的信息（学习者画像 L1）。请问我需要告诉你什么？",
	},
	{
		name: "wiki",
		description: "检索 L2 Wiki 知识库并回答问题。用法: /wiki <问题>",
		buildMessage: (query) =>
			query
				? `请使用 l2_query 工具检索 Wiki 知识库，并结合检索结果回答：${query}`
				: "请使用 l2_query 工具查看 Wiki 知识库的索引概览，告诉我里面都归档了哪些内容。",
	},
];

export const INNO_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(INNO_SLASH_COMMANDS.map((command) => command.name));

/**
 * Expand an Inno slash command ("/recall <q>") into its user-message form.
 * Returns null when the text is not an Inno command. pi-runner applies this
 * before session.prompt(): the registerCommand handler routes through
 * pi.sendUserMessage, which the SDK binds fire-and-forget, so a command
 * dispatched inside prompt() returns immediately while the turn it triggers
 * is still running — and per-prompt event subscriptions (runPromptStreaming,
 * used by web and channels) would close before the reply streams. Expanding
 * up front makes the turn an ordinary prompt. The CLI uses the
 * registerCommand path instead, where the TUI's long-lived subscription is
 * unaffected.
 */
export function expandInnoSlashCommand(text: string): string | null {
	if (!text.startsWith("/")) return null;
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const command = INNO_SLASH_COMMANDS.find((entry) => entry.name === name);
	if (!command) return null;
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	return command.buildMessage(args);
}

/** Recover the slash form from a persisted expanded Inno command. */
export function collapseInnoSlashCommand(text: string): string | null {
	const value = text.trim();
	for (const command of INNO_SLASH_COMMANDS) {
		if (value === command.buildMessage("")) return `/${command.name}`;
		const marker = "\u0000";
		const expanded = command.buildMessage(marker);
		const prefix = expanded.slice(0, -marker.length);
		if (value.startsWith(prefix)) {
			const args = value.slice(prefix.length).trim();
			if (args) return `/${command.name} ${args}`;
		}
	}
	return null;
}

export function createInnoExtension(
	configHolder: ConfigHolder,
	paths: RuntimePaths,
	deps?: InnoExtensionDeps,
): ExtensionFactory {
	return async (pi: ExtensionAPI) => {
		setThinkingLevelResolver(model => {
			const configured = configHolder.current.providers[model.provider]?.models.find(m => m.id === model.id);
			return configured?.reasoning ? configured.thinkingLevel : undefined;
		});
		// 1. Register configured backend model providers.
		const config = configHolder.current;
		for (const [providerId, providerConfig] of Object.entries(config.providers)) {
			pi.registerProvider(providerId, {
				baseUrl: providerConfig.baseUrl,
				apiKey: providerConfig.apiKey || "local",
				api: providerConfig.api ?? "openai-completions",
				headers: providerConfig.headers,
				authHeader: providerConfig.authHeader,
				models: providerConfig.models.map((m) => ({
					id: m.id,
					name: m.name,
					reasoning: m.reasoning,
					thinkingLevelMap: manualThinkingLevelMap(m.thinkingLevel),
					input: m.input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					compat: {
						supportsDeveloperRole: false,
					},
				})),
			});
		}

		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.model) return;
			const preference = configHolder.current.providers[ctx.model.provider]?.models.find(m => m.id === ctx.model!.id);
			if (preference?.reasoning && preference.thinkingLevel !== undefined) pi.setThinkingLevel(preference.thinkingLevel);
		});
		pi.on("model_select", async (event) => {
			const preference = configHolder.current.providers[event.model.provider]?.models.find(m => m.id === event.model.id);
			if (preference?.reasoning && preference.thinkingLevel !== undefined) pi.setThinkingLevel(preference.thinkingLevel);
			const cfg = configHolder.current;
			if (!cfg.providers[event.model.provider]) return;
			try {
				configHolder.current = saveConfig(paths.configPath, setDefaultModel(cfg, event.model.provider, event.model.id));
			} catch (err) {
				// The selected model may be a runtime-only model; leave persisted config unchanged.
				logger.warn({ err, provider: event.model.provider, modelId: event.model.id }, "model_select: failed to persist default model to config");
			}
		});

		// Single product: the learning extension is the only tool surface.
		registerLearningExtension(pi, config, paths, deps?.capabilities ?? resolveCapabilities(config));
	};
}
