import { useEffect, useMemo, useState } from "react";
import {
	CheckCircle2, ClipboardList, Loader2, Pencil, Plus, RefreshCw, Sparkles, Wand2,
} from "lucide-react";
import {
	Button, Dialog, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Textarea,
} from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore, planStatusLabel, type PlanListItem, type StudyPlan } from "../../stores/courses-store.js";
import type { PlanBasis, PlanSuggestion } from "../../api/courses.js";
import { PlanStructureEditor, toEditableStages, toStageDrafts, type EditableStage } from "./PlanStructureEditor.js";

/**
 * 学习计划 tab (E4.5c).
 *
 * Everything here is server state: the plan list, its revision and the
 * generated provenance come from `/api/courses/:id/plans*`. Draft edits and the
 * draft → active transition are compare-and-swap operations — a 409 re-reads the
 * plan (the store does it) and the page then shows the newer revision instead
 * of retrying blindly over it.
 */

const BASIS_LABEL: Record<PlanBasis, string> = {
	course_material: "基于课程教材",
	model_knowledge: "基于模型一般知识",
};

function formatDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return iso;
	return new Date(time).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function statusTone(status: StudyPlan["status"]): string {
	switch (status) {
		case "active": return "mla-badge mla-badge--accent";
		case "draft": return "mla-badge mla-badge--warning";
		case "completed": return "mla-badge mla-badge--success";
		default: return "mla-badge";
	}
}

function planProgress(plan: PlanListItem): number {
	if (plan.task_count === 0) return 0;
	return Math.round((plan.completed_task_count / plan.task_count) * 100);
}

