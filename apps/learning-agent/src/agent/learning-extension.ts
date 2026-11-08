import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimePaths } from "../runtime.js";
import type { InnoConfig } from "../config.js";
import { learningToolNames, LEARNING_SYSTEM_PROMPT, type EffectiveCapabilities } from "../shared/capabilities.js";
import { createLearnerTools } from "../memory/learner/learner-tools.js";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { getL2Memory } from "../memory/l2/l2-memory.js";
import { createL3Tools, getL3Memory } from "../memory/l3/l3-tools.js";
import { resolveRecallScope } from "../memory/l3/recall-scope.js";
import { CourseStore } from "../courses/course-store.js";
import { isSafeRecordId } from "../courses/types.js";
import { resolveCourseContext, type ResolvedCourseContext } from "../courses/course-context.js";
import { isProfileEmpty, loadProfile } from "../memory/learner/profile-store.js";
import { LEARNING_TEACHING_PROMPT, ONBOARDING_GUIDE } from "./system-prompt.js";
import {
	buildContextPack,
	formatContextPackForPrompt,
	scopeProfileToCourse,
} from "../memory/learner/context-pack.js";
import { buildCourseLearningContext } from "./course-learning-context.js";
import { logger } from "../logger.js";

/** Reuse memory owners; do not construct disabled plugins and then filter their tools. */
export function registerLearningExtension(pi: ExtensionAPI, config: InnoConfig, paths: RuntimePaths, caps: EffectiveCapabilities): void {
	const allowed = new Set(learningToolNames(caps));
	// One store instance for every course question this extension asks: L2
	// scope, L3 scope and the injected context must agree on the same binding.
	const courseStore = new CourseStore({ dataDir: paths.dataDir });
	const register = (tools: ReturnType<typeof createLearnerTools>) => {
		for (const tool of tools) if (allowed.has(tool.name)) pi.registerTool(tool);
	};
	if (caps.capabilities.learnerRead.enabled) register(createLearnerTools(paths.learnerDataDir, "default", () => true, paths.l2DataDir, () => caps.capabilities.memoryL2.enabled));
	if (caps.capabilities.memoryL2.enabled) {
		const memory = getL2Memory(paths.l2DataDir);
		// E4.2d: course scope for l2_query comes from the persisted session
		// binding. The model cannot pass a course id, and an unreadable course
		// store makes the tool fail closed instead of widening to global L2.
		register(createL2Tools(
			paths.l2DataDir,
			() => true,
			memory,
			undefined,
			async (sessionId) => {
				// E4.4-R1: a missing/unusable session id is NOT "unclassified".
				// Only a session we can positively identify as unbound may keep
				// the legacy global scope; an unknown identity must not widen
				// retrieval to every course's material.
				if (!sessionId || !isSafeRecordId(sessionId)) return { status: "unavailable" as const };
				try {
					const context = await courseStore.getSessionContext(sessionId);
					return context
						? { status: "course" as const, courseId: context.course.course_id, sourceIds: context.sourceIds }
						: { status: "unclassified" as const };
				} catch (err) {
					logger.warn({ err, sessionId }, "l2: course scope unavailable");
					return { status: "unavailable" as const };
				}
			},
		));
		void memory.backfill().catch(err => logger.warn({ err }, "Learning L2 backfill failed"));
	}
	const l3Memory = caps.capabilities.memoryL3.enabled
		? getL3Memory(paths.l3DataDir, paths.sessionDir)
		: null;
	if (l3Memory) {
		// E4.4b: recall scope is resolved asynchronously from the persisted
		// binding, so the tool never has to trust a course id from the model.
		register(createL3Tools(
			l3Memory,
			undefined,
			() => true,
			(sessionId) => resolveRecallScope(courseStore, sessionId),
		));
		void l3Memory.backfill().catch(err => logger.warn({ err }, "Learning L3 backfill failed"));
		pi.on("turn_end", async (_event, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			const id = sessionFile?.split(/[\\/]/).pop();
			if (id) await l3Memory.indexById(id).catch(err => logger.warn({ err }, "Learning L3 indexing failed"));
		});
	}
	pi.on("before_agent_start", async (event, ctx) => {
		const sections = [LEARNING_SYSTEM_PROMPT];
		const sessionId = ctx.sessionManager.getSessionFile?.()?.split(/[\\/]/).pop() ?? "";
		// E4.4-R1: resolve the binding ONCE for this turn. It decides both what
		// the learner-wide pack may contain and whether course memory is usable.
		let courseContext: ResolvedCourseContext | null = null;
		let courseContextError = false;
		if (sessionId) {
			try {
				courseContext = await resolveCourseContext(courseStore, sessionId);
			} catch (err) {
				courseContextError = true;
				logger.warn({ err, sessionId }, "course context unavailable for this turn");
			}
		}
		if (caps.capabilities.learnerRead.enabled) {
			// Same owner as every other L1 reader: no parallel JSON read path.
			try {
				const profile = await loadProfile(paths.learnerDataDir);
				// A new learner gets the structured onboarding flow so the agent
				// builds a baseline profile instead of making small talk.
				if (isProfileEmpty(profile)) sections.push(ONBOARDING_GUIDE);
				if (courseContext?.status === "course") {
					// A bound session sees this course's goals/states/misconceptions
					// only. Teaching preferences survive the scoping because they
					// belong to the learner, not to a subject.
					sections.push(formatContextPackForPrompt(buildContextPack(
						scopeProfileToCourse(profile, {
							courseId: courseContext.courseId,
							goalIds: courseContext.goalIds,
						}),
						[],
					)));
				} else if (courseContext?.status === "unclassified") {
					// Legacy conversation: the learner-wide pack is the pre-E4.4
					// behaviour and stays, clearly outside any course claim.
					sections.push(formatContextPackForPrompt(buildContextPack(profile, [])));
				} else {
					// Ownership unknown (missing session identity or unreadable
					// binding): injecting the learner-wide pack here would leak
					// another course's progress into a course turn.
					logger.warn(
						{ sessionId, courseContextError },
						"skipping learner-wide context because course ownership is unknown",
					);
				}
			} catch (err) {
				logger.warn({ err }, "L1 learner context unavailable for this turn");
			}
		}
		// E4.4c: course/task/L2/L3 context, scoped by the persisted binding.
		// An unclassified session gets nothing here and keeps the generic L1
		// block above; it is never presented as course memory.
		if (sessionId && !courseContextError) {
			try {
				const course = await buildCourseLearningContext({
					courseStore,
					paths,
					searchL2: caps.capabilities.memoryL2.enabled
						? async (query, limit, options) => {
							const memory = getL2Memory(paths.l2DataDir);
							await memory.backfill();
							return memory.search(query, limit, options);
						}
						: null,
					l3: l3Memory,
					resolveRecallScope: (id) => resolveRecallScope(courseStore, id),
				}, sessionId, event.prompt ?? "");
				if (course.status === "course") sections.push(course.section);
				else if (course.status === "unavailable") {
					logger.warn({ sessionId }, "course learning context unavailable; keeping the generic learner context only");
				}
			} catch (err) {
				// A missing course section is a degradation, not a broken turn.
				logger.warn({ err, sessionId }, "course learning context failed");
			}
		}
		// Entry gate + teaching strategy: the behaviour contract for learning turns.
		sections.push(LEARNING_TEACHING_PROMPT);
		return { systemPrompt: sections.join("\n\n") };
	});
}
