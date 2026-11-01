import type {
	LearnerProfile,
	LearningGoal,
	KnowledgeState,
	Misconception,
	LearnerPreferences,
	ManualStamp,
	GoalManualField,
	PreferenceManualField,
	MisconceptionManualField,
} from "./types.js";
import { mutateProfile } from "./profile-store.js";
import { nextManualStamp } from "./projection.js";

/**
 * Describes a partial update to the learner profile.
 * Array fields are merged by ID; simple fields are overwritten.
 */
export interface ProfileUpdate {
	goals?: LearningGoal[];
	knowledge_states?: KnowledgeState[];
	misconceptions?: Misconception[];
	preferences?: Partial<LearnerPreferences>;
	profile_summary?: string;
}

export interface ProfilePatch {
	concept_id?: string;
	concept_name?: string;
	domain?: string;
	mastery_delta?: number;
	mastery?: number;
	confidence?: number;
	stability_delta?: number;
	diagnosis?: string;
	next_actions_append?: string[];
	evidence_ids_append?: string[];
	last_practiced_at?: string;
	review_due_at?: string;
	preferences_append?: Partial<LearnerPreferences>;
	profile_summary_append?: string;
}

const GOAL_FIELDS: GoalManualField[] = ["title", "priority", "status", "success_criteria"];
const PREFERENCE_FIELDS: PreferenceManualField[] = ["explanation_style", "practice_style", "feedback_tone", "avoid"];
const MISCONCEPTION_FIELDS: MisconceptionManualField[] = ["status", "severity", "repair_strategy"];

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

/** Merge an array of items by ID field. */
function mergeById<T>(
	existing: T[],
	incoming: T[],
	idField: keyof T,
): T[] {
	const result = [...existing];
	for (const item of incoming) {
		const idx = result.findIndex((e) => e[idField] === item[idField]);
		if (idx >= 0) {
			result[idx] = item;
		} else {
			result.push(item);
		}
	}
	return result;
}

/** Stamp every protected field of an explicit API write, in field order. */
function stampFields<K extends string>(profile: LearnerProfile, fields: readonly K[]): Partial<Record<K, ManualStamp>> {
	const stamps: Partial<Record<K, ManualStamp>> = {};
	for (const field of fields) stamps[field] = nextManualStamp(profile);
	return stamps;
}

function markGoalManual(profile: LearnerProfile, goal: LearningGoal): LearningGoal {
	return { ...goal, manual: { ...(goal.manual ?? {}), ...stampFields(profile, GOAL_FIELDS) } };
}

function markMisconceptionManual(profile: LearnerProfile, item: Misconception): Misconception {
	return { ...item, manual: { ...(item.manual ?? {}), ...stampFields(profile, MISCONCEPTION_FIELDS) } };
}

function markPreferencesManual(
	profile: LearnerProfile,
	preferences: LearnerPreferences,
	fields: PreferenceManualField[],
): LearnerPreferences {
	return { ...preferences, manual: { ...(preferences.manual ?? {}), ...stampFields(profile, fields) } };
}

/**
 * Explicit API/tool writes are user-owned values: they become the trusted
 * baseline for later evidence projection and are not reset by a rebuild.
 */
export async function updateProfile(dataDir: string, update: ProfileUpdate): Promise<LearnerProfile> {
	return mutateProfile(dataDir, (profile) => {
		if (update.goals) {
			profile.goals = mergeById<LearningGoal>(
				profile.goals,
				update.goals.map((goal) => markGoalManual(profile, goal)),
				"goal_id",
			);
		}

		if (update.knowledge_states) {
			const stamped = update.knowledge_states.map((state) => ({
				...state,
				origin: "manual" as const,
				provenance_unknown: state.evidence_ids.length === 0 ? true : state.provenance_unknown,
			}));
			profile.knowledge_states = mergeById<KnowledgeState>(profile.knowledge_states, stamped, "concept_id");
		}

		if (update.misconceptions) {
			profile.misconceptions = mergeById<Misconception>(
				profile.misconceptions,
				update.misconceptions.map((item) => markMisconceptionManual(profile, item)),
				"misconception_id",
			);
		}

		if (update.preferences) {
			const fields = PREFERENCE_FIELDS.filter((field) => update.preferences?.[field] !== undefined);
			profile.preferences = markPreferencesManual(
				profile,
				{ ...profile.preferences, ...update.preferences },
				fields,
			);
		}

		if (update.profile_summary !== undefined) {
			profile.profile_summary = update.profile_summary;
		}
		return true;
	});
}

export async function patchProfile(dataDir: string, patch: ProfilePatch): Promise<LearnerProfile> {
	return mutateProfile(dataDir, (profile) => {
		if (patch.concept_id) {
			let state = profile.knowledge_states.find((ks) => ks.concept_id === patch.concept_id);
			if (!state) {
				state = {
					concept_id: patch.concept_id,
					concept_name: patch.concept_name ?? patch.concept_id,
					domain: patch.domain ?? "general",
					mastery: 0.05,
					confidence: 0.35,
					stability: 0.1,
					evidence_ids: [],
					diagnosis: "有学习接触记录，尚未形成稳定掌握度判断。",
					next_actions: [],
					origin: "manual",
					provenance_unknown: true,
				};
				profile.knowledge_states.push(state);
			}

			if (patch.concept_name) state.concept_name = patch.concept_name;
			if (patch.domain) state.domain = patch.domain;
			if (typeof patch.mastery === "number") state.mastery = clamp01(patch.mastery);
			if (typeof patch.mastery_delta === "number") state.mastery = clamp01(state.mastery + patch.mastery_delta);
			if (typeof patch.confidence === "number") state.confidence = clamp01(patch.confidence);
			if (typeof patch.stability_delta === "number") state.stability = clamp01(state.stability + patch.stability_delta);
			if (patch.diagnosis) state.diagnosis = patch.diagnosis;
			if (patch.next_actions_append) {
				state.next_actions = uniqueStrings([...state.next_actions, ...patch.next_actions_append]).slice(0, 8);
			}
			if (patch.evidence_ids_append) {
				state.evidence_ids = uniqueStrings([...state.evidence_ids, ...patch.evidence_ids_append]);
			}
			if (patch.last_practiced_at) state.last_practiced_at = patch.last_practiced_at;
			if (patch.review_due_at) state.review_due_at = patch.review_due_at;
			state.origin = "manual";
			if (state.evidence_ids.length === 0) state.provenance_unknown = true;
		}

		if (patch.preferences_append) {
			const fields = PREFERENCE_FIELDS.filter((field) => patch.preferences_append?.[field] !== undefined);
			profile.preferences = markPreferencesManual(
				profile,
				{
					explanation_style: uniqueStrings([
						...profile.preferences.explanation_style,
						...(patch.preferences_append.explanation_style ?? []),
					]),
					practice_style: uniqueStrings([
						...profile.preferences.practice_style,
						...(patch.preferences_append.practice_style ?? []),
					]),
					feedback_tone: uniqueStrings([
						...profile.preferences.feedback_tone,
						...(patch.preferences_append.feedback_tone ?? []),
					]),
					avoid: uniqueStrings([...profile.preferences.avoid, ...(patch.preferences_append.avoid ?? [])]),
				},
				fields,
			);
		}

		if (patch.profile_summary_append?.trim()) {
			const lines = [
				...profile.profile_summary.split("\n").filter(Boolean),
				patch.profile_summary_append.trim(),
			];
			profile.profile_summary = lines.slice(Math.max(0, lines.length - 10)).join("\n");
		}
		return true;
	});
}
