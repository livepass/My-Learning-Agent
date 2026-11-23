import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { PublicLearningQuestion } from "../../../api/learning.js";
import { Badge, Button } from "../../ui/index.js";

/** Kind → copy key. One table, shared with the page. */
export const PRACTICE_KIND_LABEL_KEY: Record<PublicLearningQuestion["kind"], string> = {
	free_recall: "practice.generator.kind.freeRecall",
	application: "practice.generator.kind.application",
	transfer: "practice.generator.kind.transfer",
};

export type PracticeQuestionCardProps = {
	question: PublicLearningQuestion | null;
	/** Server-confirmed review question. */
	reviewActive: boolean;
	/** 「来自资料库」/「来自模型知识」, or null when the server sent none. */
	sourceLabel: string | null;
	checkpointRevision: number | null;
	/** True while the learning state is being read and nothing is known yet. */
	loading: boolean;
	/** Rendered when no conversation is open. */
	noSessionCopy: string;
	/** True when the conversation has no learning record yet. */
	noRecord: boolean;
	onInit: () => void;
	initBusy: boolean;
	/** The answer panel, so prompt and answer stay in one card. */
	children?: ReactNode;
};

/**
 * E4.9h-P2-1 — the question region inside the practice card.
 *
 * This is the *content* of the page's `<Card variant="practice">`, not a card
 * of its own: wrapping it in another Card would nest surfaces and change the
 * DOM the existing CSS targets. The page keeps the outer card and passes the
 * answer panel in as `children`, so 「题目与作答在同一张卡片」 holds
 * structurally rather than by coincidence.
 *
 * Provenance and review identity are decided by the page:
 *
 * - `sourceLabel` comes from the server's `checkpoint.knowledge.kind`;
 * - `reviewActive` comes from `reviewQuestionActive`, which requires the
 *   server-saved `question.review === true`. Nothing here can promote a plain
 *   question.
 */
export function PracticeQuestionCard({
	question,
	reviewActive,
	sourceLabel,
	checkpointRevision,
	loading,
	noSessionCopy,
	noRecord,
	onInit,
	initBusy,
	children,
}: PracticeQuestionCardProps) {
	const { t } = useTranslation();

	return (
		<>
			<div className="mla-practice-head">
				<div className="mla-practice-tags">
					<h2 id="practice-question">{t("practice.question.title")}</h2>
					{reviewActive ? <Badge>{t("practice.question.reviewBadge")}</Badge> : null}
					{sourceLabel ? <Badge tone="accent">{sourceLabel}</Badge> : null}
					{question ? (
						<Badge>
							{t(PRACTICE_KIND_LABEL_KEY[question.kind] ?? "practice.question.kindFallback")}
						</Badge>
					) : null}
				</div>
				{question ? (
					// Technical identity stays available but out of the reading flow.
					<details className="mla-practice-meta">
						<summary>{t("practice.question.metaSummary")}</summary>
						<p>
							{t("practice.question.meta", {
								id: question.question_id,
								version: question.question_version,
							})}
							{checkpointRevision !== null
								? t("practice.question.metaRevision", { revision: checkpointRevision })
								: ""}
							{question.concept_id
								? t("practice.question.metaConcept", { concept: question.concept_id })
								: ""}
						</p>
					</details>
				) : null}
			</div>

			{noSessionCopy ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>{noSessionCopy}</p>
			) : loading ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					{t("practice.question.loading")}
				</p>
			) : !question && noRecord ? (
				<div className="mla-stack" style={{ gap: 10 }}>
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						{t("practice.question.noRecord")}
					</p>
					<Button variant="primary" disabled={initBusy} onClick={onInit}>
						{t("practice.question.init")}
					</Button>
				</div>
			) : question ? (
				<>
					{/* The prompt is rendered verbatim: never reworded, never split by
					    the UI, and it keeps its own line breaks. */}
					<p className="mla-practice-prompt">{question.prompt}</p>
					<p className="mla-small mla-muted mla-practice-hint">
						{reviewActive
							? t("practice.question.hintReview")
							: t("practice.question.hint")}
					</p>

					<hr className="mla-practice-divider" />

					{children}
				</>
			) : null}
		</>
	);
}
