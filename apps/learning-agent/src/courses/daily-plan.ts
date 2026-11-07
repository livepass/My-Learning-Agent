import { looksLikeSyntheticConceptLabel } from "../shared/concept-id.js";
import type {
	Course,
	CourseStudySettings,
	LearningTask,
	PlanStage,
	StudyPlan,
} from "./types.js";
import type { KnowledgeState, Misconception } from "../memory/learner/types.js";

/**
 * E4.3d — recomputable daily recommendations.
 *
 * Deterministic and read-only on purpose:
 *
 * - no model, no clock of its own (`asOf` is passed), no disk;
 * - tasks and knowledge are reported separately; nothing here can mark a task
 *   complete or move an L1 mastery value;
 * - a review is recommended only when a stored state has traceable evidence
 *   and a due timestamp that has actually passed. A due date without evidence
 *   is a leftover, not a reason to spend the learner's time;
 * - courses are computed independently and concatenated. A task from Python is
 *   never scheduled inside the 高等数学 budget.
 *
 * The output is advice: the learner can skip an item, pick another task, or
 * change the plan. No task is created for a recommendation.
 */

export const DEFAULT_DAILY_MINUTES = 30;
export const DEFAULT_TASK_MINUTES = 25;
export const DEFAULT_REVIEW_MINUTES = 10;
export const MAX_REVIEWS_PER_COURSE = 2;
export const REVIEW_BUDGET_SHARE = 0.4;

export type DailyItemReason =
	| "review_due"
	| "in_progress"
	| "next_task"
	| "over_budget";

export interface DailyTaskItem {
	kind: "task";
	task_id: string;
	title: string;
	status: LearningTask["status"];
	order: number;
	stage_id: string | null;
	stage_title?: string;
	estimated_minutes: number;
	difficulty: LearningTask["difficulty"];
	concept_ids: string[];
	source_ids: string[];
	reason_code: Exclude<DailyItemReason, "review_due">;
	reason: string;
}

export interface DailyReviewItem {
	kind: "review";
	concept_id: string;
	concept_name?: string;
	name_available: boolean;
	state_label?: KnowledgeState["state_label"];
	review_due_at: string;
	evidence_count: number;
	estimated_minutes: number;
	reason_code: "review_due";
	reason: string;
}

export type DailyPlanItem = DailyTaskItem | DailyReviewItem;

export type DailyCourseStatus = "ok" | "no_active_plan" | "empty_plan" | "all_completed";

export interface CourseDailyPlan {
	course_id: string;
	course_title: string;
	status: DailyCourseStatus;
	/** Daily budget actually used for this course. */
	daily_minutes: number;
	plan: { plan_id: string; title: string; revision: number } | null;
	/** Other active plans are reported, never merged or silently picked. */
	other_active_plans: number;
	items: DailyPlanItem[];
	planned_minutes: number;
	/** Task progress and knowledge state are deliberately separate. */
	task_progress: {
		total: number;
		completed: number;
		in_progress: number;
		percent: number;
	};
	knowledge: {
		due_reviews: number;
		weak_concepts: number;
		stable_concepts: number;
		evidence_backed_concepts: number;
	};
	notes: string[];
}

export interface DailyPlanSnapshot {
	as_of: string;
	generated_at: string;
	/** Requested override, echoed; null means each course used its own setting. */
	minutes_override: number | null;
	courses: CourseDailyPlan[];
	total_planned_minutes: number;
}

export interface DailyPlanCourseInput {
	course: Course;
	plans: readonly StudyPlan[];
	stages: readonly PlanStage[];
	tasks: readonly LearningTask[];
	settings?: CourseStudySettings;
	/** Course-scoped L1 states only; the caller must not pass another course's. */
	knowledge_states: readonly KnowledgeState[];
	misconceptions?: readonly Misconception[];
}

export interface DailyPlanOptions {
	asOf: Date;
	/** Per-course override. Omitted = each course's stored budget. */
	minutes?: number;
}

function trustedName(state: KnowledgeState): string | undefined {
	const name = typeof state.concept_name === "string" ? state.concept_name.trim() : "";
	if (!name || name === state.concept_id || looksLikeSyntheticConceptLabel(name)) return undefined;
	return name;
}

function evidenceCount(state: KnowledgeState): number {
	return Array.isArray(state.evidence_ids)
		? state.evidence_ids.filter((id) => typeof id === "string" && id.trim().length > 0).length
		: 0;
}

