import type { EffectiveCapabilities } from "../../shared/capabilities.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import {
	LearnerStoreError,
	loadProfile,
	mutateProfile,
} from "../../memory/learner/profile-store.js";
import type {
	KnowledgeState,
	LearnerPreferences,
	LearnerProfile,
	LearningGoal,
	Misconception,
} from "../../memory/learner/types.js";
import type { RuntimePaths } from "../../runtime.js";
import { nextManualStamp } from "../../memory/learner/projection.js";
import { buildRecommendationSnapshot } from "../../learning/recommendations.js";
import { json, matchRoute, readBody } from "../http-helpers.js";

export interface LearnerRouteContext {
	capabilities?: EffectiveCapabilities;
	paths: RuntimePaths;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split)
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

function normalizePreferences(input: Partial<LearnerPreferences>): LearnerPreferences {
	function arr(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
	}
	return {
		explanation_style: arr(input.explanation_style),
		practice_style: arr(input.practice_style),
		feedback_tone: arr(input.feedback_tone),
		avoid: arr(input.avoid),
	};
}

/**
 * Public error response: only the store's error code and the affected data
 * category, never a local path or user content.
 */
function sendStoreError(res: ServerResponse, err: unknown): boolean {
	if (!(err instanceof LearnerStoreError)) return false;
	const conflictCodes = new Set([
		"LEARNING_RECORD_CONFLICT",
		"HISTORY_IDENTITY_CONFLICT",
		"ATTEMPT_IDENTITY_MISMATCH",
		"CORRECTION_CONFLICT",
		"PROJECTION_CONFLICT",
	]);
	const status = conflictCodes.has(err.code) ? 409 : 503;
	json(res, status, { error: err.code, category: "learner-store" });
	return true;
}

/**
 * /api/learner/* route domain (L1 profile inspect/edit). Returns true when
 * the request was handled. Every mutation is a serialized read-modify-write
 * through the single owner, so two tabs cannot overwrite each other's fields.
 */
