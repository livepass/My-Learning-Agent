import { createHash } from "node:crypto";
import { looksLikeSyntheticConceptLabel } from "../shared/concept-id.js";
import {
	resolvePrerequisites,
	type PrerequisiteEdge,
} from "../memory/learner/prerequisite-resolver.js";
import type {
	DerivedKnowledgeState,
	KnowledgeState,
	Misconception,
} from "../memory/learner/types.js";
import type {
	LearningTask,
	PlanAdjustmentType,
	PlanStage,
	StudyPlan,
	TaskDifficulty,
} from "./types.js";

/**
 * E4.3e — explainable plan adjustments.
 *
 * A suggestion is computed from stored facts only:
 *   - an L1 knowledge state that is `derived`, has evidence ids and a label;
 *   - an active misconception;
 *   - an explicit prerequisite edge plus the prerequisite's own state.
 *
 * Chat history, model output and AI self-assessment are not inputs. The module
 * cannot write: it returns suggestions, and the store applies exactly one of
 * them after the learner confirms it, under a plan-revision compare-and-swap.
 */

export const MAX_SUGGESTIONS = 8;
const DEFAULT_TASK_MINUTES = 25;

export type SuggestionReasonCode =
	| "review_due"
	| "active_misconception"
	| "fragile_evidence"
	| "prerequisite_gap"
	| "task_too_long"
	| "plan_overloaded"
	| "stable_ready_for_challenge";

export interface PlanSuggestion {
	suggestion_id: string;
	type: PlanAdjustmentType;
	title: string;
	reason: string;
	reason_code: SuggestionReasonCode;
	task_id?: string;
	task_title?: string;
	/** For `reorder_task`. */
	before_task_id?: string;
	concept_id?: string;
	concept_label?: string;
	difficulty?: TaskDifficulty;
	estimated_minutes?: number;
	evidence: {
		concept_id?: string;
		state_label?: KnowledgeState["state_label"];
		review_due_at?: string;
		evidence_count: number;
		mastery?: number;
		misconception_ids?: string[];
		prerequisite_concept_id?: string;
	};
	/** Always true: this endpoint never writes. */
	requires_confirmation: true;
	changes: string;
}

export interface PlanAdjustmentContext {
	plan: StudyPlan;
	stages: readonly PlanStage[];
	tasks: readonly LearningTask[];
	/** Course-scoped states only. */
	knowledge_states: readonly KnowledgeState[];
	misconceptions: readonly Misconception[];
	/** Explicit prerequisite edges for one concept, from L2 concept pages. */
	edgesFor: (conceptId: string) => readonly PrerequisiteEdge[];
	asOf: Date;
	/** Daily budget used to judge whether a task is too long. */
	dailyMinutes?: number;
}

interface Candidate {
	suggestion: PlanSuggestion;
	priority: number;
}

function evidenceCount(state: KnowledgeState): number {
	return Array.isArray(state.evidence_ids)
		? state.evidence_ids.filter((id) => typeof id === "string" && id.trim().length > 0).length
		: 0;
}

function trustedName(state: KnowledgeState): string | undefined {
	const name = typeof state.concept_name === "string" ? state.concept_name.trim() : "";
	if (!name || name === state.concept_id || looksLikeSyntheticConceptLabel(name)) return undefined;
	return name;
}

/** Only derived states with evidence may justify an adjustment. */
function trustable(state: KnowledgeState | undefined): state is KnowledgeState {
	return Boolean(state) && state!.origin === "derived" && state!.provenance_unknown !== true
		&& evidenceCount(state!) > 0;
}

function toDerived(state: KnowledgeState, misconceptionIds: string[]): DerivedKnowledgeState {
	return {
		concept_id: state.concept_id,
		concept_name: state.concept_name,
		domain: state.domain,
		...(state.course_id ? { course_id: state.course_id } : {}),
		mastery: state.mastery,
		estimate_confidence: state.estimate_confidence ?? state.confidence ?? 0,
		stability_days: state.stability_days ?? 0,
		...(state.retrievability !== undefined ? { retrievability: state.retrievability } : {}),
		...(state.last_evidence_at ? { last_evidence_at: state.last_evidence_at } : {}),
		...(state.last_successful_retrieval_at ? { last_successful_retrieval_at: state.last_successful_retrieval_at } : {}),
		...(state.last_result ? { last_result: state.last_result } : {}),
		...(state.review_due_at ? { next_review_at: state.review_due_at } : {}),
		exposure_count: state.exposure_count ?? 0,
		retrieval_count: state.retrieval_count ?? 0,
		lapse_count: state.lapse_count ?? 0,
		successful_transfer_count: state.successful_transfer_count ?? 0,
		active_misconception_ids: misconceptionIds,
		evidence_ids: [...state.evidence_ids],
		state_label: state.state_label ?? "unknown",
		diagnosis: state.diagnosis ?? "",
		next_actions: [...(state.next_actions ?? [])],
	};
}

