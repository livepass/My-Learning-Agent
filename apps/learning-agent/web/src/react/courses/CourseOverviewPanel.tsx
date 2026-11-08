import { useEffect, useMemo, useState } from "react";
import { Link2, Loader2, Plus, Target, Unlink } from "lucide-react";
import { Button, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore } from "../../stores/courses-store.js";
import { learnerStore } from "../../stores/learner-store.js";
import type { CourseKnowledgeState } from "../../api/courses.js";

/**
 * 学习概况 (E4.5c / E4.5e).
 *
 * Two different questions are kept apart on purpose:
 *   - task completion — a count of finished plan tasks, computed by the server;
 *   - knowledge mastery — the L1 states whose evidence was recorded in a
 *     course-bound session.
 *
 * The panel never derives a mastery number and never writes one. Goals are
 * created through `learnerStore` (the single goal owner) and then bound here;
 * teaching preferences are shown as personal/shared, not per-course.
 */

const STATE_LABEL: Record<string, string> = {
	unknown: "证据不足",
	learning: "学习中",
	fragile: "不稳定",
	review_due: "待复习",
	stable: "稳定",
	misconception: "存在误区",
};

const WEAK_LABELS = new Set(["fragile", "learning", "misconception", "review_due"]);

function formatDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function stateLabel(state: CourseKnowledgeState): string {
	if (!state.state_label) return "证据不足";
	return STATE_LABEL[state.state_label] ?? state.state_label;
}

function isWeak(state: CourseKnowledgeState): boolean {
	return Boolean(state.state_label && WEAK_LABELS.has(state.state_label));
}

/** Bind an existing personal goal to this course (no second goal store). */
function BindGoal({ courseId, boundIds }: { courseId: string; boundIds: Set<string> }) {
	const profile = useStoreSnapshot(learnerStore, () => learnerStore.profile);
	const pendingAction = useStoreSnapshot(coursesStore, () => coursesStore.pendingAction);
	const [selected, setSelected] = useState("");
	const [newTitle, setNewTitle] = useState("");
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		if (!profile) void learnerStore.load();
	}, [profile]);

	const candidates = (profile?.goals ?? []).filter((goal) => !boundIds.has(goal.goal_id));
	const busy = pendingAction !== null;

	const createAndBind = async () => {
		const title = newTitle.trim();
		if (!title) return;
		try {
			const goal = await learnerStore.addGoal({
				title,
				type: "skill",
				priority: 3,
				status: "active",
				success_criteria: [],
				source: "user_declared",
			});
			const bound = await coursesStore.bindGoal(courseId, goal.goal_id);
			if (bound) {
				setNewTitle("");
				setCreating(false);
			}
		} catch {
			// The store surfaces the failure; keep the typed title for a retry.
		}
	};

	return (
		<div className="mla-stack" style={{ gap: 10 }}>
			{candidates.length > 0 ? (
				<div className="mla-inline">
					<Select value={selected || "none"} disabled={busy} onValueChange={(value) => setSelected(value === "none" ? "" : value)}>
						<SelectTrigger aria-label="选择要关联的学习目标"><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectOption value="none" label="选择学习档案中的目标" />
							{candidates.map((goal) => <SelectOption key={goal.goal_id} value={goal.goal_id} label={goal.title} />)}
						</SelectContent>
					</Select>
					<Button
						disabled={!selected || busy}
						onClick={async () => {
							const done = await coursesStore.bindGoal(courseId, selected);
							if (done) setSelected("");
						}}
					>
						<Link2 size={14} />
						关联到本课程
					</Button>
				</div>
			) : (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{!profile
						? "正在读取学习档案中的目标…"
						: (profile.goals?.length ?? 0) === 0
							? "学习档案中还没有目标，可以在下面新建一个。"
							: "学习档案中的目标都已关联到本课程。"}
				</p>
			)}

			{creating ? (
				<div className="mla-inline">
					<Input
						value={newTitle}
						autoFocus
						maxLength={120}
						placeholder="例如：掌握 Python 装饰器"
						disabled={busy}
						onChange={(event) => setNewTitle(event.target.value)}
					/>
					<Button variant="primary" disabled={busy || !newTitle.trim()} onClick={() => void createAndBind()}>
						新建并关联
					</Button>
					<Button disabled={busy} onClick={() => { setCreating(false); setNewTitle(""); }}>取消</Button>
				</div>
			) : (
				<Button size="xs" disabled={busy} onClick={() => setCreating(true)}>
					<Plus size={14} />
					新建学习目标
				</Button>
			)}
		</div>
	);
}

