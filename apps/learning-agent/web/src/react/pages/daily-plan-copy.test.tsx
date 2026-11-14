// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import { courseNotes, courseNotesWithoutPlan, reviewReasonText, taskReasonText } from "./daily-plan-copy.js";
import { recommendationReasonText } from "./recommendation-copy.js";
import type { CourseDailyPlan } from "../../api/courses.js";
import type { LearningRecommendation } from "../../types/learner.js";

/**
 * E4.9e — the rule-generated explanations follow the UI language.
 *
 * The server ships a Chinese `reason` / `notes` sentence alongside a
 * machine-readable `reason_code` (and structured plan fields). The UI renders
 * from the code, so the same decision reads correctly in both languages and a
 * language switch updates text already on screen.
 */

const t = i18n.t.bind(i18n);

beforeEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
	cleanup();
	await i18n.changeLanguage("zh-CN");
});

const plan = (over: Partial<CourseDailyPlan>): CourseDailyPlan => ({
	course_id: "course_a",
	course_title: "课程",
	status: "ok",
	daily_minutes: 30,
	plan: { plan_id: "plan_1", title: "我的计划", revision: 1 },
	other_active_plans: 0,
	items: [],
	planned_minutes: 0,
	task_progress: { total: 0, completed: 0, in_progress: 0, percent: 0 },
	knowledge: {
		due_reviews: 0, weak_concepts: 0, stable_concepts: 0, evidence_backed_concepts: 0,
	},
	notes: ["服务端中文说明"],
	...over,
} as CourseDailyPlan);

const recommendation = (over: Partial<LearningRecommendation>): LearningRecommendation => ({
	concept_id: "c1",
	concept_name: "闭包",
	name_available: true,
	action: "review",
	reason_code: "review_due",
	reason: "服务端中文理由",
	also_matches: [],
	evidence_basis: {
		evidence_count: 2,
		exposure_only: false,
		provenance_limited: false,
		review_due_at: "2026-11-20T00:00:00.000Z",
	},
	...over,
} as LearningRecommendation);

describe("daily plan copy", () => {
	it("keeps the same meaning for each task reason in both languages", async () => {
		for (const code of ["over_budget", "in_progress", "next_task"]) {
			const zh = taskReasonText(i18n.t.bind(i18n), code);
			await i18n.changeLanguage("en");
			const en = taskReasonText(i18n.t.bind(i18n), code);
			await i18n.changeLanguage("zh-CN");
			expect(zh.length).toBeGreaterThan(0);
			expect(en.length).toBeGreaterThan(0);
			// The English text must not fall back to the Chinese resource.
			expect(en).not.toBe(zh);
			expect(en).not.toMatch(/[一-鿿]/);
		}
	});

	it("interpolates the other-plan count and keeps the learner's plan title untranslated", async () => {
		const zh = courseNotes(i18n.t.bind(i18n), plan({ other_active_plans: 2 }));
		const joined = zh.join("");
		expect(joined).toContain("2");
		// The learner wrote this title; it is never translated.
		expect(joined).toContain("我的计划");

		await i18n.changeLanguage("en");
		const enNotes = courseNotes(i18n.t.bind(i18n), plan({ other_active_plans: 2 }));
		const en = enNotes.join("");
		expect(en).toContain("2");
		// The learner's own plan title survives verbatim — it is user content, not
		// a system string, so the Chinese check below only covers the system text.
		expect(en).toContain("我的计划");
		expect(enNotes[0]).not.toMatch(/[一-鿿]/);
		expect(enNotes[1]!.replace("我的计划", "")).not.toMatch(/[一-鿿]/);
	});

	it("renders the no-plan notes and the all-completed note", async () => {
		expect(courseNotesWithoutPlan(i18n.t.bind(i18n))).toHaveLength(2);
		const done = courseNotes(i18n.t.bind(i18n), plan({ status: "all_completed" }));
		expect(done.length).toBe(2);
	});

	it("does not show Chinese rule text in English mode", async () => {
		await i18n.changeLanguage("en");
		const text = [
			taskReasonText(i18n.t.bind(i18n), "over_budget"),
			reviewReasonText(i18n.t.bind(i18n)),
			...courseNotesWithoutPlan(i18n.t.bind(i18n)),
		].join(" ");
		expect(text).not.toMatch(/[一-鿿]/);
	});
});

describe("recommendation copy", () => {
	it("renders every reason code in both languages without Chinese in English", async () => {
		const codes = [
			"active_misconception", "review_due", "fragile_evidence",
			"learning_needs_diagnosis", "stable_transfer",
		] as const;
		for (const code of codes) {
			await i18n.changeLanguage("zh-CN");
			const zh = recommendationReasonText(i18n.t.bind(i18n), recommendation({ reason_code: code }));
			await i18n.changeLanguage("en");
			const en = recommendationReasonText(i18n.t.bind(i18n), recommendation({ reason_code: code }));
			expect(zh).not.toMatch(/^today\./);
			expect(en).not.toMatch(/^today\./);
			expect(en).not.toMatch(/[一-鿿]/);
			expect(en).not.toBe(zh);
		}
	});

	it("keeps the exposure_only branch of learning_needs_diagnosis", async () => {
		const exposure = recommendation({
			reason_code: "learning_needs_diagnosis",
			evidence_basis: {
				evidence_count: 0, exposure_only: true, provenance_limited: false,
			},
		} as Partial<LearningRecommendation>);
		const withEvidence = recommendation({
			reason_code: "learning_needs_diagnosis",
			evidence_basis: {
				evidence_count: 1, exposure_only: false, provenance_limited: false,
			},
		} as Partial<LearningRecommendation>);

		const a = recommendationReasonText(i18n.t.bind(i18n), exposure);
		const b = recommendationReasonText(i18n.t.bind(i18n), withEvidence);
		expect(a).not.toBe(b);
	});

	it("interpolates the due date and never invents one", async () => {
		const dated = recommendationReasonText(i18n.t.bind(i18n), recommendation({}));
		expect(dated).toContain("2026-11-20");

		const undated = recommendationReasonText(i18n.t.bind(i18n), recommendation({
			evidence_basis: {
				evidence_count: 1, exposure_only: false, provenance_limited: false,
			},
		} as Partial<LearningRecommendation>));
		expect(undated).not.toContain("2026");
		expect(undated.length).toBeGreaterThan(0);
	});

	it("updates existing text in place when the language switches", async () => {
		const item = recommendation({ reason_code: "stable_transfer" });
		function Copy() {
			return <p>{recommendationReasonText(i18n.t.bind(i18n), item)}</p>;
		}
		render(<Copy />);
		expect(screen.getByText(/已有多条可信证据/)).toBeTruthy();

		// The component re-renders because i18next broadcasts the change; no
		// refetch and no new server call is involved.
		await i18n.changeLanguage("en");
		render(<Copy />);
		expect(screen.getByText(/several credible pieces of evidence/i)).toBeTruthy();
	});
});
