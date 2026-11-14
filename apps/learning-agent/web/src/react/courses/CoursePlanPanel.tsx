import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
	Archive, CheckCircle2, ClipboardList, Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2, Wand2,
} from "lucide-react";
import {
	Button, Dialog, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Textarea,
} from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore, type PlanListItem, type StudyPlan } from "../../stores/courses-store.js";
import type { PlanBasis, PlanSuggestion } from "../../api/courses.js";
import { navigate } from "../shell/navigation.js";
import { PlanStructureEditor, toEditableStages, toStageDrafts, type EditableStage } from "./PlanStructureEditor.js";
import { DeletionDialog, type DeletionTarget } from "./DeletionDialog.js";

/**
 * 学习计划 tab (E4.5c).
 *
 * Everything here is server state: the plan list, its revision and the
 * generated provenance come from `/api/courses/:id/plans*`. Draft edits and the
 * draft → active transition are compare-and-swap operations — a 409 re-reads the
 * plan (the store does it) and the page then shows the newer revision instead
 * of retrying blindly over it.
 */

const BASIS_LABEL_KEY: Record<PlanBasis, string> = {
	course_material: "course.basis.course_material",
	model_knowledge: "course.basis.model_knowledge",
};

const PLAN_STATUS_LABEL_KEY: Record<StudyPlan["status"], string> = {
	draft: "course.planStatus.draft",
	active: "course.planStatus.active",
	completed: "course.planStatus.completed",
	archived: "course.planStatus.archived",
};

const PLAN_ORIGIN_LABEL_KEY: Record<PlanListItem["origin"], string> = {
	agent_suggested: "course.origin.agent_suggested",
	user: "course.origin.user",
};

/** Row meta line: counts first, then the optional budget and target date. */
function planMeta(plan: PlanListItem, t: TFunction): string {
	const parts = [t("course.plan.counts", {
		stages: plan.stage_count,
		tasks: plan.task_count,
		completed: plan.completed_task_count,
	})];
	if (plan.daily_minutes) parts.push(t("course.plan.dailyMinutes", { minutes: plan.daily_minutes }));
	if (plan.target_date) parts.push(t("course.plan.targetDateLine", { date: formatDate(plan.target_date) }));
	return parts.join(" · ");
}

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

/**
 * E4.7 — a plan holds learning history once one of its tasks left `pending`.
 *
 * That is the same rule the server applies before refusing a delete, so the
 * buttons offered here and the 409 that would come back cannot disagree.
 * `completed_task_count` is the fallback for a list payload cached before the
 * counter existed.
 */
function planHasRecords(plan: PlanListItem): boolean {
	return (plan.started_task_count ?? plan.completed_task_count) > 0;
}

