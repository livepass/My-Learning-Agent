// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n/index.js";
import type { KnowledgeState, LearnerProfile, Misconception } from "../../types/learner.js";
import { ProfileConclusion } from "./ProfileConclusion.js";
import { deriveProfileOverview } from "./profile-overview.js";

/**
 * E4.9i-P2-3 — the conclusion text, branch by branch.
 *
 * Every assertion here is about what the sentence may and may not claim: a
 * `review_due` count is a classification, an unknown state is not success, and
 * the profile holds no data for accuracy or mastery claims.
 */

const knowledge = (patch: Partial<KnowledgeState> & { concept_id: string }): KnowledgeState => ({
	concept_name: patch.concept_id,
	domain: "cet4",
	mastery: 0.5,
	confidence: 0.5,
	stability: 0.5,
	evidence_ids: [],
	diagnosis: "",
	next_actions: [],
	...patch,
});

const misconception = (patch: Partial<Misconception> & { misconception_id: string }): Misconception => ({
	concept_id: "c1",
	description: "误区",
	status: "active",
	severity: 0.5,
	confidence: 0.5,
	first_seen_at: "2026-11-01T00:00:00.000Z",
	last_seen_at: "2026-11-01T00:00:00.000Z",
	evidence_ids: [],
	repair_strategy: "",
	...patch,
});

const profile = (patch: Partial<LearnerProfile> = {}): LearnerProfile => ({
	learner_id: "default",
	version: 1,
	updated_at: "2026-11-01T00:00:00.000Z",
	goals: [],
	knowledge_states: [],
	misconceptions: [],
	preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
	profile_summary: "",
	...patch,
});

function renderFor(input: LearnerProfile) {
	return render(<ProfileConclusion overview={deriveProfileOverview(input)} />);
}

/** The forbidden claims from the task brief. */
const FORBIDDEN = [
	"已经掌握全部知识",
	"全部掌握",
	"正确率达到",
	"学习成绩提升",
	"今天必须复习",
	"AI 分析认为",
	"已通过到期复习资格核查",
];

function expectNoForbiddenClaims() {
	const text = document.body.textContent ?? "";
	for (const claim of FORBIDDEN) expect(text, claim).not.toContain(claim);
}

beforeEach(async () => {
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

afterEach(async () => {
	cleanup();
	await act(async () => { await i18n.changeLanguage("zh-CN"); });
});

describe("ProfileConclusion", () => {
	it("C01 shows the empty conclusion with no knowledge records", () => {
		renderFor(profile());
		expect(screen.getByText("还没有已记录的知识点。")).toBeTruthy();
		expect(screen.getByText(/完成一次练习或学习对话后/)).toBeTruthy();
		expectNoForbiddenClaims();
	});

	it("C02 states the total and the stable count without claiming mastery", () => {
		renderFor(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "stable" }),
				knowledge({ concept_id: "b", state_label: "stable" }),
			],
		}));
		expect(screen.getByText("共记录 2 个知识点，2 个状态稳定。")).toBeTruthy();
		expect(screen.getByText("当前没有标记为需要关注的知识点。")).toBeTruthy();
		// "Stable" is a state classification, not a mastery claim.
		expectNoForbiddenClaims();
	});

	it("C03 reports only the weak count when every state needs attention", () => {
		renderFor(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "learning" }),
				knowledge({ concept_id: "b", state_label: "fragile" }),
				knowledge({ concept_id: "c", state_label: "learning" }),
			],
		}));
		expect(screen.getByText("共记录 3 个知识点，其中 3 个需要关注。")).toBeTruthy();
		// No review_due or misconception clause, because neither is present.
		expect(screen.queryByText(/待复习状态/)).toBeNull();
		expect(screen.queryByText(/存在误区/)).toBeNull();
	});

	it("C04 emphasises the missing evidence when only unknown states exist", () => {
		renderFor(profile({
			knowledge_states: [
				knowledge({ concept_id: "a" }),
				knowledge({ concept_id: "b", state_label: "unknown" }),
			],
		}));
		expect(screen.getByText("共记录 2 个知识点，2 个证据不足。")).toBeTruthy();
		expect(screen.getByText(/缺少可判断的状态/)).toBeTruthy();
		// It must not read as "no weak concepts, so all good".
		expect(screen.queryByText("当前没有标记为需要关注的知识点。")).toBeNull();
		expectNoForbiddenClaims();
	});

	it("C05 reports stable and weak counts together for a mixed profile", () => {
		renderFor(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "stable" }),
				knowledge({ concept_id: "b", state_label: "learning" }),
				knowledge({ concept_id: "c", state_label: "fragile" }),
			],
		}));
		expect(screen.getByText("共记录 3 个知识点，其中 2 个需要关注，1 个状态稳定。")).toBeTruthy();
	});

	it("C06 names review_due as a state, never as a due review", () => {
		renderFor(profile({
			knowledge_states: [
				knowledge({ concept_id: "a", state_label: "review_due" }),
				knowledge({ concept_id: "b", state_label: "review_due" }),
				knowledge({ concept_id: "c", state_label: "learning" }),
			],
		}));
		const line = screen.getByText(/处于待复习状态/);
		expect(line.textContent).toContain("2");
		expect(line.textContent).toContain("以今日学习中的服务端结果为准");
		expectNoForbiddenClaims();
	});

	it("C07 counts misconception states and misconception records separately", () => {
		renderFor(profile({
			knowledge_states: [knowledge({ concept_id: "a", state_label: "misconception" })],
			misconceptions: [
				misconception({ misconception_id: "m1", status: "active" }),
				misconception({ misconception_id: "m2", status: "repairing" }),
				misconception({ misconception_id: "m3", status: "resolved" }),
			],
		}));
		// One concept state, two open records — never merged into "3".
		expect(screen.getByText("其中 1 个知识点被标记为存在误区。")).toBeTruthy();
		expect(screen.getByText(/另有 2 条未解决的误区记录/)).toBeTruthy();
	});

	it("C08 always carries the source caveat", () => {
		renderFor(profile({ knowledge_states: [knowledge({ concept_id: "a", state_label: "learning" })] }));
		expect(screen.getByText("以上为当前学习档案的分类统计，不代表练习正确率或正式到期复习资格。")).toBeTruthy();
	});

	it("C09 points to the stored next actions instead of inventing advice", () => {
		renderFor(profile({ knowledge_states: [knowledge({ concept_id: "a", state_label: "learning" })] }));
		expect(screen.getByText(/见下方「需要关注的知识点」/)).toBeTruthy();
	});

	it("C10 renders the English copy after a language switch", async () => {
		renderFor(profile({
			knowledge_states: [knowledge({ concept_id: "a", state_label: "review_due" })],
		}));
		await act(async () => { await i18n.changeLanguage("en"); });
		expect(screen.getByText("1 concept recorded, 1 needing attention.")).toBeTruthy();
		expect(screen.getByText(/whether a review is actually due is decided by the server/)).toBeTruthy();
		expect(screen.queryByText(/待复习状态/)).toBeNull();
	});
});