export async function handleLearnerRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: LearnerRouteContext,
): Promise<boolean> {
	const { paths } = ctx;
	const dataDir = paths.learnerDataDir;

	try {
		// --- C4-B: read-only next-step recommendations ---
		// Pure decision layer: reads the L1 profile, evaluates it against the
		// server's instant, and returns a public snapshot. It never writes
		// evidence, never touches the B2 checkpoint and never calls a model.
		const parsedUrl = new URL(url, "http://localhost");
		if (method === "GET" && parsedUrl.pathname === "/api/learner/recommendations") {
			const rawLimit = parsedUrl.searchParams.get("limit");
			let limit = 3;
			if (rawLimit !== null) {
				if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 20) {
					json(res, 400, { error: "invalid_limit", message: "limit 必须是 1-20 的整数" });
					return true;
				}
				limit = Number(rawLimit);
			}
			const rawConceptId = parsedUrl.searchParams.get("concept_id");
			let conceptId: string | undefined;
			if (rawConceptId !== null) {
				const trimmed = rawConceptId.trim();
				// Same identifier shape the question request accepts; the client may
				// only name a concept, never supply its own state or mastery.
				if (!trimmed || trimmed.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(trimmed)) {
					json(res, 400, { error: "invalid_concept_id", message: "concept_id 不合法" });
					return true;
				}
				conceptId = trimmed;
			}
			const profile = await loadProfile(dataDir);
			json(res, 200, buildRecommendationSnapshot(profile, new Date(), {
				limit,
				...(conceptId ? { conceptId } : {}),
			}));
			return true;
		}

		// --- Learner profile API (L1) ---
		if (method === "GET" && url === "/api/learner/profile") {
			const profile = await loadProfile(dataDir);
			json(res, 200, profile);
			return true;
		}

		if (method === "PATCH" && url === "/api/learner/profile") {
			const body = await readBody(req) as Partial<LearnerProfile>;
			const profile = await mutateProfile(dataDir, (current) => {
				if (typeof body.profile_summary === "string") {
					current.profile_summary = body.profile_summary;
				}
				if (body.preferences && typeof body.preferences === "object") {
					const incoming = body.preferences as Partial<LearnerPreferences>;
					const manual = { ...(current.preferences.manual ?? {}) };
					for (const field of ["explanation_style", "practice_style", "feedback_tone", "avoid"] as const) {
						if (incoming[field] === undefined) continue;
						manual[field] = nextManualStamp(current);
					}
					current.preferences = { ...normalizePreferences(incoming), manual };
				}
				return true;
			});
			json(res, 200, profile);
			return true;
		}

		if (method === "POST" && url === "/api/learner/profile/goals") {
			const body = await readBody(req) as Partial<LearningGoal>;
			const goal: LearningGoal = {
				goal_id: `goal_${randomUUID().slice(0, 8)}`,
				title: typeof body.title === "string" ? body.title : "新目标",
				type: (body.type as LearningGoal["type"]) || "skill",
				priority: typeof body.priority === "number" ? body.priority : 0.5,
				status: (body.status as LearningGoal["status"]) || "active",
				success_criteria: Array.isArray(body.success_criteria) ? body.success_criteria.filter((s) => typeof s === "string") : [],
				source: "user_declared",
				updated_at: new Date().toISOString(),
			};
			await mutateProfile(dataDir, (profile) => {
				const manual = {
					title: nextManualStamp(profile),
					priority: nextManualStamp(profile),
					status: nextManualStamp(profile),
					success_criteria: nextManualStamp(profile),
				};
				profile.goals = [{ ...goal, manual }, ...profile.goals];
				return true;
			});
			json(res, 201, goal);
			return true;
		}

		const goalPatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/goals/:goalId");
		if (goalPatchMatch) {
			const body = await readBody(req) as Partial<LearningGoal>;
			let updated: LearningGoal | undefined;
			await mutateProfile(dataDir, (current) => {
				const index = current.goals.findIndex((g) => g.goal_id === goalPatchMatch.goalId);
				if (index < 0) return false;
				const goal = current.goals[index];
				const manual = { ...(goal.manual ?? {}) };
				// Only the fields this request actually changes become human-owned;
				// this keeps "edit status, later edit title" independently ordered.
				if (body.title !== undefined) manual.title = nextManualStamp(current);
				if (body.priority !== undefined) manual.priority = nextManualStamp(current);
				if (body.status !== undefined) manual.status = nextManualStamp(current);
				if (body.success_criteria !== undefined) manual.success_criteria = nextManualStamp(current);
				current.goals[index] = {
					...goal,
					title: typeof body.title === "string" ? body.title : goal.title,
					type: (body.type as LearningGoal["type"]) ?? goal.type,
					priority: typeof body.priority === "number" ? body.priority : goal.priority,
					status: (body.status as LearningGoal["status"]) ?? goal.status,
					success_criteria: Array.isArray(body.success_criteria)
						? body.success_criteria.filter((s) => typeof s === "string")
						: goal.success_criteria,
					updated_at: new Date().toISOString(),
					manual,
				};
				updated = current.goals[index];
				return true;
			});
			if (!updated) {
				json(res, 404, { error: "Goal not found" });
				return true;
			}
			json(res, 200, updated);
			return true;
		}

		const goalDeleteMatch = matchRoute("DELETE", method, url, "/api/learner/profile/goals/:goalId");
		if (goalDeleteMatch) {
			let found = false;
			await mutateProfile(dataDir, (current) => {
				const before = current.goals.length;
				current.goals = current.goals.filter((g) => g.goal_id !== goalDeleteMatch.goalId);
				found = current.goals.length !== before;
				if (!found) return false;
				// Tombstone: replaying an older declaration must not resurrect it.
				current.deleted_goals = {
					...current.deleted_goals,
					[goalDeleteMatch.goalId]: nextManualStamp(current),
				};
				return true;
			});
			if (!found) {
				json(res, 404, { error: "Goal not found" });
				return true;
			}
			json(res, 200, { deleted: true });
			return true;
		}

		const knowledgePatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/knowledge/:conceptId");
		if (knowledgePatchMatch) {
			const body = await readBody(req) as Partial<KnowledgeState>;
			let updated: KnowledgeState | undefined;
			await mutateProfile(dataDir, (current) => {
				const index = current.knowledge_states.findIndex((k) => k.concept_id === knowledgePatchMatch.conceptId);
				if (index < 0) return false;
				const state = current.knowledge_states[index];
				current.knowledge_states[index] = {
					...state,
					mastery: typeof body.mastery === "number" ? clamp01(body.mastery) : state.mastery,
					confidence: typeof body.confidence === "number" ? clamp01(body.confidence) : state.confidence,
					stability: typeof body.stability === "number" ? clamp01(body.stability) : state.stability,
					diagnosis: typeof body.diagnosis === "string" ? body.diagnosis : state.diagnosis,
					next_actions: Array.isArray(body.next_actions)
						? body.next_actions.filter((s) => typeof s === "string")
						: state.next_actions,
					origin: "manual",
				};
				updated = current.knowledge_states[index];
				return true;
			});
			if (!updated) {
				json(res, 404, { error: "Concept not found" });
				return true;
			}
			json(res, 200, updated);
			return true;
		}

		const misconceptionPatchMatch = matchRoute("PATCH", method, url, "/api/learner/profile/misconceptions/:miscId");
		if (misconceptionPatchMatch) {
			const body = await readBody(req) as Partial<Misconception>;
			let updated: Misconception | undefined;
			await mutateProfile(dataDir, (current) => {
				const index = current.misconceptions.findIndex((m) => m.misconception_id === misconceptionPatchMatch.miscId);
				if (index < 0) return false;
				const item = current.misconceptions[index];
				const manual = { ...(item.manual ?? {}) };
				if (body.status !== undefined) manual.status = nextManualStamp(current);
				if (body.severity !== undefined) manual.severity = nextManualStamp(current);
				if (body.repair_strategy !== undefined) manual.repair_strategy = nextManualStamp(current);
				current.misconceptions[index] = {
					...item,
					status: (body.status as Misconception["status"]) ?? item.status,
					severity: typeof body.severity === "number" ? clamp01(body.severity) : item.severity,
					repair_strategy: typeof body.repair_strategy === "string" ? body.repair_strategy : item.repair_strategy,
					last_seen_at: new Date().toISOString(),
					manual,
				};
				updated = current.misconceptions[index];
				return true;
			});
			if (!updated) {
				json(res, 404, { error: "Misconception not found" });
				return true;
			}
			json(res, 200, updated);
			return true;
		}

		return false;
	} catch (err) {
		if (sendStoreError(res, err)) return true;
		throw err;
	}
}
