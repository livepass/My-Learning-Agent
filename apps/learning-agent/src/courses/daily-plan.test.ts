import { describe, expect, it } from "vitest";
import { buildDailyPlans, type DailyPlanCourseInput } from "./daily-plan.js";
import type { Course, LearningTask, StudyPlan } from "./types.js";
import type { KnowledgeState } from "../memory/learner/types.js";

/**
 * E4.3d unit contract: per-course budgets, real due reviews only, and no
 * mutation of tasks or knowledge. The function is pure, so these tests can
 * assert the inputs are byte-identical afterwards.
 */

const asOf = new Date("2026-11-07T09:00:00.000Z");

function course(id: string, title: string): Course {
	return {
		course_id: id,
		title,
		description: "",
		status: "in_progress",
		created_at: "2026-11-01T00:00:00.000Z",
		updated_at: "2026-11-01T00:00:00.000Z",
	};
}

function plan(id: string, courseId: string): StudyPlan {
	return {
		plan_id: id,
		course_id: courseId,
		title: `${courseId} 计划`,
		description: "",
		goal_id: null,
		status: "active",
		origin: "user",
		revision: 1,
		created_at: "2026-11-01T00:00:00.000Z",
		updated_at: "2026-11-02T00:00:00.000Z",
	};
}

function task(id: string, courseId: string, planId: string, order: number, minutes: number, title = id): LearningTask {
	return {
		task_id: id,
		course_id: courseId,
		plan_id: planId,
		stage_id: null,
		title,
		order,
		estimated_minutes: minutes,
		difficulty: "standard",
		concept_ids: [`concept_${id}`],
		source_ids: [],
		status: "pending",
		created_at: `2026-11-0${order + 1}T00:00:00.000Z`,
		updated_at: `2026-11-0${order + 1}T00:00:00.000Z`,
	};
}

function state(conceptId: string, courseId: string, overrides: Partial<KnowledgeState> = {}): KnowledgeState {
	return {
		concept_id: conceptId,
		concept_name: conceptId.replace("concept_", ""),
		domain: "python",
		course_id: courseId,
		mastery: 0.4,
		confidence: 0.6,
		stability: 0.5,
		evidence_ids: ["ev_1"],
		diagnosis: "",
		next_actions: [],
		origin: "derived",
		state_label: "fragile",
		...overrides,
	};
}

function input(overrides: Partial<DailyPlanCourseInput> = {}): DailyPlanCourseInput {
	const c = course("course_python", "Python 编程");
	const p = plan("plan_python", c.course_id);
	return {
		course: c,
		plans: [p],
		stages: [],
		tasks: [
			task("t1", c.course_id, p.plan_id, 0, 20, "学习装饰器"),
			task("t2", c.course_id, p.plan_id, 1, 30, "完成练习"),
			task("t3", c.course_id, p.plan_id, 2, 40, "总结"),
		],
		settings: { course_id: c.course_id, daily_minutes: 60, updated_at: "2026-11-01T00:00:00.000Z" },
		knowledge_states: [],
		...overrides,
	};
}

describe("buildDailyPlans", () => {
	it("fits tasks into the course budget and never crosses courses", () => {
		const python = input();
		const mathCourse = course("course_math", "高等数学");
		const mathPlan = plan("plan_math", mathCourse.course_id);
		const math = input({
			course: mathCourse,
			plans: [mathPlan],
			tasks: [task("m1", mathCourse.course_id, mathPlan.plan_id, 0, 40, "继续导数章节")],
			settings: { course_id: mathCourse.course_id, daily_minutes: 30, updated_at: "2026-11-01T00:00:00.000Z" },
		});
		const snapshot = buildDailyPlans([python, math], { asOf });
		expect(snapshot.courses).toHaveLength(2);
		const pythonPlan = snapshot.courses[0];
		const mathSnapshot = snapshot.courses[1];
		expect(pythonPlan.daily_minutes).toBe(60);
		expect(pythonPlan.items.map((item) => (item.kind === "task" ? item.task_id : item.concept_id))).toEqual(["t1", "t2"]);
		expect(pythonPlan.planned_minutes).toBe(50);
		expect(mathSnapshot.daily_minutes).toBe(30);
		expect(mathSnapshot.items).toHaveLength(1);
		expect(mathSnapshot.items[0]).toMatchObject({ kind: "task", task_id: "m1", reason_code: "over_budget" });
		expect(snapshot.total_planned_minutes).toBe(90);
	});

	it("recommends a due review only when stored evidence supports it", () => {
		const due = state("concept_closure", "course_python", {
			review_due_at: "2026-11-01T00:00:00.000Z",
			state_label: "review_due",
		});
		const noEvidence = state("concept_decorator", "course_python", {
			evidence_ids: [],
			review_due_at: "2026-11-01T00:00:00.000Z",
		});
		const legacy = state("concept_legacy", "course_python", {
			origin: "legacy",
			review_due_at: "2026-11-01T00:00:00.000Z",
		});
		const snapshot = buildDailyPlans([input({ knowledge_states: [due, noEvidence, legacy] })], { asOf });
		const reviews = snapshot.courses[0].items.filter((item) => item.kind === "review");
		expect(reviews).toHaveLength(1);
		expect(reviews[0]).toMatchObject({
			kind: "review",
			concept_id: "concept_closure",
			evidence_count: 1,
			reason_code: "review_due",
		});
		expect(snapshot.courses[0].knowledge.due_reviews).toBe(1);
	});

	it("keeps task progress separate from knowledge and reports completion honestly", () => {
		const planValue = plan("plan_python", "course_python");
		const done = { ...task("t0", "course_python", planValue.plan_id, 0, 20, "已完成"), status: "completed" as const };
		const open = task("t1", "course_python", planValue.plan_id, 1, 20, "未完成");
		const snapshot = buildDailyPlans([input({
			plans: [planValue],
			tasks: [done, open],
			knowledge_states: [state("concept_closure", "course_python", { state_label: "stable" })],
		})], { asOf });
		expect(snapshot.courses[0].status).toBe("ok");
		expect(snapshot.courses[0].task_progress).toMatchObject({ total: 2, completed: 1, percent: 50 });
		expect(snapshot.courses[0].knowledge.stable_concepts).toBe(1);
		expect(snapshot.courses[0].items.every((item) => item.kind !== "task" || item.status !== "completed")).toBe(true);
	});

	it("reports no active plan without inventing tasks", () => {
		const draft = { ...plan("plan_draft", "course_python"), status: "draft" as const };
		const snapshot = buildDailyPlans([input({ plans: [draft] })], { asOf });
		expect(snapshot.courses[0].status).toBe("no_active_plan");
		expect(snapshot.courses[0].items).toEqual([]);
		expect(snapshot.courses[0].plan).toBeNull();
	});

	it("does not mutate its inputs", () => {
		const value = input({
			knowledge_states: [state("concept_closure", "course_python", {
				review_due_at: "2026-11-01T00:00:00.000Z",
			})],
		});
		const before = JSON.stringify(value);
		buildDailyPlans([value], { asOf });
		expect(JSON.stringify(value)).toBe(before);
	});
});

