import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimePaths } from "../runtime.js";
import type { InnoConfig } from "../config.js";
import { learningToolNames, LEARNING_SYSTEM_PROMPT, type EffectiveCapabilities } from "../shared/capabilities.js";
import { createLearnerTools } from "../memory/learner/learner-tools.js";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { getL2Memory } from "../memory/l2/l2-memory.js";
import { createL3Tools, getL3Memory } from "../memory/l3/l3-tools.js";
import { loadProfile } from "../memory/learner/profile-store.js";
import { buildContextPack, formatContextPackForPrompt } from "../memory/learner/context-pack.js";
import { logger } from "../logger.js";

/** Reuse memory owners; do not construct disabled plugins and then filter their tools. */
export function registerLearningExtension(pi: ExtensionAPI, config: InnoConfig, paths: RuntimePaths, caps: EffectiveCapabilities): void {
	const allowed = new Set(learningToolNames(caps));
	const register = (tools: ReturnType<typeof createLearnerTools>) => {
		for (const tool of tools) if (allowed.has(tool.name)) pi.registerTool(tool);
	};
	if (caps.capabilities.learnerRead.enabled) register(createLearnerTools(paths.learnerDataDir, "default", () => true, paths.l2DataDir, () => caps.capabilities.memoryL2.enabled));
	if (caps.capabilities.memoryL2.enabled) {
		const memory = getL2Memory(paths.l2DataDir);
		register(createL2Tools(paths.l2DataDir, () => true, memory));
		void memory.backfill().catch(err => logger.warn({ err }, "Learning L2 backfill failed"));
	}
	if (caps.capabilities.memoryL3.enabled) {
		const memory = getL3Memory(paths.l3DataDir, paths.sessionDir);
		register(createL3Tools(memory, undefined, () => true));
		void memory.backfill().catch(err => logger.warn({ err }, "Learning L3 backfill failed"));
		pi.on("turn_end", async (_event, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			const id = sessionFile?.split(/[\\/]/).pop();
			if (id) await memory.indexById(id).catch(err => logger.warn({ err }, "Learning L3 indexing failed"));
		});
	}
	pi.on("before_agent_start", async () => {
		const sections = [LEARNING_SYSTEM_PROMPT];
		if (caps.capabilities.learnerRead.enabled) {
			// Same owner as every other L1 reader: no parallel JSON read path.
			try {
				const profile = await loadProfile(paths.learnerDataDir);
				sections.push(formatContextPackForPrompt(buildContextPack(profile, [])));
			} catch (err) {
				logger.warn({ err }, "L1 learner context unavailable for this turn");
			}
		}
		return { systemPrompt: sections.join("\n\n") };
	});
}