export function CourseOverviewPanel({ courseId }: { courseId: string }) {
	const state = useStoreSnapshot(coursesStore, () => ({
		detail: coursesStore.detail,
		courseLearner: coursesStore.courseLearner,
		courseLearnerLoading: coursesStore.courseLearnerLoading,
		courseLearnerError: coursesStore.courseLearnerError,
		courseSettings: coursesStore.courseSettings,
		courseDaily: coursesStore.courseDaily,
		courseDailyLoading: coursesStore.courseDailyLoading,
		pendingAction: coursesStore.pendingAction,
		feedback: coursesStore.feedback,
	}));
	const [minutes, setMinutes] = useState("");
	const [minutesError, setMinutesError] = useState<string | null>(null);

	useEffect(() => {
		void coursesStore.loadCourseLearner(courseId);
		void coursesStore.loadCourseSettings(courseId);
		void coursesStore.loadCourseDaily(courseId);
	}, [courseId]);

	useEffect(() => {
		setMinutes(state.courseSettings?.daily_minutes ? String(state.courseSettings.daily_minutes) : "");
	}, [state.courseSettings?.daily_minutes]);

	const goals = state.courseLearner?.goals ?? [];
	const knowledge = state.courseLearner?.knowledge_states ?? [];
	const weak = useMemo(() => knowledge.filter(isWeak), [knowledge]);
	const boundGoalIds = useMemo(() => new Set(goals.map((goal) => goal.goal_id)), [goals]);
	const progress = state.courseDaily?.courses[0]?.task_progress ?? null;
	const busy = state.pendingAction !== null;

	const saveMinutes = async () => {
		const value = Number(minutes);
		if (!Number.isFinite(value) || value < 5 || value > 720) {
			setMinutesError("每日学习时间需要在 5–720 分钟之间。");
			return;
		}
		setMinutesError(null);
		await coursesStore.saveSettings(courseId, value);
	};

	return (
		<div className="mla-stack-lg">
			{state.feedback ? (
				<p role={state.feedback.tone === "success" ? "status" : "alert"} className={`mla-notice mla-notice--${state.feedback.tone}`}>
					{state.feedback.message}
				</p>
			) : null}

			{/* ── Goals ─────────────────────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>课程学习目标</h2>
						<span className="mla-small mla-muted">目标来自你的学习档案，课程只保存关联关系</span>
					</div>
				</div>
				{state.courseLearnerLoading && !state.courseLearner ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取学习目标…
					</p>
				) : state.courseLearnerError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.courseLearnerError}</p>
				) : goals.length === 0 ? (
					<div className="mla-empty">
						<Target size={26} aria-hidden="true" />
						<strong>还没有关联学习目标</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							关联目标后，AI 生成学习计划时会参考它；同一目标也可以服务于多门课程。
						</p>
					</div>
				) : (
					<div className="mla-state-list">
						{goals.map((goal) => (
							<div className="mla-state-row" key={goal.goal_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{goal.title}</strong>
										<span className="mla-badge">{goal.status === "active" ? "进行中" : goal.status === "completed" ? "已完成" : goal.status === "paused" ? "已暂停" : "已归档"}</span>
									</div>
									{goal.success_criteria.length > 0 ? (
										<p>完成标准：{goal.success_criteria.join("；")}</p>
									) : null}
								</div>
								<Button
									size="xs"
									disabled={busy}
									onClick={() => void coursesStore.unbindGoal(courseId, goal.goal_id)}
								>
									<Unlink size={14} />
									解除关联
								</Button>
							</div>
						))}
					</div>
				)}
				<BindGoal courseId={courseId} boundIds={boundGoalIds} />
			</section>

			{/* ── Study budget ──────────────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<h2>每日学习时间</h2>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					用于这门课程的每日任务预算。计划本身也带有一个预算，两者都来自服务端；未设置时使用系统默认值。
				</p>
				<div className="mla-inline">
					<Input
						type="number"
						min={5}
						max={720}
						step={5}
						aria-label="每日学习时间（分钟）"
						value={minutes}
						placeholder="未设置"
						style={{ width: 120 }}
						disabled={busy}
						onChange={(event) => setMinutes(event.target.value)}
					/>
					<span className="mla-small mla-muted">分钟 / 天</span>
					<Button disabled={busy} onClick={() => void saveMinutes()}>保存</Button>
				</div>
				{minutesError ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{minutesError}</p>
				) : null}
			</section>

			{/* ── Progress vs mastery ───────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>学习概况</h2>
						<span className="mla-small mla-muted">任务完成度与知识掌握度是两件不同的事</span>
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

				{state.courseDailyLoading && !state.courseDaily ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取任务进度…
					</p>
				) : null}

				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					完成任务不等于已经掌握：掌握状态只根据真实学习证据更新，前端不计算也不写入正式掌握度。
				</p>

				{knowledge.length === 0 ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						这门课程还没有产生带证据的知识点。完成一次练习或一次学习对话后，这里会显示服务端记录的掌握状态。
					</p>
				) : (
					<div className="mla-state-list">
						{knowledge.map((item) => (
							<div className="mla-state-row" key={item.concept_id}>
								<div style={{ minWidth: 0 }}>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<strong style={{ overflowWrap: "anywhere" }}>{item.concept_name || "知识点名称待确认"}</strong>
										<span className={`mla-badge${isWeak(item) ? " mla-badge--warning" : " mla-badge--success"}`}>
											{stateLabel(item)}
										</span>
										{item.review_due_at ? (
											<span className="mla-badge">复习 {formatDate(item.review_due_at)}</span>
										) : null}
									</div>
									{item.diagnosis ? <p>{item.diagnosis}</p> : null}
								</div>
								<span className="mla-small mla-muted">证据 {item.evidence_ids.length} 条</span>
							</div>
						))}
					</div>
				)}

				{state.courseLearner?.unclassified ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>
						另有 {state.courseLearner.unclassified.knowledge_states} 条知识点与 {state.courseLearner.unclassified.goals} 个目标没有课程归属。
						它们属于较早的记录或跨课程的个人档案，不会并入本课程的统计。
					</p>
				) : null}
			</section>

			{/* ── Shared preferences ────────────────────────────── */}
			<section className="mla-card">
				<div className="mla-card-header">
					<h2>教学偏好</h2>
					<span className="mla-badge">个人共享设置</span>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					讲解风格、练习偏好与反馈语气属于你的个人学习档案，对所有课程生效；这里只展示，不按课程修改。
				</p>
				{state.courseLearner?.preferences ? (
					<div className="mla-stack" style={{ gap: 8 }}>
						{([
							["讲解风格", state.courseLearner.preferences.explanation_style],
							["练习偏好", state.courseLearner.preferences.practice_style],
							["反馈语气", state.courseLearner.preferences.feedback_tone],
							["希望避免", state.courseLearner.preferences.avoid],
						] as const).map(([label, values]) => (
							<div className="mla-inline" key={label}>
								<span className="mla-small mla-muted">{label}：</span>
								{values.length === 0
									? <span className="mla-small mla-muted">未设置</span>
									: values.map((value) => <span className="mla-badge" key={value}>{value}</span>)}
							</div>
						))}
					</div>
				) : null}
			</section>
		</div>
	);
}