/** Only a derived state with evidence can justify a review slot. */
function reviewable(state: KnowledgeState, asOf: number): boolean {
	if (evidenceCount(state) === 0) return false;
	if (state.origin !== "derived" || state.provenance_unknown === true) return false;
	const due = typeof state.review_due_at === "string" ? Date.parse(state.review_due_at) : Number.NaN;
	return Number.isFinite(due) && due <= asOf;
}

function activePlanOf(plans: readonly StudyPlan[]): StudyPlan | undefined {
	const active = plans.filter((plan) => plan.status === "active");
	if (active.length === 0) return undefined;
	return [...active].sort((a, b) => b.updated_at.localeCompare(a.updated_at)
		|| b.created_at.localeCompare(a.created_at))[0];
}

function clampBudget(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DAILY_MINUTES;
	return Math.min(Math.max(Math.round(value), 5), 720);
}

function taskItems(
	tasks: readonly LearningTask[],
	stages: readonly PlanStage[],
	budget: number,
	reviewMinutes: number,
): { items: DailyTaskItem[]; planned: number } {
	const stageById = new Map(stages.map((stage) => [stage.stage_id, stage]));
	const ordered = [...tasks]
		.filter((task) => task.status !== "completed")
		.sort((a, b) => {
			if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
			return (a.order - b.order) || a.created_at.localeCompare(b.created_at);
		});
	const items: DailyTaskItem[] = [];
	let planned = 0;
	let taskIndex = 0;
	const available = Math.max(budget - reviewMinutes, 0);
	for (const task of ordered) {
		const minutes = typeof task.estimated_minutes === "number" && task.estimated_minutes > 0
			? task.estimated_minutes
			: DEFAULT_TASK_MINUTES;
		const isFirst = taskIndex === 0;
		if (!isFirst && planned + minutes > available) {
			taskIndex += 1;
			continue;
		}
		const overBudget = planned + minutes > available;
		const stage = task.stage_id ? stageById.get(task.stage_id) : undefined;
		items.push({
			kind: "task",
			task_id: task.task_id,
			title: task.title,
			status: task.status,
			order: task.order,
			stage_id: task.stage_id,
			...(stage ? { stage_title: stage.title } : {}),
			estimated_minutes: minutes,
			difficulty: task.difficulty,
			concept_ids: [...task.concept_ids],
			source_ids: [...task.source_ids],
			reason_code: overBudget ? "over_budget" : task.status === "in_progress" ? "in_progress" : "next_task",
			reason: overBudget
				? "按计划顺序排在最前，但单个任务超出今日剩余时间，可拆开完成或调整安排。"
				: task.status === "in_progress"
					? "这个任务已经开始但尚未完成，优先继续。"
					: "按当前计划顺序，这是接下来未完成的任务。",
		});
		planned += minutes;
		taskIndex += 1;
	}
	return { items, planned };
}

function reviewItems(
	states: readonly KnowledgeState[],
	budget: number,
	asOf: number,
	/** Concepts already covered by a pending review task in the active plan. */
	coveredConcepts: ReadonlySet<string> = new Set(),
): { items: DailyReviewItem[]; planned: number } {
	const due = states
		.filter((state) => reviewable(state, asOf))
		.filter((state) => !coveredConcepts.has(state.concept_id))
		.sort((a, b) => (a.review_due_at ?? "").localeCompare(b.review_due_at ?? ""));
	const cap = Math.min(MAX_REVIEWS_PER_COURSE, Math.floor(budget * REVIEW_BUDGET_SHARE / DEFAULT_REVIEW_MINUTES));
	const items: DailyReviewItem[] = [];
	for (const state of due.slice(0, Math.max(cap, 0))) {
		const name = trustedName(state);
		items.push({
			kind: "review",
			concept_id: state.concept_id,
			...(name ? { concept_name: name } : {}),
			name_available: Boolean(name),
			...(state.state_label ? { state_label: state.state_label } : {}),
			review_due_at: state.review_due_at!,
			evidence_count: evidenceCount(state),
			estimated_minutes: DEFAULT_REVIEW_MINUTES,
			reason_code: "review_due",
			reason: "L1 中存在有正式证据支持、且已到期的复习记录，建议先用一次检索确认是否还记得。",
		});
	}
	return { items, planned: items.length * DEFAULT_REVIEW_MINUTES };
}