/** Provenance of an AI draft: what it was grounded in, and what it was not. */
function GenerationNotes({ plan }: { plan: StudyPlan }) {
	const { t } = useTranslation();
	const generation = plan.generation;
	if (!generation) return null;
	return (
		<div className="mla-generation">
			<div className="mla-inline" style={{ flexWrap: "wrap" }}>
				<span className="mla-badge mla-badge--accent">{t(BASIS_LABEL_KEY[generation.basis])}</span>
				{generation.model?.model ? (
					<span className="mla-badge">{t("course.plan.model", { model: generation.model.model })}</span>
				) : null}
				<span className="mla-badge">
					{t("course.plan.referencedUnits", {
						used: generation.units.length,
						total: generation.provided_units,
					})}
				</span>
			</div>
			<p className="mla-small" style={{ margin: 0 }}>{generation.material_note}</p>
			{generation.assumptions?.length ? (
				<div>
					<span className="mla-overline">{t("course.plan.assumptions")}</span>
					<ul className="mla-list" style={{ marginTop: 6 }}>
						{generation.assumptions.map((item) => <li key={item}><span>{item}</span></li>)}
					</ul>
				</div>
			) : null}
			{generation.uncertainties?.length ? (
				<div>
					<span className="mla-overline">{t("course.plan.uncertainties")}</span>
					<ul className="mla-list" style={{ marginTop: 6 }}>
						{generation.uncertainties.map((item) => <li key={item}><span>{item}</span></li>)}
					</ul>
				</div>
			) : null}
			{generation.units.length ? (
				<div>
					<span className="mla-overline">{t("course.plan.citedLocations")}</span>
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
	const { t } = useTranslation();
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
			setLocalError(t("course.plan.errors.titleRequired"));
			return;
		}
		const minutesValue = Number(minutes);
		if (!Number.isFinite(minutesValue) || minutesValue < 5 || minutesValue > 720) {
			setLocalError(t("course.plan.errors.minutesRange"));
			return;
		}
		if (stages.some((stage) => !stage.title.trim() || stage.tasks.some((task) => !task.title.trim()))) {
			setLocalError(t("course.plan.errors.stageTaskRequired"));
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
		<Dialog label={t("course.plan.createTitle")} className="mla-dialog mla-dialog--wide" onClose={() => { if (!pending) onClose(); }}>
			<div className="mla-dialog-body">
				<h2>{t("course.plan.createTitle")}</h2>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.plan.createHint")}
				</p>
				<div className="mla-form-grid">
					<label className="mla-field">
						<span>{t("course.plan.nameLabel")}</span>
						<Input value={title} autoFocus maxLength={120} placeholder={t("course.plan.namePlaceholder")} disabled={pending}
							onChange={(event) => setTitle(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>{t("course.plan.minutesLabel")}</span>
						<Input type="number" min={5} max={720} step={5} value={minutes} disabled={pending}
							onChange={(event) => setMinutes(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>{t("course.plan.targetDateOptional")}</span>
						<Input type="date" value={targetDate} disabled={pending}
							onChange={(event) => setTargetDate(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>{t("course.plan.bindGoalOptional")}</span>
						<Select value={goalId || "none"} disabled={pending} onValueChange={(value) => setGoalId(value === "none" ? "" : value)}>
							<SelectTrigger aria-label={t("course.plan.bindGoalAria")}><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectOption value="none" label={t("course.plan.noGoal")} />
								{goalOptions.map((goal) => (
									<SelectOption key={goal.goal_id} value={goal.goal_id} label={goal.title} />
								))}
							</SelectContent>
						</Select>
					</label>
				</div>
				<label className="mla-field">
					<span>{t("course.plan.descriptionOptional")}</span>
					<Textarea value={description} rows={2} maxLength={4000} disabled={pending}
						onChange={(event) => setDescription(event.target.value)} />
				</label>
				<div>
					<span className="mla-overline">{t("course.plan.stagesAndTasks")}</span>
					<div style={{ marginTop: 8 }}>
						<PlanStructureEditor stages={stages} onChange={setStages} disabled={pending} />
					</div>
				</div>
				{localError || error ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{localError ?? error}</p>
				) : null}
				<div className="mla-dialog-actions">
					<Button onClick={onClose} disabled={pending}>{t("course.plan.cancel")}</Button>
					<Button variant="primary" disabled={pending} onClick={() => void submit()}>
						{pending ? t("course.plan.creating") : t("course.plan.createAndActivate")}
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
	const { t } = useTranslation();
	const [basis, setBasis] = useState<PlanBasis>(hasMaterial ? "course_material" : "model_knowledge");
	const [minutes, setMinutes] = useState(String(defaultMinutes));
	const [targetDate, setTargetDate] = useState("");
	const [foundation, setFoundation] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	// `hasMaterial` is false while the source list is still loading, so a
	// mount-time default would silently pick "model general knowledge" for a
	// course that does have indexed material. Follow the loaded answer until the
	// learner picks a basis themselves.
	const [basisChosen, setBasisChosen] = useState(false);
	useEffect(() => {
		if (!open || basisChosen) return;
		setBasis(hasMaterial ? "course_material" : "model_knowledge");
	}, [open, hasMaterial, basisChosen]);

	if (!open) return null;

	const submit = async () => {
		const minutesValue = Number(minutes);
		if (!Number.isFinite(minutesValue) || minutesValue < 5 || minutesValue > 720) {
			setLocalError(t("course.plan.errors.minutesRange"));
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
		<Dialog label={t("course.plan.generateTitle")} className="mla-dialog" onClose={() => { if (!pending) onClose(); }}>
			<div className="mla-dialog-body">
				<h2>{t("course.plan.generateTitle")}</h2>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.plan.generateHint")}
				</p>
				<label className="mla-field">
					<span>{t("course.plan.basisLabel")}</span>
					<Select value={basis} disabled={pending} onValueChange={(value) => { setBasisChosen(true); setBasis(value as PlanBasis); }}>
						<SelectTrigger aria-label={t("course.plan.basisLabel")}><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectOption value="course_material" label={t("course.plan.basisMaterial")}
								disabled={!hasMaterial} />
							<SelectOption value="model_knowledge" label={t("course.plan.basisModel")} />
						</SelectContent>
					</Select>
					{!hasMaterial ? (
						<span className="mla-small mla-muted">{t("course.plan.noMaterial")}</span>
					) : null}
				</label>
				<div className="mla-form-grid">
					<label className="mla-field">
						<span>{t("course.plan.minutesLabel")}</span>
						<Input type="number" min={5} max={720} step={5} value={minutes} disabled={pending}
							onChange={(event) => setMinutes(event.target.value)} />
					</label>
					<label className="mla-field">
						<span>{t("course.plan.targetDateOptional")}</span>
						<Input type="date" value={targetDate} disabled={pending}
							onChange={(event) => setTargetDate(event.target.value)} />
					</label>
				</div>
				<label className="mla-field">
					<span>{t("course.plan.foundationOptional")}</span>
					<Textarea value={foundation} rows={2} maxLength={500} disabled={pending}
						placeholder={t("course.plan.foundationPlaceholder")}
						onChange={(event) => setFoundation(event.target.value)} />
				</label>
				{localError || error ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{localError ?? error}</p>
				) : null}
				<div className="mla-dialog-actions">
					<Button onClick={onClose} disabled={pending}>{t("course.plan.cancel")}</Button>
					<Button variant="primary" disabled={pending} onClick={() => void submit()}>
						{pending ? t("course.plan.generating") : t("course.plan.generateDraft")}
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
	const { t } = useTranslation();
	const [title, setTitle] = useState(plan.title);
	const [description, setDescription] = useState(plan.description);
	const [minutes, setMinutes] = useState(plan.daily_minutes ? String(plan.daily_minutes) : "");
	const [targetDate, setTargetDate] = useState(plan.target_date ?? "");
	const [editable, setEditable] = useState<EditableStage[]>(() => toEditableStages(stages, tasks));
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		if (!title.trim()) {
			setError(t("course.plan.errors.draftTitleRequired"));
			return;
		}
		if (editable.some((stage) => !stage.title.trim() || stage.tasks.some((task) => !task.title.trim()))) {
			setError(t("course.plan.errors.stageTaskRequired"));
			return;
		}
		setError(null);
		const minutesValue = minutes.trim() === "" ? null : Number(minutes);
		if (minutesValue !== null && (!Number.isFinite(minutesValue) || minutesValue < 5 || minutesValue > 720)) {
			setError(t("course.plan.errors.minutesRange"));
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
					<span>{t("course.plan.nameLabel")}</span>
					<Input value={title} maxLength={120} disabled={disabled} onChange={(event) => setTitle(event.target.value)} />
				</label>
				<label className="mla-field">
					<span>{t("course.plan.minutesLabel")}</span>
					<Input type="number" min={5} max={720} step={5} value={minutes} disabled={disabled}
						placeholder={t("course.plan.unset")} onChange={(event) => setMinutes(event.target.value)} />
				</label>
				<label className="mla-field">
					<span>{t("course.plan.targetDate")}</span>
					<Input type="date" value={targetDate} disabled={disabled} onChange={(event) => setTargetDate(event.target.value)} />
				</label>
			</div>
			<label className="mla-field">
				<span>{t("course.plan.descriptionLabel")}</span>
				<Textarea value={description} rows={2} maxLength={4000} disabled={disabled}
					onChange={(event) => setDescription(event.target.value)} />
			</label>
			<PlanStructureEditor stages={editable} onChange={setEditable} disabled={disabled} />
			{error ? <p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{error}</p> : null}
			<div className="mla-inline">
				<Button variant="primary" disabled={disabled} onClick={() => void save()}>{t("course.plan.saveDraft")}</Button>
				<Button disabled={disabled} onClick={onCancel}>{t("course.plan.cancelEdit")}</Button>
				<span className="mla-small mla-muted">{t("course.plan.revisionNote", { revision: plan.revision })}</span>
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
	const { t } = useTranslation();
	return (
		<section className="mla-card">
			<div className="mla-card-header">
				<h2>{t("course.plan.suggestionsTitle")}</h2>
				<Button size="xs" disabled={disabled || loading} onClick={onRefresh}>
					<RefreshCw size={14} />
					{t("course.plan.refreshSuggestions")}
				</Button>
			</div>
			<p className="mla-small mla-muted" style={{ margin: 0 }}>
				{t("course.plan.suggestionsHint")}
			</p>
			{loading ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" />{t("course.plan.suggestionsLoading")}
				</p>
			) : error ? (
				<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{error}</p>
			) : suggestions.length === 0 ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>{t("course.plan.suggestionsEmpty")}</p>
			) : (
				<div className="mla-state-list">
					{suggestions.map((suggestion) => (
						<div className="mla-state-row" key={suggestion.suggestion_id}>
							<div>
								<div className="mla-inline" style={{ flexWrap: "wrap" }}>
									<strong>{suggestion.title}</strong>
									{suggestion.task_title ? (
										<span className="mla-badge">{t("course.plan.suggestionTask", { task: suggestion.task_title })}</span>
									) : null}
								</div>
								<p>{suggestion.reason}</p>
								<p>{suggestion.changes}</p>
							</div>
							<Button
								size="xs"
								disabled={disabled}
								onClick={() => onApply(suggestion)}
							>
								{t("course.plan.applySuggestion")}
							</Button>
						</div>
					))}
				</div>
			)}
			<span className="mla-small mla-muted">{t("course.plan.suggestionsRevisionNote", { revision: plan.revision })}</span>
		</section>
	);
}

export function CoursePlanPanel({ courseId }: { courseId: string }) {
	const { t } = useTranslation();
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
		courseStatus: coursesStore.detail?.course.status ?? null,
		pendingAction: coursesStore.pendingAction,
		feedback: coursesStore.feedback,
	}));

	const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
	/**
	 * Which plan's draft editor is open.
	 *
	 * Not a boolean: the row's 「编辑」 selects the plan and asks for the editor
	 * in the same click, and the selection effect below must only close an
	 * editor that belongs to a plan the learner has actually left.
	 */
	const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [generateOpen, setGenerateOpen] = useState(false);
	const [confirming, setConfirming] = useState<PlanListItem | null>(null);
	const [deletionTarget, setDeletionTarget] = useState<DeletionTarget | null>(null);

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
		// Close the editor only when the selection moved to another plan. A row
		// click that selects *and* edits the same plan must survive this effect.
		setEditingPlanId((current) => (current !== null && current !== selectedPlanId ? null : current));
		if (!selectedPlanId) return;
		void coursesStore.loadPlanDetail(courseId, selectedPlanId);
		void coursesStore.loadSuggestions(courseId, selectedPlanId);
	}, [courseId, selectedPlanId]);

	const hasMaterial = state.sources.some((source) => source.source?.status === "indexed");
	const defaultMinutes = state.courseSettings?.daily_minutes ?? 30;
	const editing = editingPlanId !== null && editingPlanId === selectedPlanId;
	const goalOptions = (state.courseLearner?.goals ?? []).map((goal) => ({ goal_id: goal.goal_id, title: goal.title }));
	const detail = state.planDetail && state.planDetail.plan.plan_id === selectedPlanId ? state.planDetail : null;
	const busy = Boolean(state.pendingAction);
	// E4.7-R1: an archived course is read-only for learning progress. The server
	// refuses confirmation and task progress; disabling them here explains why
	// instead of letting the learner click into a 409.
	const courseArchived = state.courseStatus === "archived";

	const confirm = async (plan: PlanListItem, replaceActive: boolean) => {
		const confirmed = await coursesStore.confirmPlan(courseId, plan.plan_id, plan.revision, replaceActive);
		setConfirming(null);
		if (confirmed) setSelectedPlanId(plan.plan_id);
	};

	/** 查看记录 is a real page, not a toast: archived plans keep their history there. */
	const openRecords = () => {
		navigate("course", { history: "push", course: { id: courseId, view: "records" } });
	};

	const archivePlan = async (plan: PlanListItem) => coursesStore.archivePlan(courseId, plan.plan_id);

	return (
		<div className="mla-stack-lg">
			{courseArchived ? (
				<p className="mla-notice mla-notice--info" role="status">
					{t("course.plan.archivedNotice")}
				</p>
			) : null}
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
					<h2>{t("course.plan.title")}</h2>
					<div className="mla-inline">
						{/* E4.6b: a dialog renders `coursesStore.feedback` as its own error, so
						    an error left by the *other* dialog (or by any earlier action) would
						    appear inside the freshly opened one — "模型调用失败" showing up in
						    the manual-create form, which never calls the model. Clear the
						    shared notice on open: each dialog starts with only its own result. */}
						<Button size="xs" disabled={busy} onClick={() => { coursesStore.clearFeedback(); setGenerateOpen(true); }}>
							<Sparkles size={14} />
							{t("course.plan.generateButton")}
						</Button>
						<Button size="xs" variant="primary" disabled={busy} onClick={() => { coursesStore.clearFeedback(); setCreateOpen(true); }}>
							<Plus size={14} />
							{t("course.plan.createButton")}
						</Button>
					</div>
				</div>

				{state.plansLoading && state.plans.length === 0 ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" />{t("course.plan.loading")}
					</p>
				) : state.plansError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.plansError}</p>
				) : state.plans.length === 0 ? (
					<div className="mla-empty">
						<ClipboardList size={26} aria-hidden="true" />
						<strong>{t("course.plan.emptyTitle")}</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							{t("course.plan.emptyHint")}
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
										<span className={statusTone(plan.status)}>{t(PLAN_STATUS_LABEL_KEY[plan.status])}</span>
										<span className="mla-badge">{t(PLAN_ORIGIN_LABEL_KEY[plan.origin])}</span>
										<span className="mla-badge">{t("course.plan.version", { revision: plan.revision })}</span>
									</div>
									<p>{planMeta(plan, t)}</p>
									<div className="mla-progress" aria-hidden="true">
										<span style={{ width: `${planProgress(plan)}%` }} />
									</div>
								</div>
								<div className="mla-inline" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
									{plan.status === "draft" ? (
										<>
											<Button
												size="xs"
												disabled={busy}
												onClick={() => {
													setSelectedPlanId(plan.plan_id);
													setEditingPlanId(plan.plan_id);
												}}
											>
												<Pencil size={14} />
												{t("course.plan.edit")}
											</Button>
											<Button
												size="xs"
												variant="primary"
												disabled={busy || courseArchived}
												title={courseArchived ? t("course.plan.archivedEnableHint") : undefined}
												onClick={() => {
													if (activePlan && activePlan.plan_id !== plan.plan_id) setConfirming(plan);
													else void confirm(plan, false);
												}}
											>
												<CheckCircle2 size={14} />
												{t("course.plan.confirm")}
											</Button>
											<Button
												size="xs"
												variant="danger"
												disabled={busy}
												onClick={() => setDeletionTarget({
													kind: "plan",
													courseId,
													planId: plan.plan_id,
													title: plan.title,
												})}
											>
												<Trash2 size={14} />
												{t("course.plan.delete")}
											</Button>
										</>
									) : plan.status === "active" ? (
										<>
											{planHasRecords(plan) ? (
												<Button size="xs" onClick={openRecords}>{t("course.plan.viewRecords")}</Button>
											) : (
												<Button
													size="xs"
													variant="danger"
													disabled={busy}
													onClick={() => setDeletionTarget({
														kind: "plan",
														courseId,
														planId: plan.plan_id,
														title: plan.title,
													})}
												>
													<Trash2 size={14} />
													{t("course.plan.delete")}
												</Button>
											)}
											<Button size="xs" disabled={busy} onClick={() => void archivePlan(plan)}>
												<Archive size={14} />
												{t("course.plan.archive")}
											</Button>
										</>
									) : (
										<>
											{plan.status === "completed" ? (
												<Button size="xs" disabled={busy} onClick={() => void archivePlan(plan)}>
													<Archive size={14} />
													{t("course.plan.archive")}
												</Button>
											) : null}
											<Button size="xs" onClick={openRecords}>{t("course.plan.viewRecords")}</Button>
											{/* E4.7-R1: an archived plan with no started task holds no
											    learning history — the server accepts its deletion, so the
											    entry must exist here too. A completed plan keeps no
											    delete: completion itself is a decision to preserve. */}
											{plan.status === "archived" && !planHasRecords(plan) ? (
												<Button
													size="xs"
													variant="danger"
													disabled={busy}
													onClick={() => setDeletionTarget({
														kind: "plan",
														courseId,
														planId: plan.plan_id,
														title: plan.title,
													})}
												>
													<Trash2 size={14} />
													{t("course.plan.delete")}
												</Button>
											) : null}
										</>
									)}
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
								<Button size="xs" disabled={busy || editing} onClick={() => setEditingPlanId(selectedPlan.plan_id)}>
									<Pencil size={14} />
										{t("course.plan.editDraft")}
								</Button>
							) : null}
						</div>
					</div>
					{selectedPlan.description ? <p className="mla-text" style={{ margin: 0 }}>{selectedPlan.description}</p> : null}

					{selectedPlan.status === "draft" ? (
						<p className="mla-notice mla-notice--info">
							{t("course.plan.draftNotice")}
						</p>
					) : null}

					{editing && detail ? (
						<DraftEditor
							key={`${selectedPlan.plan_id}:${selectedPlan.revision}`}
							plan={selectedPlan}
							stages={detail.stages}
							tasks={detail.tasks}
							disabled={busy}
							onCancel={() => setEditingPlanId(null)}
							onSave={async (input) => (await coursesStore.saveDraft(courseId, selectedPlan.plan_id, {
								expected_revision: selectedPlan.revision,
								...input,
							})) !== null}
						/>
					) : state.planDetailLoading ? (
						<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
							<Loader2 size={14} className="mla-spin" />{t("course.plan.detailLoading")}
						</p>
					) : state.planDetailError ? (
						<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.planDetailError}</p>
					) : detail ? (
						<div className="mla-stack" style={{ gap: 16 }}>
							<GenerationNotes plan={detail.plan} />
							{detail.stages.length === 0 && detail.tasks.length === 0 ? (
								<p className="mla-small mla-muted" style={{ margin: 0 }}>{t("course.plan.noStages")}</p>
							) : (
								<div className="mla-stack" style={{ gap: 14 }}>
									{detail.stages.map((stage) => (
										<div key={stage.stage_id}>
											<div className="mla-inline">
												<h3 className="mla-plan-stage-title">{stage.title}</h3>
												<span className="mla-badge">
													{t("course.plan.stageTaskCount", { count: detail.tasks.filter((task) => task.stage_id === stage.stage_id).length })}
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
															{t("course.card.minutes", { count: task.estimated_minutes ?? 25 })} · {t(`course.task.${task.status}`)}
														</span>
													</li>
												))}
											</ul>
										</div>
									))}
									{detail.tasks.some((task) => !task.stage_id) ? (
										<div>
											<h3 className="mla-plan-stage-title">{t("course.plan.unstagedTasks")}</h3>
											<ul className="mla-task-list">
												{detail.tasks.filter((task) => !task.stage_id).map((task) => (
													<li key={task.task_id}>
														<span>{task.title}</span>
														<span className="mla-small mla-muted">{t("course.card.minutes", { count: task.estimated_minutes ?? 25 })}</span>
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
				<Dialog label={t("course.plan.replaceLabel")} className="mla-dialog" onClose={() => setConfirming(null)}>
					<div className="mla-dialog-body">
						<h2>{t("course.plan.replaceTitle")}</h2>
						<p className="mla-text" style={{ margin: 0 }}>
							{t("course.plan.replaceBody", { active: activePlan?.title, next: confirming.title })}
						</p>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							{t("course.plan.replaceKeep")}
						</p>
						<div className="mla-dialog-actions">
							<Button onClick={() => setConfirming(null)}>{t("course.plan.cancel")}</Button>
							<Button variant="primary" disabled={busy} onClick={() => void confirm(confirming, true)}>{t("course.plan.replaceConfirm")}</Button>
						</div>
					</div>
				</Dialog>
			) : null}

			{/* E4.7: a plan delete is confirmed against the server's own counts and
			    blockers; a plan with records is offered archiving instead. */}
			<DeletionDialog
				target={deletionTarget}
				onClose={() => setDeletionTarget(null)}
				onArchive={async () => (deletionTarget?.kind === "plan"
					? coursesStore.archivePlan(courseId, deletionTarget.planId)
					: false)}
			/>
		</div>
	);
}
