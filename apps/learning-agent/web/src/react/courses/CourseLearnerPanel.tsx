import { useEffect, useMemo } from "react";
import { AlertTriangle, Loader2, Target } from "lucide-react";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore } from "../../stores/courses-store.js";
import type { CourseKnowledgeState } from "../../api/courses.js";

/**
 * 指定课程的学习档案 (E4.5e).
 *
 * Reads `GET /api/courses/:id/learner` and the course-scoped daily snapshot.
 * Only states the server attributes to this course are listed; goals,
 * knowledge and task completion never mix in another course's records.
 * Mastery numbers are displayed, never computed here, and the B2 evidence path
 * remains the only writer of formal mastery.
 */

const STATE_LABEL: Record<string, string> = {
	unknown: "证据不足",
	learning: "学习中",
	fragile: "不稳定",
	review_due: "待复习",
	stable: "稳定",
	misconception: "存在误区",
};

const WEAK = new Set(["fragile", "learning", "misconception", "review_due"]);

function formatDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function isWeak(state: CourseKnowledgeState): boolean {
	return Boolean(state.state_label && WEAK.has(state.state_label));
}

export function CourseLearnerPanel({ courseId }: { courseId: string }) {
	const state = useStoreSnapshot(coursesStore, () => ({
		courseLearner: coursesStore.courseLearner,
		courseLearnerLoading: coursesStore.courseLearnerLoading,
		courseLearnerError: coursesStore.courseLearnerError,
		courseDaily: coursesStore.courseDaily,
		courseDailyLoading: coursesStore.courseDailyLoading,
	}));

	useEffect(() => {
		void coursesStore.loadCourseLearner(courseId);
		void coursesStore.loadCourseDaily(courseId);
	}, [courseId]);

	const view = state.courseLearner;
	const knowledge = view?.knowledge_states ?? [];
	const weak = useMemo(() => knowledge.filter(isWeak), [knowledge]);
	const progress = state.courseDaily?.courses[0]?.task_progress ?? null;
	const daily = state.courseDaily?.courses[0] ?? null;

	if (state.courseLearnerLoading && !view) {
		return (
			<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
				<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取课程学习档案…
			</p>
		);
	}
	if (state.courseLearnerError) {
		return <p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.courseLearnerError}</p>;
	}
	if (!view) return null;

	return (
		<div className="mla-stack-lg">
			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>{view.course.title}</h2>
						<span className="mla-small mla-muted">只显示归属这门课程的学习记录</span>
					</div>
				</div>
				<div className="mla-fact-grid">
					<div className="mla-fact">
						<strong>{progress ? `${progress.completed}/${progress.total}` : "—"}</strong>
						<span>已完成任务（服务端统计）</span>
					</div>
					<div className="mla-fact">
						<strong>{progress ? `${progress.percent}%` : "—"}</strong>
						<span>任务完成率</span>
					</div>
					<div className="mla-fact">
						<strong>{knowledge.length}</strong>
						<span>有证据的知识点</span>
					</div>
					<div className="mla-fact">
						<strong>{weak.length}</strong>
						<span>需要关注的知识点</span>
					</div>
				</div>
				{state.courseDailyLoading && !daily ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取任务进度…
					</p>
				) : null}
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					任务完成率来自课程计划；知识掌握度只来自真实学习证据。两者分开显示，完成的任务不会自动被计为已掌握。
				</p>
			</section>

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>课程学习目标</h2>
					<span className="mla-small mla-muted">{view.goals.length} 个</span>
				</div>
				{view.goals.length === 0 ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>这门课程还没有关联学习目标。</p>
				) : (
					<div className="mla-state-list">
						{view.goals.map((goal) => (
							<div className="mla-state-row" key={goal.goal_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<Target size={14} aria-hidden="true" />
										<strong style={{ overflowWrap: "anywhere" }}>{goal.title}</strong>
										<span className="mla-badge">
											{goal.status === "active" ? "进行中" : goal.status === "completed" ? "已完成" : goal.status === "paused" ? "已暂停" : "已归档"}
										</span>
									</div>
									{goal.success_criteria.length > 0 ? <p>完成标准：{goal.success_criteria.join("；")}</p> : null}
								</div>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>知识掌握</h2>
					<span className="mla-small mla-muted">来自服务端记录的掌握状态</span>
				</div>
				{knowledge.length === 0 ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						这门课程还没有带证据的知识点。完成练习或学习对话后，这里会显示服务端记录的掌握状态。
					</p>
				) : (
					<div className="mla-state-list">
						{knowledge.map((item) => (
							<div className="mla-state-row" key={item.concept_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{item.concept_name || "知识点名称待确认"}</strong>
										<span className={`mla-badge${isWeak(item) ? " mla-badge--warning" : " mla-badge--success"}`}>
											{item.state_label ? STATE_LABEL[item.state_label] ?? item.state_label : "证据不足"}
										</span>
										{item.review_due_at ? <span className="mla-badge">复习 {formatDate(item.review_due_at)}</span> : null}
									</div>
									{item.diagnosis ? <p>{item.diagnosis}</p> : null}
								</div>
								<span className="mla-small mla-muted">证据 {item.evidence_ids.length} 条</span>
							</div>
						))}
					</div>
				)}
			</section>

			{weak.length > 0 ? (
				<section className="mla-card">
					<div className="mla-card-header">
						<h2>需要关注的知识点</h2>
					</div>
					<div className="mla-state-list">
						{weak.map((item) => (
							<div className="mla-state-row" key={item.concept_id}>
								<div>
									<div className="mla-inline">
										<AlertTriangle size={14} aria-hidden="true" />
										<strong>{item.concept_name || "知识点名称待确认"}</strong>
										<span className="mla-badge mla-badge--warning">
											{item.state_label ? STATE_LABEL[item.state_label] ?? item.state_label : "证据不足"}
										</span>
									</div>
									{item.next_actions.length > 0 ? <p>建议：{item.next_actions.join("；")}</p> : null}
								</div>
							</div>
						))}
					</div>
				</section>
			) : null}

			{view.unclassified.knowledge_states > 0 || view.unclassified.goals > 0 ? (
				<section className="mla-card">
					<h2>未归类的旧记录</h2>
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						另有 {view.unclassified.knowledge_states} 条知识点与 {view.unclassified.goals} 个目标没有课程归属。
						这些是较早的个人记录或跨课程档案，不会被并入本课程的统计，也不会被自动删除。
					</p>
				</section>
			) : null}

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>教学偏好</h2>
					<span className="mla-badge">个人共享设置</span>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					讲解风格、练习偏好与反馈语气属于你的个人学习档案，对所有课程生效；这里只展示，不按课程修改。
				</p>
				<div className="mla-stack" style={{ gap: 8 }}>
					{([
						["讲解风格", view.preferences.explanation_style],
						["练习偏好", view.preferences.practice_style],
						["反馈语气", view.preferences.feedback_tone],
						["希望避免", view.preferences.avoid],
					] as const).map(([label, values]) => (
						<div className="mla-inline" key={label}>
							<span className="mla-small mla-muted">{label}：</span>
							{values.length === 0
								? <span className="mla-small mla-muted">未设置</span>
								: values.map((value) => <span className="mla-badge" key={value}>{value}</span>)}
						</div>
					))}
				</div>
			</section>
		</div>
	);
}