/** Provenance of an AI draft: what it was grounded in, and what it was not. */
function GenerationNotes({ plan }: { plan: StudyPlan }) {
	const generation = plan.generation;
	if (!generation) return null;
	return (
		<div className="mla-generation">
			<div className="mla-inline" style={{ flexWrap: "wrap" }}>
				<span className="mla-badge mla-badge--accent">{BASIS_LABEL[generation.basis]}</span>
				{generation.model?.model ? <span className="mla-badge">模型：{generation.model.model}</span> : null}
				<span className="mla-badge">参考片段 {generation.units.length} / {generation.provided_units}</span>
			</div>
			<p className="mla-small" style={{ margin: 0 }}>{generation.material_note}</p>
			{generation.assumptions?.length ? (
				<div>
					<span className="mla-overline">生成假设</span>
					<ul className="mla-list" style={{ marginTop: 6 }}>
						{generation.assumptions.map((item) => <li key={item}><span>{item}</span></li>)}
					</ul>
				</div>
			) : null}
			{generation.uncertainties?.length ? (
				<div>
					<span className="mla-overline">不确定之处</span>
					<ul className="mla-list" style={{ marginTop: 6 }}>
						{generation.uncertainties.map((item) => <li key={item}><span>{item}</span></li>)}
					</ul>
				</div>
			) : null}
			{generation.units.length ? (
				<div>
					<span className="mla-overline">引用的教材位置</span>
					<ul className="mla-list" style={{ marginTop: 6 }}>
						{generation.units.map((unit) => (
							<li key={unit.unit_id}>
								<span>
									{unit.source_title}
									{unit.heading_path ? ` · ${unit.heading_path}` : ""}
									{unit.page_start !== undefined ? ` · P${unit.page_start}${unit.page_end && unit.page_end !== unit.page_start ? `–${unit.page_end}` : ""}` : ""}
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}

/** Manual creation form (plan + phases + tasks in one atomic POST). */
function CreatePlanDialog({
	open,
	pending,
	error,
	goalOptions,
	defaultMinutes,
	onClose,
	onCreate,
}: {
	open: boolean;
	pending: boolean;
	error: string | null;
	goalOptions: Array<{ goal_id: string; title: string }>;
	defaultMinutes: number;
	onClose: () => void;
	onCreate: (input: {
		title: string;
		description?: string;
		goal_id?: string | null;
		target_date?: string | null;
		daily_minutes?: number | null;
		stages: ReturnType<typeof toStageDrafts>;
	}) => Promise<boolean>;
}) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [minutes, setMinutes] = useState(String(defaultMinutes));
	const [targetDate, setTargetDate] = useState("");
	const [goalId, setGoalId] = useState<string>("");
	const [stages, setStages] = useState<EditableStage[]>([]);
	const [localError, setLocalError] = useState<string | null>(null);

	if (!open) return null;

	const submit = async () => {
		if (!title.trim()) {
			setLocalError("请填写计划名称。");
			return;
		}
		const minutesValue = Number(minutes);
		if (!Number.isFinite(minutesValue) || minutesValue < 5 || minutesValue > 720) {
			setLocalError("每日学习时间需要在 5–720 分钟之间。");
			return;
		}
		if (stages.some((stage) => !stage.title.trim() || stage.tasks.some((task) => !task.title.trim()))) {
			setLocalError("阶段和任务名称不能为空。");
			return;
		}
		setLocalError(null);
		const created = await onCreate({
			title: title.trim(),
			...(description.trim() ? { description: description.trim() } : {}),
			...(goalId ? { goal_id: goalId } : {}),
			...(targetDate ? { target_date: targetDate } : {}),
			daily_minutes: minutesValue,
			stages: toStageDrafts(stages),
		});
		if (created) {
			setTitle("");
			setDescription("");
			setStages([]);
			setTargetDate("");
		}
	};

	return (
		<Dialog label="手动创建学习计划" className="mla-dialog mla-dialog--wide" onClose={() => { if (!pending) onClose(); }}>
			<div className="mla-dialog-body">
				<h2>手动创建学习计划</h2>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					手动计划创建后直接启用。阶段与任务会一次性保存，任何一步失败都不会留下半份计划。
				</p>
				<div className="mla-form-grid">
					<label className="mla-field">
						<span>计划名称</span>
						<Input value={title} autoFocus maxLength={120} placeholder="例如：Python 基础 4 周" disabled={pending}
							onChange={(event) => setTitle(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>每日学习时间（分钟）</span>
						<Input type="number" min={5} max={720} step={5} value={minutes} disabled={pending}
							onChange={(event) => setMinutes(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>目标完成日期（可选）</span>
						<Input type="date" value={targetDate} disabled={pending}
							onChange={(event) => setTargetDate(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>关联学习目标（可选）</span>
						<Select value={goalId || "none"} disabled={pending} onValueChange={(value) => setGoalId(value === "none" ? "" : value)}>
							<SelectTrigger aria-label="关联学习目标"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectOption value="none" label="不关联目标" />
								{goalOptions.map((goal) => (
									<SelectOption key={goal.goal_id} value={goal.goal_id} label={goal.title} />
								))}
							</SelectContent>
						</Select>
					</label>
				</div>
				<label className="mla-field">
					<span>计划说明（可选）</span>
					<Textarea value={description} rows={2} maxLength={4000} disabled={pending}
						onChange={(event) => setDescription(event.target.value)} />
				</label>
				<div>
					<span className="mla-overline">学习阶段与任务</span>
					<div style={{ marginTop: 8 }}>
						<PlanStructureEditor stages={stages} onChange={setStages} disabled={pending} />
					</div>
				</div>
				{localError || error ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{localError ?? error}</p>
				) : null}
				<div className="mla-dialog-actions">
					<Button onClick={onClose} disabled={pending}>取消</Button>
					<Button variant="primary" disabled={pending} onClick={() => void submit()}>
						{pending ? "正在创建…" : "创建并启用"}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}

/** AI draft form: budget, basis and focus; the draft stays inactive. */
function GeneratePlanDialog({
	open,
	pending,
	error,
	hasMaterial,
	defaultMinutes,
	onClose,
	onGenerate,
}: {
	open: boolean;
	pending: boolean;
	error: string | null;
	hasMaterial: boolean;
	defaultMinutes: number;
	onClose: () => void;
	onGenerate: (input: { basis: PlanBasis; daily_minutes: number; target_date?: string; foundation?: string }) => Promise<boolean>;
}) {
	const [basis, setBasis] = useState<PlanBasis>(hasMaterial ? "course_material" : "model_knowledge");
	const [minutes, setMinutes] = useState(String(defaultMinutes));
	const [targetDate, setTargetDate] = useState("");
	const [foundation, setFoundation] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	if (!open) return null;

	const submit = async () => {
		const minutesValue = Number(minutes);
		if (!Number.isFinite(minutesValue) || minutesValue < 5 || minutesValue > 720) {
			setLocalError("每日学习时间需要在 5–720 分钟之间。");
			return;
		}
		setLocalError(null);
		const generated = await onGenerate({
			basis,
			daily_minutes: minutesValue,
			...(targetDate ? { target_date: targetDate } : {}),
			...(foundation.trim() ? { foundation: foundation.trim() } : {}),
		});
		if (generated) {
			setFoundation("");
			setTargetDate("");
		}
	};

	return (
		<Dialog label="AI 生成学习计划草稿" className="mla-dialog" onClose={() => { if (!pending) onClose(); }}>
			<div className="mla-dialog-body">
				<h2>AI 生成学习计划草稿</h2>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					生成的是草稿：会先展示生成依据、假设与不确定之处，由你确认后才会启用。
				</p>
				<label className="mla-field">
					<span>规划依据</span>
					<Select value={basis} disabled={pending} onValueChange={(value) => setBasis(value as PlanBasis)}>
						<SelectTrigger aria-label="规划依据"><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectOption value="course_material" label="基于课程教材（每个任务都引用教材位置）"
								disabled={!hasMaterial} />
							<SelectOption value="model_knowledge" label="基于模型一般知识（不引用教材）" />
						</SelectContent>
					</Select>
					{!hasMaterial ? (
						<span className="mla-small mla-muted">这门课程还没有可用的教材，只能按模型一般知识规划。</span>
					) : null}
				</label>
				<div className="mla-form-grid">
					<label className="mla-field">
						<span>每日学习时间（分钟）</span>
						<Input type="number" min={5} max={720} step={5} value={minutes} disabled={pending}
							onChange={(event) => setMinutes(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>目标完成日期（可选）</span>
						<Input type="date" value={targetDate} disabled={pending}
							onChange={(event) => setTargetDate(event.target.value)} />
					</label>
				</div>
				<label className="mla-field">
					<span>补充说明（可选）</span>
					<Textarea value={foundation} rows={2} maxLength={500} disabled={pending}
						placeholder="例如：我已经会基础语法，想重点练装饰器与异步。"
						onChange={(event) => setFoundation(event.target.value)} />
				</label>
				{localError || error ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{localError ?? error}</p>
				) : null}
				<div className="mla-dialog-actions">
					<Button onClick={onClose} disabled={pending}>取消</Button>
					<Button variant="primary" disabled={pending} onClick={() => void submit()}>
						{pending ? "正在生成…" : "生成草稿"}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}

/** Draft editor: whole-structure replace under the plan's current revision. */
function DraftEditor({
	plan,
	stages,
	tasks,
	disabled,
	onSave,
	onCancel,
}: {
	plan: StudyPlan;
	stages: Array<{ stage_id: string; title: string; description: string }>;
	tasks: Parameters<typeof toEditableStages>[1];
	disabled: boolean;
	onSave: (input: {
		title: string;
		description: string;
		stages: ReturnType<typeof toStageDrafts>;
		daily_minutes: number | null;
		target_date: string | null;
	}) => Promise<boolean>;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState(plan.title);
	const [description, setDescription] = useState(plan.description);
	const [minutes, setMinutes] = useState(plan.daily_minutes ? String(plan.daily_minutes) : "");
	const [targetDate, setTargetDate] = useState(plan.target_date ?? "");
	const [editable, setEditable] = useState<EditableStage[]>(() => toEditableStages(stages, tasks));
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		if (!title.trim()) {
			setError("计划名称不能为空。");
			return;
		}
		if (editable.some((stage) => !stage.title.trim() || stage.tasks.some((task) => !task.title.trim()))) {
			setError("阶段和任务名称不能为空。");
			return;
		}
		setError(null);
		const minutesValue = minutes.trim() === "" ? null : Number(minutes);
		if (minutesValue !== null && (!Number.isFinite(minutesValue) || minutesValue < 5 || minutesValue > 720)) {
			setError("每日学习时间需要在 5–720 分钟之间。");
			return;
		}
		const saved = await onSave({
			title: title.trim(),
			description,
			stages: toStageDrafts(editable),
			daily_minutes: minutesValue,
			target_date: targetDate || null,
		});
		if (saved) onCancel();
	};

	return (
		<div className="mla-plan-editor">
			<div className="mla-form-grid">
				<label className="mla-field">
					<span>计划名称</span>
					<Input value={title} maxLength={120} disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
				</label>
				<label className="mla-field">
					<span>每日学习时间（分钟）</span>
					<Input type="number" min={5} max={720} step={5} value={minutes} disabled={disabled}
						placeholder="未设置" onChange={(event) => setMinutes(event.target.value)} />
				</label>
				<label className="mla-field">
					<span>目标完成日期</span>
					<Input type="date" value={targetDate} disabled={disabled} onChange={(event) => setTargetDate(event.target.value)} />
				</label>
			</div>
			<label className="mla-field">
				<span>计划说明</span>
				<Textarea value={description} rows={2} maxLength={4000} disabled={disabled}
					onChange={(event) => setDescription(event.target.value)} />
			</label>
			<PlanStructureEditor stages={editable} onChange={setEditable} disabled={disabled} />
			{error ? <p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{error}</p> : null}
			<div className="mla-inline">
				<Button variant="primary" disabled={disabled} onClick={() => void save()}>保存草稿</Button>
				<Button disabled={disabled} onClick={onCancel}>取消编辑</Button>
				<span className="mla-small mla-muted">当前版本 #{plan.revision}；保存时以该版本校验，冲突会重新读取。</span>
			</div>
		</div>
	);
}

function SuggestionList({
	plan,
	suggestions,
	loading,
	error,
	disabled,
	onRefresh,
	onApply,
}: {
	plan: StudyPlan;
	suggestions: PlanSuggestion[];
	loading: boolean;
	error: string | null;
	disabled: boolean;
	onRefresh: () => void;
	onApply: (suggestion: PlanSuggestion) => void;
}) {
	return (
		<section className="mla-card">
			<div className="mla-card-header">
				<h2>计划调整建议</h2>
				<Button size="xs" disabled={disabled || loading} onClick={onRefresh}>
					<RefreshCw size={14} />
					重新获取
				</Button>
			</div>
			<p className="mla-small mla-muted" style={{ margin: 0 }}>
				建议只根据学习档案中的真实证据计算；应用前不会修改计划，也不会改变任务状态或知识掌握度。
			</p>
			{loading ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" />正在计算建议…
				</p>
			) : error ? (
				<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{error}</p>
			) : suggestions.length === 0 ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>暂时没有可应用的调整建议。</p>
			) : (
				<div className="mla-state-list">
					{suggestions.map((suggestion) => (
						<div className="mla-state-row" key={suggestion.suggestion_id}>
							<div>
								<div className="mla-inline" style={{ flexWrap: "wrap" }}>
									<strong>{suggestion.title}</strong>
									{suggestion.task_title ? <span className="mla-badge">任务：{suggestion.task_title}</span> : null}
								</div>
								<p>{suggestion.reason}</p>
								<p>{suggestion.changes}</p>
							</div>
							<Button
								size="xs"
								disabled={disabled}
								onClick={() => onApply(suggestion)}
							>
								应用
							</Button>
						</div>
					))}
				</div>
			)}
			<span className="mla-small mla-muted">应用时会以计划当前版本 #{plan.revision} 校验；过期建议会被拒绝并要求重新获取。</span>
		</section>
	);
}

export function CoursePlanPanel({ courseId }: { courseId: string }) {
	const state = useStoreSnapshot(coursesStore, () => ({
		plans: coursesStore.plans,
		plansLoading: coursesStore.plansLoading,
		plansError: coursesStore.plansError,
		planDetail: coursesStore.planDetail,
		planDetailLoading: coursesStore.planDetailLoading,
		planDetailError: coursesStore.planDetailError,
		suggestions: coursesStore.suggestions,
		suggestionsLoading: coursesStore.suggestionsLoading,
		suggestionsError: coursesStore.suggestionsError,
		sources: coursesStore.sources,
		courseLearner: coursesStore.courseLearner,
		courseSettings: coursesStore.courseSettings,
		pendingAction: coursesStore.pendingAction,
		feedback: coursesStore.feedback,
	}));

	const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [generateOpen, setGenerateOpen] = useState(false);
	const [confirming, setConfirming] = useState<PlanListItem | null>(null);

	useEffect(() => {
		void coursesStore.loadPlans(courseId);
		void coursesStore.loadSources(courseId);
		void coursesStore.loadCourseLearner(courseId);
		void coursesStore.loadCourseSettings(courseId);
	}, [courseId]);

	const activePlan = useMemo(() => state.plans.find((plan) => plan.status === "active") ?? null, [state.plans]);
	const selectedPlan = useMemo(
		() => state.plans.find((plan) => plan.plan_id === selectedPlanId) ?? null,
		[state.plans, selectedPlanId],
	);

	// Keep a selection valid after a reload: prefer the active plan, then a draft.
	useEffect(() => {
		if (selectedPlanId && state.plans.some((plan) => plan.plan_id === selectedPlanId)) return;
		const fallback = activePlan ?? state.plans.find((plan) => plan.status === "draft") ?? state.plans[0] ?? null;
		setSelectedPlanId(fallback ? fallback.plan_id : null);
	}, [state.plans, activePlan, selectedPlanId]);

	useEffect(() => {
		setEditing(false);
		if (!selectedPlanId) return;
		void coursesStore.loadPlanDetail(courseId, selectedPlanId);
		void coursesStore.loadSuggestions(courseId, selectedPlanId);
	}, [courseId, selectedPlanId]);

	const hasMaterial = state.sources.some((source) => source.source?.status === "indexed");
	const defaultMinutes = state.courseSettings?.daily_minutes ?? 30;
	const goalOptions = (state.courseLearner?.goals ?? []).map((goal) => ({ goal_id: goal.goal_id, title: goal.title }));
	const detail = state.planDetail && state.planDetail.plan.plan_id === selectedPlanId ? state.planDetail : null;
	const busy = Boolean(state.pendingAction);

	const confirm = async (plan: PlanListItem, replaceActive: boolean) => {
		const confirmed = await coursesStore.confirmPlan(courseId, plan.plan_id, plan.revision, replaceActive);
		setConfirming(null);
		if (confirmed) setSelectedPlanId(plan.plan_id);
	};

	return (
		<div className="mla-stack-lg">
			{state.feedback ? (
				<p
					role={state.feedback.tone === "success" ? "status" : "alert"}
					className={`mla-notice mla-notice--${state.feedback.tone}`}
				>
					{state.feedback.message}
				</p>
			) : null}

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>学习计划</h2>
					<div className="mla-inline">
						<Button size="xs" disabled={busy} onClick={() => setGenerateOpen(true)}>
							<Sparkles size={14} />
							AI 生成草稿
						</Button>
						<Button size="xs" variant="primary" disabled={busy} onClick={() => setCreateOpen(true)}>
							<Plus size={14} />
							手动创建
						</Button>
					</div>
				</div>

				{state.plansLoading && state.plans.length === 0 ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" />正在读取学习计划…
					</p>
				) : state.plansError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.plansError}</p>
				) : state.plans.length === 0 ? (
					<div className="mla-empty">
						<ClipboardList size={26} aria-hidden="true" />
						<strong>还没有学习计划</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							可以先手动创建一份计划，或让 AI 根据课程教材生成草稿，再由你确认启用。
						</p>
					</div>
				) : (
					<div className="mla-state-list">
						{state.plans.map((plan) => (
							<div className="mla-state-row" key={plan.plan_id}>
								<div>
									<div className="mla-inline" style={{ flexWrap: "wrap" }}>
										<button
											type="button"
											className="mla-link-button"
											aria-current={plan.plan_id === selectedPlanId ? "true" : undefined}
											onClick={() => setSelectedPlanId(plan.plan_id)}
										>
											{plan.title}
										</button>
										<span className={statusTone(plan.status)}>{planStatusLabel(plan.status)}</span>
										<span className="mla-badge">{plan.origin === "agent_suggested" ? "AI 草稿" : "手动创建"}</span>
										<span className="mla-badge">版本 #{plan.revision}</span>
									</div>
									<p>
										{plan.stage_count} 个阶段 · {plan.task_count} 个任务 · 已完成 {plan.completed_task_count} 个
										{plan.daily_minutes ? ` · 每日 ${plan.daily_minutes} 分钟` : ""}
										{plan.target_date ? ` · 目标日期 ${formatDate(plan.target_date)}` : ""}
									</p>
									<div className="mla-progress" aria-hidden="true">
										<span style={{ width: `${planProgress(plan)}%` }} />
									</div>
								</div>
								<div className="mla-inline" style={{ justifyContent: "flex-end" }}>
									{plan.status === "draft" ? (
										<Button
											size="xs"
											variant="primary"
											disabled={busy}
											onClick={() => {
												if (activePlan && activePlan.plan_id !== plan.plan_id) setConfirming(plan);
												else void confirm(plan, false);
											}}
										>
											<CheckCircle2 size={14} />
											确认启用
										</Button>
									) : null}
									{plan.status === "active" ? (
										<span className="mla-small mla-muted">启用中</span>
									) : null}
								</div>
							</div>
						))}
					</div>
				)}
			</section>

			{selectedPlan ? (
				<section className="mla-card">
					<div className="mla-card-header">
						<h2>{selectedPlan.title}</h2>
						<div className="mla-inline">
							{selectedPlan.status === "draft" ? (
								<Button size="xs" disabled={busy || editing} onClick={() => setEditing(true)}>
									<Pencil size={14} />
									编辑草稿
								</Button>
							) : null}
						</div>
					</div>
					{selectedPlan.description ? <p className="mla-text" style={{ margin: 0 }}>{selectedPlan.description}</p> : null}

					{selectedPlan.status === "draft" ? (
						<p className="mla-notice mla-notice--info">
							这是一份草稿：确认启用后才会出现在今日学习与每日推荐里。
						</p>
					) : null}

					{editing && detail ? (
						<DraftEditor
							key={`${selectedPlan.plan_id}:${selectedPlan.revision}`}
							plan={selectedPlan}
							stages={detail.stages}
							tasks={detail.tasks}
							disabled={busy}
							onCancel={() => setEditing(false)}
							onSave={async (input) => (await coursesStore.saveDraft(courseId, selectedPlan.plan_id, {
								expected_revision: selectedPlan.revision,
								...input,
							})) !== null}
						/>
					) : state.planDetailLoading ? (
						<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
							<Loader2 size={14} className="mla-spin" />正在读取计划内容…
						</p>
					) : state.planDetailError ? (
						<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.planDetailError}</p>
					) : detail ? (
						<div className="mla-stack" style={{ gap: 16 }}>
							<GenerationNotes plan={detail.plan} />
							{detail.stages.length === 0 && detail.tasks.length === 0 ? (
								<p className="mla-small mla-muted" style={{ margin: 0 }}>这份计划还没有阶段或任务。</p>
							) : (
								<div className="mla-stack" style={{ gap: 14 }}>
									{detail.stages.map((stage) => (
										<div key={stage.stage_id}>
											<div className="mla-inline">
												<h3 className="mla-plan-stage-title">{stage.title}</h3>
												<span className="mla-badge">
													{detail.tasks.filter((task) => task.stage_id === stage.stage_id).length} 个任务
												</span>
											</div>
											{stage.description ? (
												<p className="mla-small mla-muted" style={{ margin: "4px 0 0" }}>{stage.description}</p>
											) : null}
											<ul className="mla-task-list">
												{detail.tasks.filter((task) => task.stage_id === stage.stage_id).map((task) => (
													<li key={task.task_id}>
														<span>{task.title}</span>
														<span className="mla-small mla-muted">
															{task.estimated_minutes ?? 25} 分钟 · {task.status === "completed" ? "已完成" : task.status === "in_progress" ? "进行中" : "未开始"}
														</span>
													</li>
												))}
											</ul>
										</div>
									))}
									{detail.tasks.some((task) => !task.stage_id) ? (
										<div>
											<h3 className="mla-plan-stage-title">未分阶段任务</h3>
											<ul className="mla-task-list">
												{detail.tasks.filter((task) => !task.stage_id).map((task) => (
													<li key={task.task_id}>
														<span>{task.title}</span>
														<span className="mla-small mla-muted">{task.estimated_minutes ?? 25} 分钟</span>
													</li>
												))}
											</ul>
										</div>
									) : null}
								</div>
							)}
						</div>
					) : null}
				</section>
			) : null}

			{selectedPlan && selectedPlan.status === "active" ? (
				<SuggestionList
					plan={selectedPlan}
					suggestions={state.suggestions?.suggestions ?? []}
					loading={state.suggestionsLoading}
					error={state.suggestionsError}
					disabled={busy}
					onRefresh={() => void coursesStore.loadSuggestions(courseId, selectedPlan.plan_id)}
					onApply={(suggestion) => void coursesStore.applySuggestion(courseId, selectedPlan.plan_id, suggestion, selectedPlan.revision)}
				/>
			) : null}

			<CreatePlanDialog
				open={createOpen}
				pending={state.pendingAction === "create_plan"}
				error={coursesStore.feedback?.tone === "error" ? coursesStore.feedback.message : null}
				goalOptions={goalOptions}
				defaultMinutes={defaultMinutes}
				onClose={() => setCreateOpen(false)}
				onCreate={async (input) => {
					const created = await coursesStore.createPlan(courseId, input);
					if (!created) return false;
					setCreateOpen(false);
					const planId = "plan" in created ? created.plan.plan_id : created.plan_id;
					setSelectedPlanId(planId);
					return true;
				}}
			/>

			<GeneratePlanDialog
				open={generateOpen}
				pending={state.pendingAction === "generate_plan"}
				error={coursesStore.feedback?.tone === "error" ? coursesStore.feedback.message : null}
				hasMaterial={hasMaterial}
				defaultMinutes={defaultMinutes}
				onClose={() => setGenerateOpen(false)}
				onGenerate={async (input) => {
					const generated = await coursesStore.generatePlan(courseId, input);
					if (!generated) return false;
					setGenerateOpen(false);
					setSelectedPlanId(generated.plan.plan_id);
					return true;
				}}
			/>

			{confirming ? (
				<Dialog label="替换启用中的计划" className="mla-dialog" onClose={() => setConfirming(null)}>
					<div className="mla-dialog-body">
						<h2>替换启用中的计划？</h2>
						<p className="mla-text" style={{ margin: 0 }}>
							这门课程已经有启用中的计划「{activePlan?.title}」。确认启用「{confirming.title}」后，原计划会被归档，课程的任务与每日推荐将改用新计划。
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							已完成的作业记录与学习会话不会被删除。
						</p>
						<div className="mla-dialog-actions">
							<Button onClick={() => setConfirming(null)}>取消</Button>
							<Button variant="primary" disabled={busy} onClick={() => void confirm(confirming, true)}>
								替换并启用
							</Button>
						</div>
					</div>
				</Dialog>
			) : null}
		</div>
	);
}