function buildCoursePlan(input: DailyPlanCourseInput, minutesOverride: number | undefined, asOf: Date): CourseDailyPlan {
	const budget = clampBudget(minutesOverride ?? input.settings?.daily_minutes ?? DEFAULT_DAILY_MINUTES);
	const active = activePlanOf(input.plans);
	const states = input.knowledge_states;
	const misconceptionConcepts = new Set((input.misconceptions ?? [])
		.filter((item) => item.status === "active")
		.map((item) => item.concept_id));
	const rawKnowledge = {
		due_reviews: states.filter((state) => reviewable(state, asOf.getTime())).length,
		weak_concepts: states.filter((state) => state.state_label === "fragile"
			|| state.state_label === "learning"
			|| state.state_label === "misconception"
			|| misconceptionConcepts.has(state.concept_id)).length,
		stable_concepts: states.filter((state) => state.state_label === "stable").length,
		evidence_backed_concepts: states.filter((state) => evidenceCount(state) > 0).length,
	};
	if (!active) {
		const reviews = reviewItems(states, budget, asOf.getTime());
		return {
			course_id: input.course.course_id,
			course_title: input.course.title,
			status: "no_active_plan",
			daily_minutes: budget,
			plan: null,
			other_active_plans: 0,
			items: reviews.items,
			planned_minutes: reviews.planned,
			task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 },
			knowledge: rawKnowledge,
			notes: [
				"这门课程还没有启用中的学习计划；可以先手动制定计划，或让 AI 生成草稿后确认。",
				"任务进度与知识掌握是两套状态：完成推荐任务不会自动提高 L1 掌握度。",
			],
		};
	}

	const planTasks = input.tasks.filter((task) => task.plan_id === active.plan_id);
	const completed = planTasks.filter((task) => task.status === "completed").length;
	const inProgress = planTasks.filter((task) => task.status === "in_progress").length;
	const reviews = reviewItems(
		states,
		budget,
		asOf.getTime(),
		new Set(planTasks
			.filter((task) => task.status !== "completed" && task.title.startsWith("复习："))
			.flatMap((task) => task.concept_ids)),
	);
	const tasks = taskItems(planTasks, input.stages.filter((stage) => stage.plan_id === active.plan_id),
		budget, reviews.planned);
	const items = [...reviews.items, ...tasks.items];
	const others = input.plans.filter((plan) => plan.status === "active" && plan.plan_id !== active.plan_id).length;
	const status: DailyCourseStatus = planTasks.length === 0
		? "empty_plan"
		: completed === planTasks.length ? "all_completed" : "ok";
	return {
		course_id: input.course.course_id,
		course_title: input.course.title,
		status,
		daily_minutes: budget,
		plan: { plan_id: active.plan_id, title: active.title, revision: active.revision },
		other_active_plans: others,
		items,
		planned_minutes: reviews.planned + tasks.planned,
		task_progress: {
			total: planTasks.length,
			completed,
			in_progress: inProgress,
			percent: planTasks.length === 0 ? 0 : Math.round((completed / planTasks.length) * 100),
		},
		knowledge: rawKnowledge,
		notes: [
			"推荐是可重新计算的建议，不会创建任务、不会自动标记完成，也不会改变 L1 掌握度。",
			...(others > 0 ? [`该课程还有 ${others} 个启用中的计划，本次只按最近更新的「${active.title}」推荐。`] : []),
			...(status === "all_completed" ? ["当前计划的任务都已完成；仍然到期的是知识复习，不是未完成任务。"] : []),
		],
	};
}

/**
 * Build one snapshot for all requested courses. Inputs are already scoped by
 * the caller, so this function has no way to read another course's data.
 */
export function buildDailyPlans(
	courses: readonly DailyPlanCourseInput[],
	options: DailyPlanOptions,
): DailyPlanSnapshot {
	const asOf = options.asOf instanceof Date && Number.isFinite(options.asOf.getTime())
		? options.asOf
		: new Date(Number.NaN);
	const valid = Number.isFinite(asOf.getTime());
	const generatedAt = valid ? asOf.toISOString() : new Date(0).toISOString();
	const plans = valid
		? courses.map((course) => buildCoursePlan(course, options.minutes, asOf))
		: [];
	return {
		as_of: generatedAt,
		generated_at: generatedAt,
		minutes_override: options.minutes ?? null,
		courses: plans,
		total_planned_minutes: plans.reduce((sum, course) => sum + course.planned_minutes, 0),
	};
}
