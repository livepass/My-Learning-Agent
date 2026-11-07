import { describe, expect, it } from "vitest";
import { buildPlanSuggestions, type PlanAdjustmentContext } from "./plan-adjustments.js";
import type { LearningTask, StudyPlan } from "./types.js";
import type { KnowledgeState } from "../memory/learner/types.js";
import type { PrerequisiteEdge } from "../memory/learner/prerequisite-resolver.js";

/**
 * E4.3e unit contract: suggestions cite stored facts, never chat history or a
 * model's opinion; untrusted states produce nothing; applying is not part of
 * this module.
 */

const asOf = new Date("2026-11-07T09:00:00.000Z");

function plan(): StudyPlan {
	return {
		plan_id: "plan_python",
		course_id: "course_python",
		title: "装饰器计划",
		description: "",
		goal_id: null,
		status: "active",
		origin: "user",
		revision: 3,
		daily_minutes: 45,
		created_at: "2026-11-01T00:00:00.000Z",
		updated_at: "2026-11-02T00:00:00.000Z",
	};
}

function task(id: string, order: number, conceptIds: string[], overrides: Partial<LearningTask> = {}): LearningTask {
	return {
		task_id: id,
		course_id: "course_python",
		plan_id: "plan_python",
		stage_id: null,
		title: id,
		order,
		estimated_minutes: 20,
		difficulty: "standard",
		concept_ids: conceptIds,
		source_ids: [],
		status: "pending",
		created_at: `2026-11-0${order + 1}T00:00:00.000Z`,
		updated_at: `2026-11-0${order + 1}T00:00:00.000Z`,
		...overrides,
	};
}

function state(conceptId: string, overrides: Partial<KnowledgeState> = {}): KnowledgeState {
	return {
		concept_id: conceptId,
		concept_name: conceptId.replace("concept_", ""),
		domain: "python",
		course_id: "course_python",
		mastery: 0.4,
		confidence: 0.7,
		stability: 0.4,
		evidence_ids: ["ev_1", "ev_2"],
		diagnosis: "",
		next_actions: [],
		origin: "derived",
		state_label: "fragile",
		...overrides,
	};
}

function context(overrides: Partial<PlanAdjustmentContext> = {}): PlanAdjustmentContext {
	return {
		plan: plan(),
		stages: [],
		tasks: [task("t1", 0, ["concept_closure"]), task("t2", 1, ["concept_decorator"])],
		knowledge_states: [],
		misconceptions: [],
		edgesFor: () => [],
		asOf,
		dailyMinutes: 45,
		...overrides,
	};
}

describe("buildPlanSuggestions", () => {
	it("suggests a review before a task whose concept is due, citing evidence", () => {
		const suggestions = buildPlanSuggestions(context({
			knowledge_states: [state("concept_closure", {
				state_label: "review_due",
				review_due_at: "2026-11-01T00:00:00.000Z",
			})],
		}));
		const review = suggestions.find((item) => item.type === "review_prerequisite");
		expect(review).toMatchObject({
			type: "review_prerequisite",
			reason_code: "review_due",
			task_id: "t1",
			concept_id: "concept_closure",
			estimated_minutes: 10,
			requires_confirmation: true,
			evidence: { evidence_count: 2, review_due_at: "2026-11-01T00:00:00.000Z" },
		});
		expect(review?.suggestion_id).toMatch(/^sug_[0-9a-f]{16}$/);
	});

	it("suggests practice for an active misconception, not for an untrusted state", () => {
		const misconceptionSuggestion = buildPlanSuggestions(context({
			knowledge_states: [state("concept_closure")],
			misconceptions: [{
				misconception_id: "mis_1",
				concept_id: "concept_closure",
				description: "把装饰器当成语法糖",
				status: "active",
				severity: 0.8,
				confidence: 0.7,
				first_seen_at: "2026-11-01T00:00:00.000Z",
				last_seen_at: "2026-11-05T00:00:00.000Z",
				evidence_ids: ["ev_1"],
				repair_strategy: "",
			}],
		}));
		expect(misconceptionSuggestion.find((item) => item.reason_code === "active_misconception")).toMatchObject({
			type: "add_practice",
			concept_id: "concept_closure",
			estimated_minutes: 20,
		});

		const legacy = buildPlanSuggestions(context({
			knowledge_states: [state("concept_closure", { origin: "legacy", provenance_unknown: true })],
		}));
		expect(legacy).toEqual([]);
	});

	it("reorders an existing prerequisite task that sits after its dependent task", () => {
		const edges: PrerequisiteEdge[] = [{
			target_concept_id: "concept_decorator",
			prerequisite_concept_id: "concept_closure",
			relation: "required",
			required_level: 0.8,
			importance: 0.9,
			source: "curated",
			source_confidence: 0.9,
			rationale: "装饰器需要闭包",
		}];
		const suggestions = buildPlanSuggestions(context({
			tasks: [task("t1", 0, ["concept_decorator"]), task("t2", 1, ["concept_closure"])],
			knowledge_states: [
				state("concept_decorator", { mastery: 0.3, state_label: "learning" }),
				state("concept_closure", { mastery: 0.2, state_label: "fragile" }),
			],
			edgesFor: (conceptId) => (conceptId === "concept_decorator" ? edges : []),
		}));
		expect(suggestions.find((item) => item.type === "reorder_task")).toMatchObject({
			reason_code: "prerequisite_gap",
			task_id: "t2",
			before_task_id: "t1",
			concept_id: "concept_closure",
		});
	});

	it("suggests lowering difficulty for a task that exceeds the daily budget", () => {
		const suggestions = buildPlanSuggestions(context({
			tasks: [task("t1", 0, ["concept_closure"], { estimated_minutes: 150, difficulty: "challenge" })],
		}));
		expect(suggestions.find((item) => item.type === "adjust_difficulty")).toMatchObject({
			reason_code: "task_too_long",
			task_id: "t1",
			difficulty: "standard",
		});
	});

	it("suggests raising difficulty only from stable evidence", () => {
		const suggestions = buildPlanSuggestions(context({
			knowledge_states: [state("concept_closure", {
				state_label: "stable",
				evidence_ids: ["a", "b", "c"],
				mastery: 0.9,
			})],
			tasks: [task("t1", 0, ["concept_closure"], { difficulty: "basic" })],
		}));
		expect(suggestions.find((item) => item.type === "adjust_difficulty")).toMatchObject({
			reason_code: "stable_ready_for_challenge",
			difficulty: "standard",
		});
	});

	it("suggests deferring the last task when the deadline cannot fit the remaining work", () => {
		const planValue = plan();
		planValue.target_date = "2026-11-08";
		const suggestions = buildPlanSuggestions(context({
			plan: planValue,
			tasks: [
				task("t1", 0, [], { estimated_minutes: 60 }),
				task("t2", 1, [], { estimated_minutes: 60 }),
				task("t3", 2, [], { estimated_minutes: 60 }),
			],
		}));
		expect(suggestions.find((item) => item.type === "defer_task")).toMatchObject({
			reason_code: "plan_overloaded",
			task_id: "t1",
		});

		// The only task is already last: deferring it would change nothing, so
		// the suggestion engine must not offer it at all.
		const single = buildPlanSuggestions(context({
			plan: planValue,
			tasks: [task("only", 0, [], { estimated_minutes: 600 })],
		}));
		expect(single.some((item) => item.type === "defer_task")).toBe(false);
	});

	it("returns nothing for an invalid clock instead of guessing now", () => {
		expect(buildPlanSuggestions(context({ asOf: new Date(Number.NaN) }))).toEqual([]);
	});
});
