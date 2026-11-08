import { useEffect } from "react";
import { AlertTriangle, BookOpen } from "lucide-react";
import { coursesStore } from "../../stores/courses-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { navigate } from "../shell/navigation.js";

/**
 * Course / task / stage strip above the chat (E4.5d).
 *
 * The binding comes from `GET /api/courses/bindings/session/:sessionId` — the
 * server's record of which task this conversation belongs to. An unclassified
 * session (a legacy chat, or a free question) shows nothing rather than
 * guessing a course from its title.
 *
 * Entering this page never marks a task complete: the strip is a label, not a
 * control.
 */
export function CourseContextStrip({ sessionId }: { sessionId: string | null }) {
	const entry = useStoreSnapshot(coursesStore, () => coursesStore.sessionContext(sessionId));

	useEffect(() => {
		if (!sessionId) return;
		if (coursesStore.sessionContext(sessionId)) return;
		void coursesStore.loadSessionContext(sessionId);
	}, [sessionId]);

	if (!sessionId || !entry || entry.context.unclassified || !entry.context.course) return null;

	const { course, task } = entry.context;
	const stageTitle = entry.stageTitle;

	return (
		<div className="mla-context-strip" aria-label="当前课程任务">
			<BookOpen size={14} aria-hidden="true" />
			<button
				type="button"
				className="mla-link-button"
				style={{ color: "inherit", textDecoration: "underline" }}
				onClick={() => navigate("course", { history: "push", course: { id: course.course_id, view: "records" } })}
			>
				{course.title}
			</button>
			{task ? (
				<>
					<span aria-hidden="true">·</span>
					<strong>{task.title}</strong>
					{task.status === "in_progress" ? <span className="mla-badge mla-badge--accent">进行中</span> : null}
				</>
			) : (
				<>
					<span aria-hidden="true">·</span>
					<span>自由学习</span>
				</>
			)}
			{stageTitle ? (
				<>
					<span aria-hidden="true">·</span>
					<span>阶段：{stageTitle}</span>
				</>
			) : null}
			{entry.warnings.map((warning) => (
				<span key={warning} className="mla-inline" style={{ gap: 4, color: "var(--inno-warning)" }}>
					<AlertTriangle size={12} aria-hidden="true" />
					{warning}
				</span>
			))}
		</div>
	);
}