/**
 * E4.9i-P2-7 (T04) — the formal review gate, boundary by boundary.
 *
 * `reviewable()` (`daily-plan.ts:139-144`) is the only place a review slot is
 * granted. Its inputs are evidence, origin, the provenance flag and the date —
 * **`state_label` is not one of them**. That is easy to forget when a badge on
 * another page says 「待复习」, so these cases pin each boundary separately and
 * then pin the counter-intuitive consequences in both directions.
 *
 * This file only verifies the existing rule; it does not change it.
 */
describe("P2-7 T04 — reviewable() boundaries", () => {
	const due = (overrides: Partial<KnowledgeState> = {}) =>
		state("concept_closure", "course_python", {
			review_due_at: "2026-11-01T00:00:00.000Z",
			state_label: "review_due",
			...overrides,
		});

	const reviewIds = (states: KnowledgeState[]) => {
		const snapshot = buildDailyPlans([input({ knowledge_states: states })], { asOf });
		return {
			items: snapshot.courses[0].items.filter((item) => item.kind === "review").map((item) => item.concept_id),
			dueReviews: snapshot.courses[0].knowledge.due_reviews,
		};
	};

	it("V01 — no evidence means no slot", () => {
		expect(reviewIds([due({ evidence_ids: [] })])).toEqual({ items: [], dueReviews: 0 });
		expect(reviewIds([due({ evidence_ids: [""] })])).toEqual({ items: [], dueReviews: 0 });
	});

	it("V02 — a non-derived origin means no slot", () => {
		expect(reviewIds([due({ origin: "legacy" })])).toEqual({ items: [], dueReviews: 0 });
		expect(reviewIds([due({ origin: "manual" })])).toEqual({ items: [], dueReviews: 0 });
	});

	it("V03 — provenance_unknown blocks the slot even for a derived state", () => {
		expect(reviewIds([due({ provenance_unknown: true })])).toEqual({ items: [], dueReviews: 0 });
		expect(reviewIds([due({ provenance_unknown: false })])).toEqual({
			items: ["concept_closure"], dueReviews: 1,
		});
	});

	it("V04 — a missing or invalid date is not due", () => {
		expect(reviewIds([due({ review_due_at: undefined })])).toEqual({ items: [], dueReviews: 0 });
		expect(reviewIds([due({ review_due_at: "" })])).toEqual({ items: [], dueReviews: 0 });
		expect(reviewIds([due({ review_due_at: "not-a-date" })])).toEqual({ items: [], dueReviews: 0 });
	});

	it("V05 — a future date is not due yet", () => {
		expect(reviewIds([due({ review_due_at: "2027-01-01T00:00:00.000Z" })])).toEqual({
			items: [], dueReviews: 0,
		});
	});

	it("V06 — a record that satisfies every rule is used exactly as the server returns it", () => {
		const result = reviewIds([due()]);
		expect(result).toEqual({ items: ["concept_closure"], dueReviews: 1 });
	});

	it("V07 — state_label is not part of the gate, in either direction", () => {
		// A `learning` state with a due date, derived evidence and no provenance
		// flag is reviewable. The badge on the profile page still says 学习中.
		expect(reviewIds([due({ state_label: "learning" })])).toEqual({
			items: ["concept_closure"], dueReviews: 1,
		});
		// And a `review_due` state that fails the evidence rule is not.
		expect(reviewIds([due({ state_label: "review_due", evidence_ids: [] })])).toEqual({
			items: [], dueReviews: 0,
		});
	});

	it("V08 — due_reviews is a server tally, not a per-page count of badges", () => {
		// Two states carry `review_due`; only the one with a real evidence trail
		// and a due date counts. A UI that counted badges would report 2.
		const snapshot = buildDailyPlans([input({
			knowledge_states: [
				due({ concept_id: "concept_closure" }),
				due({ concept_id: "concept_voice", evidence_ids: [] }),
			],
		})], { asOf });
		expect(snapshot.courses[0].knowledge.due_reviews).toBe(1);
		const labels = snapshot.courses[0].items
			.filter((item) => item.kind === "review")
			.map((item) => item.concept_id);
		expect(labels).toEqual(["concept_closure"]);
	});
});