function suggestionId(plan: StudyPlan, type: string, target: string): string {
	const digest = createHash("sha256")
		.update(`${plan.plan_id}\u0000${plan.revision}\u0000${type}\u0000${target}`)
		.digest("hex")
		.slice(0, 16);
	return `sug_${digest}`;
}

export function buildPlanSuggestions(context: PlanAdjustmentContext): PlanSuggestion[] {
	if (!(context.asOf instanceof Date) || !Number.isFinite(context.asOf.getTime())) return [];
	const asOf = context.asOf.getTime();
	const states = new Map(context.knowledge_states.map((state) => [state.concept_id, state]));
	const activeMisconceptions = context.misconceptions.filter((item) => item.status === "active");
	const misconceptionByConcept = new Map<string, Misconception[]>();
	for (const item of activeMisconceptions) {
		const list = misconceptionByConcept.get(item.concept_id) ?? [];
		list.push(item);
		misconceptionByConcept.set(item.concept_id, list);
	}
	const tasks = [...context.tasks].sort((a, b) => (a.order - b.order) || a.created_at.localeCompare(b.created_at));
	const pending = tasks.filter((task) => task.status !== "completed");
	const taskByConcept = new Map<string, LearningTask[]>();
	for (const task of tasks) {
		for (const conceptId of task.concept_ids) {
			const list = taskByConcept.get(conceptId) ?? [];
			list.push(task);
			taskByConcept.set(conceptId, list);
		}
	}
	const derivedStates = context.knowledge_states.map((state) => toDerived(
		state,
		(misconceptionByConcept.get(state.concept_id) ?? []).map((item) => item.misconception_id),
	));

	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	const hasSupportTask = (conceptId: string, prefix: string): boolean =>
		(taskByConcept.get(conceptId) ?? []).some((task) => task.status !== "completed"
			&& task.title.startsWith(prefix));
	const push = (candidate: Candidate): void => {
		const key = `${candidate.suggestion.type}:${candidate.suggestion.concept_id ?? candidate.suggestion.task_id ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};

	for (const task of pending) {
		for (const conceptId of task.concept_ids) {
			const state = states.get(conceptId);
			if (!state) continue;
			const label = trustedName(state);
			const misconceptionIds = (misconceptionByConcept.get(conceptId) ?? []).map((item) => item.misconception_id);
			const dueAt = typeof state.review_due_at === "string" ? Date.parse(state.review_due_at) : Number.NaN;

			if (trustable(state) && Number.isFinite(dueAt) && dueAt <= asOf) {
				if (hasSupportTask(conceptId, "复习：")) continue;
				const conceptLabel = label ?? "待确认知识点";
				push({
					priority: 0,
					suggestion: {
						suggestion_id: suggestionId(context.plan, "review_prerequisite", `${task.task_id}:${conceptId}`),
						type: "review_prerequisite",
						title: `先复习「${conceptLabel}」`,
						reason: `L1 记录显示这个知识点已到复习期（${state.review_due_at!.slice(0, 10)}），且已有 ${evidenceCount(state)} 条正式证据；在继续新任务前先做一次短复习更稳妥。`,
						reason_code: "review_due",
						task_id: task.task_id,
						task_title: task.title,
						concept_id: conceptId,
						...(label ? { concept_label: label } : {}),
						estimated_minutes: 10,
						evidence: {
							concept_id: conceptId,
							...(state.state_label ? { state_label: state.state_label } : {}),
							review_due_at: state.review_due_at,
							evidence_count: evidenceCount(state),
							mastery: state.mastery,
						},
						requires_confirmation: true,
						changes: `在「${task.title}」之前新增一个 10 分钟复习任务`,
					},
				});
				continue;
			}

			if (misconceptionIds.length > 0) {
				if (hasSupportTask(conceptId, "练习：")) continue;
				const conceptLabel = label ?? "待确认知识点";
				push({
					priority: 1,
					suggestion: {
						suggestion_id: suggestionId(context.plan, "add_practice", `${task.task_id}:${conceptId}`),
						type: "add_practice",
						title: `补一组「${conceptLabel}」练习`,
						reason: `L1 中有 ${misconceptionIds.length} 条仍在活跃的误区记录，先做针对性练习比继续推进更有效。`,
						reason_code: "active_misconception",
						task_id: task.task_id,
						task_title: task.title,
						concept_id: conceptId,
						...(label ? { concept_label: label } : {}),
						estimated_minutes: 20,
						evidence: {
							concept_id: conceptId,
							...(state.state_label ? { state_label: state.state_label } : {}),
							evidence_count: evidenceCount(state),
							mastery: state.mastery,
							misconception_ids: misconceptionIds,
						},
						requires_confirmation: true,
						changes: `在「${task.title}」之前新增一个 20 分钟练习任务`,
					},
				});
				continue;
			}

			if (trustable(state) && state.state_label === "fragile") {
				if (hasSupportTask(conceptId, "练习：")) continue;
				const conceptLabel = label ?? "待确认知识点";
				push({
					priority: 3,
					suggestion: {
						suggestion_id: suggestionId(context.plan, "add_practice", `${task.task_id}:${conceptId}`),
						type: "add_practice",
						title: `加强「${conceptLabel}」练习`,
						reason: "最近的证据显示这个知识点还不稳定（fragile），在进入后续任务前补一组变式练习更合适。",
						reason_code: "fragile_evidence",
						task_id: task.task_id,
						task_title: task.title,
						concept_id: conceptId,
						...(label ? { concept_label: label } : {}),
						estimated_minutes: 20,
						evidence: {
							concept_id: conceptId,
							state_label: state.state_label,
							evidence_count: evidenceCount(state),
							mastery: state.mastery,
						},
						requires_confirmation: true,
						changes: `在「${task.title}」之前新增一个 20 分钟练习任务`,
					},
				});
				continue;
			}

			// Explicit prerequisite edges, resolved against the same evidence.
			const edges = context.edgesFor(conceptId);
			if (edges.length === 0) continue;
			const resolution = resolvePrerequisites(conceptId, [...edges], derivedStates, { isAtomic: false });
			if (resolution.action === "proceed" || resolution.action === "direct") continue;
			const blocking = resolution.assessments.find((item) => item.status !== "satisfied");
			if (!blocking) continue;
			const prerequisiteId = blocking.prerequisite_concept_id;
			const existing = (taskByConcept.get(prerequisiteId) ?? []).find((candidate) => candidate.status !== "completed");
			const prerequisiteState = states.get(prerequisiteId);
			const prerequisiteName = prerequisiteState ? trustedName(prerequisiteState) : undefined;
			const prerequisiteLabel = prerequisiteName ?? "前置知识点";
			if (existing && existing.task_id !== task.task_id && existing.order > task.order) {
				const before = existing;
				push({
					priority: 2,
					suggestion: {
						suggestion_id: suggestionId(context.plan, "reorder_task", `${before.task_id}->${task.task_id}`),
						type: "reorder_task",
						title: `先完成前置「${prerequisiteLabel}」`,
						reason: `L1/L2 的前置关系显示「${prerequisiteLabel}」是当前任务的必要前置，而它在计划中的位置更靠后（${blocking.reason}）。`,
						reason_code: "prerequisite_gap",
						task_id: before.task_id,
						task_title: before.title,
						before_task_id: task.task_id,
						concept_id: prerequisiteId,
						...(prerequisiteName ? { concept_label: prerequisiteName } : {}),
						evidence: {
							concept_id: prerequisiteId,
							...(prerequisiteState?.state_label ? { state_label: prerequisiteState.state_label } : {}),
							evidence_count: prerequisiteState ? evidenceCount(prerequisiteState) : 0,
							...(prerequisiteState ? { mastery: prerequisiteState.mastery } : {}),
							prerequisite_concept_id: conceptId,
						},
						requires_confirmation: true,
						changes: `把「${before.title}」调整到「${task.title}」之前`,
					},
				});
			} else if (!existing) {
				if (hasSupportTask(prerequisiteId, "复习：")) continue;
				push({
					priority: 2,
					suggestion: {
						suggestion_id: suggestionId(context.plan, "review_prerequisite", `${task.task_id}:${prerequisiteId}`),
						type: "review_prerequisite",
						title: `补充前置「${prerequisiteLabel}」`,
						reason: `L2 概念页声明「${prerequisiteLabel}」是当前任务的必要前置，但计划里没有对应任务（${blocking.reason}）。`,
						reason_code: "prerequisite_gap",
						task_id: task.task_id,
						concept_id: prerequisiteId,
						...(prerequisiteName ? { concept_label: prerequisiteName } : {}),
						estimated_minutes: 15,
						evidence: {
							concept_id: prerequisiteId,
							...(prerequisiteState?.state_label ? { state_label: prerequisiteState.state_label } : {}),
							evidence_count: prerequisiteState ? evidenceCount(prerequisiteState) : 0,
							...(prerequisiteState ? { mastery: prerequisiteState.mastery } : {}),
							prerequisite_concept_id: conceptId,
						},
						requires_confirmation: true,
						changes: `在「${task.title}」之前新增一个 15 分钟前置复习任务`,
					},
				});
			}
		}

		const minutes = task.estimated_minutes ?? 0;
		const budget = context.dailyMinutes ?? 30;
		if (minutes > Math.max(90, budget) && task.difficulty !== "basic") {
			push({
				priority: 4,
				suggestion: {
					suggestion_id: suggestionId(context.plan, "adjust_difficulty", task.task_id),
					type: "adjust_difficulty",
					title: `降低「${task.title}」的难度`,
					reason: `这个任务预计 ${minutes} 分钟，明显超过每日可用时间（${budget} 分钟）；先按更基础的版本完成，比搁置更可行。`,
					reason_code: "task_too_long",
					task_id: task.task_id,
					task_title: task.title,
					difficulty: task.difficulty === "challenge" ? "standard" : "basic",
					estimated_minutes: minutes,
					evidence: { evidence_count: 0 },
					requires_confirmation: true,
					changes: `把任务难度从 ${task.difficulty} 调整为 ${task.difficulty === "challenge" ? "standard" : "basic"}`,
				},
			});
		} else if (task.concept_ids.length > 0) {
			const first = states.get(task.concept_ids[0]);
			if (trustable(first) && first.state_label === "stable" && evidenceCount(first) >= 3
				&& task.difficulty !== "challenge") {
				push({
					priority: 5,
					suggestion: {
						suggestion_id: suggestionId(context.plan, "adjust_difficulty", task.task_id),
						type: "adjust_difficulty",
						title: `提高「${task.title}」的挑战度`,
						reason: `这个知识点已有 ${evidenceCount(first)} 条正式证据且状态稳定；可以把任务换成更具迁移性的版本，但这只是建议。`,
						reason_code: "stable_ready_for_challenge",
						task_id: task.task_id,
						task_title: task.title,
						concept_id: first.concept_id,
						...(trustedName(first) ? { concept_label: trustedName(first) } : {}),
						difficulty: task.difficulty === "basic" ? "standard" : "challenge",
						evidence: {
							concept_id: first.concept_id,
							state_label: first.state_label,
							evidence_count: evidenceCount(first),
							mastery: first.mastery,
						},
						requires_confirmation: true,
						changes: `把任务难度从 ${task.difficulty} 调整为 ${task.difficulty === "basic" ? "standard" : "challenge"}`,
					},
				});
			}
		}
	}

	// Explicit deadline + more remaining work than the remaining days can hold:
	// suggest deferring the last pending task instead of silently letting the
	// plan overrun. The learner still decides.
	if (context.plan.target_date && pending.length > 1) {
		const target = Date.parse(`${context.plan.target_date}T23:59:59.000Z`);
		if (Number.isFinite(target) && target > asOf) {
			const days = Math.max(1, Math.ceil((target - asOf) / 86_400_000));
			const remaining = pending.reduce((sum, task) => sum + (task.estimated_minutes ?? DEFAULT_TASK_MINUTES), 0);
			const capacity = days * (context.dailyMinutes ?? 30);
			if (remaining > capacity) {
				const last = pending[pending.length - 1];
				push({
					priority: 4,
					suggestion: {
						suggestion_id: suggestionId(context.plan, "defer_task", last.task_id),
						type: "defer_task",
						title: `暂缓「${last.title}」`,
						reason: `按每日 ${context.dailyMinutes ?? 30} 分钟计算，剩余 ${days} 天最多完成约 ${capacity} 分钟，而计划还剩 ${remaining} 分钟；先把最后一个任务暂缓，避免计划持续积压。`,
						reason_code: "plan_overloaded",
						task_id: last.task_id,
						task_title: last.title,
						evidence: { evidence_count: 0 },
						requires_confirmation: true,
						changes: `将「${last.title}」移到计划末尾`,
					},
				});
			}
		}
	}

	candidates.sort((a, b) => a.priority - b.priority
		|| (a.suggestion.task_id ?? "").localeCompare(b.suggestion.task_id ?? ""));
	return candidates.slice(0, MAX_SUGGESTIONS).map((candidate) => candidate.suggestion);
}
