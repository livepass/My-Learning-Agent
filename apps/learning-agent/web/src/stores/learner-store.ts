import { EventEmitter } from "./event-emitter.js";
import {
	getLearnerProfile,
	patchLearnerProfile,
	createGoal as apiCreateGoal,
	updateGoal as apiUpdateGoal,
	deleteGoal as apiDeleteGoal,
	updateKnowledge as apiUpdateKnowledge,
	updateMisconception as apiUpdateMisconception,
	getLearningRecommendations,
} from "../api/learner.js";
import type {
	LearnerProfile,
	LearningGoal,
	KnowledgeState,
	Misconception,
	LearnerPreferences,
	RecommendationSnapshot,
} from "../types/learner.js";

interface LearnerStoreEvents {
	change: void;
}

/** One public message for both global and concept-scoped recommendation reads. */
function recommendationErrorMessage(err: unknown): string {
	const status = (err as { status?: number } | undefined)?.status;
	if (status === 503) return "学习档案暂时不可用，无法生成下一步建议。";
	return err instanceof Error ? err.message : String(err);
}

class LearnerStoreImpl extends EventEmitter<LearnerStoreEvents> {
	profile: LearnerProfile | null = null;
	isLoading = false;
	isSaving = false;
	error: string | null = null;
	/** Last read snapshot of GET /api/learner/recommendations (C4-B). */
	recommendations: RecommendationSnapshot | null = null;
	recommendationsLoading = false;
	recommendationsError: string | null = null;
	/** Newest recommendation read; an older response must not overwrite it. */
	private _recommendationTicket = 0;
	/**
	 * Concept-scoped advice for the practice page.
	 *
	 * Kept separate from the global Top-3 list: the current concept may rank 4th
	 * globally and would otherwise never be readable. The request concept is
	 * stored beside the snapshot so the page can verify identity before rendering.
	 */
	conceptRecommendation: RecommendationSnapshot | null = null;
	conceptRecommendationConceptId: string | null = null;
	conceptRecommendationLoading = false;
	conceptRecommendationError: string | null = null;
	private _conceptRecommendationTicket = 0;

	async load(): Promise<void> {
		this.isLoading = true;
		this.error = null;
		this.emit("change", undefined);
		try {
			this.profile = await getLearnerProfile();
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	/**
	 * Read the next-step recommendations (C4-B).
	 *
	 * Pure read: the server derives them from L1 at request time. The ticket
	 * makes only the newest request paintable, so a slow response from before a
	 * C3 record can never overwrite suggestions computed after it.
	 */
	async loadRecommendations(limit = 3): Promise<void> {
		const ticket = ++this._recommendationTicket;
		this.recommendationsLoading = true;
		this.recommendationsError = null;
		this.emit("change", undefined);
		try {
			const snapshot = await getLearningRecommendations(limit);
			if (ticket !== this._recommendationTicket) return;
			this.recommendations = snapshot;
		} catch (err) {
			if (ticket !== this._recommendationTicket) return;
			// A failed read invalidates the previous snapshot: keeping it would
			// present stale advice as current. The error is the only state the UI
			// may render now.
			this.recommendations = null;
			this.recommendationsError = recommendationErrorMessage(err);
		} finally {
			if (ticket === this._recommendationTicket) {
				this.recommendationsLoading = false;
				this.emit("change", undefined);
			}
		}
	}

	/**
	 * Read the advice for exactly one concept (practice page).
	 *
	 * The server matches the concept against the real L1 profile before applying
	 * the rules, so a concept outside the global Top 3 still gets its own answer.
	 * Clearing at the start prevents the previous concept's card from surviving a
	 * switch; the ticket prevents a late response for an old concept from
	 * repainting after the question has moved on.
	 */
	async loadConceptRecommendation(conceptId: string): Promise<void> {
		const ticket = ++this._conceptRecommendationTicket;
		this.conceptRecommendationConceptId = conceptId;
		this.conceptRecommendation = null;
		this.conceptRecommendationError = null;
		this.conceptRecommendationLoading = true;
		this.emit("change", undefined);
		try {
			const snapshot = await getLearningRecommendations(3, conceptId);
			if (ticket !== this._conceptRecommendationTicket) return;
			if (snapshot.concept_id !== conceptId) {
				this.conceptRecommendation = null;
				this.conceptRecommendationError = "推荐结果与当前知识点不一致，请重新加载。";
				return;
			}
			this.conceptRecommendation = snapshot;
		} catch (err) {
			if (ticket !== this._conceptRecommendationTicket) return;
			this.conceptRecommendation = null;
			this.conceptRecommendationError = recommendationErrorMessage(err);
		} finally {
			if (ticket === this._conceptRecommendationTicket) {
				this.conceptRecommendationLoading = false;
				this.emit("change", undefined);
			}
		}
	}

	async patchSummary(summary: string): Promise<void> {
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			this.profile = await patchLearnerProfile({ profile_summary: summary });
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async patchPreferences(prefs: LearnerPreferences): Promise<void> {
		this.isSaving = true;
		this.emit("change", undefined);
		try {
			this.profile = await patchLearnerProfile({ preferences: prefs });
		} finally {
			this.isSaving = false;
			this.emit("change", undefined);
		}
	}

	async addGoal(input: Partial<LearningGoal>): Promise<LearningGoal> {
		const goal = await apiCreateGoal(input);
		if (this.profile) {
			this.profile = { ...this.profile, goals: [goal, ...this.profile.goals] };
			this.emit("change", undefined);
		}
		return goal;
	}

	async patchGoal(goalId: string, patch: Partial<LearningGoal>): Promise<void> {
		const updated = await apiUpdateGoal(goalId, patch);
		if (this.profile) {
			this.profile = {
				...this.profile,
				goals: this.profile.goals.map((g) => (g.goal_id === goalId ? updated : g)),
			};
			this.emit("change", undefined);
		}
	}

	async deleteGoal(goalId: string): Promise<void> {
		await apiDeleteGoal(goalId);
		if (this.profile) {
			this.profile = {
				...this.profile,
				goals: this.profile.goals.filter((g) => g.goal_id !== goalId),
			};
			this.emit("change", undefined);
		}
	}

	async patchKnowledge(conceptId: string, patch: Partial<KnowledgeState>): Promise<void> {
		const updated = await apiUpdateKnowledge(conceptId, patch);
		if (this.profile) {
			this.profile = {
				...this.profile,
				knowledge_states: this.profile.knowledge_states.map((k) =>
					k.concept_id === conceptId ? updated : k,
				),
			};
			this.emit("change", undefined);
		}
	}

	async patchMisconception(miscId: string, patch: Partial<Misconception>): Promise<void> {
		const updated = await apiUpdateMisconception(miscId, patch);
		if (this.profile) {
			this.profile = {
				...this.profile,
				misconceptions: this.profile.misconceptions.map((m) =>
					m.misconception_id === miscId ? updated : m,
				),
			};
			this.emit("change", undefined);
		}
	}
}

export const learnerStore = new LearnerStoreImpl();
