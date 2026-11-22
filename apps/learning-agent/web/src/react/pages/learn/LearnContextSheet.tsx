import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { LearningState } from "../../../api/learning.js";
import type { LearningReadOnlyReason } from "../../LearningWorkspace.js";
import { IconButton, Sheet } from "../../ui/index.js";
import { LearnContextPanel } from "./LearnContextPanel.js";
import type { LearnCourseBarCourse } from "./LearnCourseBar.js";

/**
 * E4.9g-P2-3 — the learning context as an on-demand sheet.
 *
 * Desktop: an overlay anchored inside the chat card (360px, right edge). It is
 * **not** modal — the chat stays readable and scrollable — and closing it
 * re-allocates nothing, because it never owned a grid column.
 *
 * Phone: a bottom sheet with a backdrop and modal semantics (background inert,
 * body scroll locked, focus trapped). Both modes close on Escape, the close
 * button and (desktop) an outside click; the phone backdrop is its own close
 * target.
 *
 * Business permissions are *not* decided here. `readOnlySession`,
 * `canInitialize`, `canPause` and `canResume` are computed once in `LearnPage`
 * (E4.9g-P2-2-R2) and passed straight through.
 */
export function LearnContextSheet({
	open,
	modal,
	currentSessionId,
	course,
	taskTitle,
	stageTitle,
	unclassified,
	learning,
	readOnlySession,
	canInitialize,
	canPause,
	canResume,
	onClose,
	onRetry,
	onInit,
	onPause,
	onResume,
}: {
	open: boolean;
	/** Phone bottom sheet; the desktop overlay is non-modal. */
	modal: boolean;
	currentSessionId: string | null;
	course: LearnCourseBarCourse | null;
	taskTitle: string | null;
	stageTitle: string | null;
	unclassified: boolean;
	learning: {
		state: LearningState | null;
		isLoading: boolean;
		isSaving: boolean;
		error: string | null;
	};
	readOnlySession: LearningReadOnlyReason | false;
	canInitialize: boolean;
	canPause: boolean;
	canResume: boolean;
	onClose: () => void;
	onRetry: () => void;
	onInit: () => void;
	onPause: () => void;
	onResume: () => void;
}) {
	const { t } = useTranslation();

	return (
		<Sheet
			open={open}
			modal={modal}
			label={t("learn.context.title")}
			className="mla-context-sheet"
			onClose={onClose}
		>
			<header className="mla-context-sheet-head">
				<h2>{t("learn.context.title")}</h2>
				<IconButton
					size="sm"
					aria-label={t("learn.context.close")}
					onClick={onClose}
				>
					<X size={16} aria-hidden="true" />
				</IconButton>
			</header>

			<div className="mla-context-sheet-body">
				<section className="mla-context-section" aria-label={t("learn.context.courseSection")}>
					<span className="mla-overline">{t("learn.context.courseSection")}</span>
					<div className="mla-card mla-context-card">
						{unclassified ? (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{t("learn.sidebar.unclassifiedChat")}
							</p>
						) : course ? (
							<>
								<div className="mla-context-course">
									<strong>{course.title}</strong>
									{course.status ? (
										<span className="mla-small mla-muted">{t(`course.status.${course.status}`)}</span>
									) : null}
								</div>
								{taskTitle ? (
									<dl className="mla-definition">
										<div>
											<dt>{t("learn.courseBar.currentTask")}</dt>
											<dd>{taskTitle}</dd>
										</div>
										{stageTitle ? (
											<div>
												<dt>{t("learn.status.stepLabel")}</dt>
												<dd>{stageTitle}</dd>
											</div>
										) : null}
									</dl>
								) : (
									<p className="mla-small mla-muted" style={{ margin: 0 }}>
										{t("course.context.freeLearning")}
									</p>
								)}
							</>
						) : (
							<p className="mla-small mla-muted" style={{ margin: 0 }}>
								{t("learn.context.noCourse")}
							</p>
						)}
					</div>
				</section>

				<section className="mla-context-section" aria-label={t("learn.context.sessionSection")}>
					<span className="mla-overline">{t("learn.context.sessionSection")}</span>
					<LearnContextPanel
						currentSessionId={currentSessionId}
						learning={learning}
						readOnlySession={readOnlySession}
						canInitialize={canInitialize}
						canPause={canPause}
						canResume={canResume}
						onRetry={onRetry}
						onInit={onInit}
						onPause={onPause}
						onResume={onResume}
					/>
				</section>

				<p className="mla-context-note">{t("learn.context.note")}</p>
			</div>
		</Sheet>
	);
}
