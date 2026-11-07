import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimePaths } from "../runtime.js";
import type { InnoConfig } from "../config.js";
import { learningToolNames, LEARNING_SYSTEM_PROMPT, type EffectiveCapabilities } from "../shared/capabilities.js";
import { createLearnerTools } from "../memory/learner/learner-tools.js";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { getL2Memory } from "../memory/l2/l2-memory.js";
import { createL3Tools, getL3Memory } from "../memory/l3/l3-tools.js";
import { CourseStore } from "../courses/course-store.js";
import { isProfileEmpty, loadProfile } from "../memory/learner/profile-store.js";
import { LEARNING_TEACHING_PROMPT, ONBOARDING_GUIDE } from "./system-prompt.js";
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
		// E4.2d: course scope for l2_query comes from the persisted session
		// binding. The model cannot pass a course id, and an unreadable course
		// store makes the tool fail closed instead of widening to global L2.
		const courseStore = new CourseStore({ dataDir: paths.dataDir });
		register(createL2Tools(
			paths.l2DataDir,
			() => true,
			memory,
			undefined,
			async (sessionId) => {
				if (!sessionId) return { status: "unclassified" as const };
				const context = await courseStore.getSessionContext(sessionId);
				return context
					? { status: "course" as const, courseId: context.course.course_id, sourceIds: context.sourceIds }
					: { status: "unclassified" as const };
			},
		));
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
				// A new learner gets the structured onboarding flow so the agent
				// builds a baseline profile instead of making small talk.
				if (isProfileEmpty(profile)) sections.push(ONBOARDING_GUIDE);
				sections.push(formatContextPackForPrompt(buildContextPack(profile, [])));
			} catch (err) {
				logger.warn({ err }, "L1 learner context unavailable for this turn");
			}
		}
		// Entry gate + teaching strategy: the behaviour contract for learning turns.
		sections.push(LEARNING_TEACHING_PROMPT);
		return { systemPrompt: sections.join("\n\n") };
	});
}
