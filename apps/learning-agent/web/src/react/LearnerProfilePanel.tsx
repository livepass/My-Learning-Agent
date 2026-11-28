import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeState } from "../types/learner.js";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../i18n/index.js";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { Spinner } from "./ui/Spinner.js";
import { learnerStore } from "../stores/learner-store.js";
import type {
	GoalStatus,
	GoalType,
	LearningGoal,
	Misconception,
	MisconceptionStatus,
} from "../types/learner.js";
import { useStoreSnapshot } from "./hooks.js";
import { useKnowledgeDraftGuard, useOpenKnowledgeEditors } from "./profile/KnowledgeDraftGuard.js";
import { KnowledgeList } from "./profile/KnowledgeList.js";
import { KnowledgeStateFilters } from "./profile/KnowledgeStateFilters.js";
import {
	DEFAULT_KNOWLEDGE_FILTER,
	countKnowledgeFilters,
	filterKnowledgeStates,
	type KnowledgeFilter,
} from "./profile/knowledge-filter.js";
import {
	formatGoalPriority,
	goalEditingBaseline,
	goalPatchFromDraft,
	goalPriorityLine,
	priorityForSlider,
} from "./profile/knowledge-provenance.js";
import { ProfileConclusion } from "./profile/ProfileConclusion.js";
import { WeakKnowledgeSection } from "./profile/WeakKnowledgeSection.js";
import { deriveProfileOverview, type ProfileOverview } from "./profile/profile-overview.js";
import { Button, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Textarea } from "./ui/index.js";

const GOAL_TYPES: GoalType[] = ["skill", "concept", "project", "exam", "habit"];
const GOAL_STATUSES: GoalStatus[] = ["active", "paused", "completed", "archived"];
const MISC_STATUSES: MisconceptionStatus[] = ["active", "repairing", "resolved", "stale"];

/**
 * Whether the overview may draw a conclusion from the current `profile`
 * (E4.9i-P2-3).
 *
 * `load()` keeps the previous profile when a read fails, and it does not clear
 * it while a new read is in flight. So "there is a profile" is not the same as
 * "this is the result of the latest read":
 *
 * - `loading`    — first read, nothing to show yet;
 * - `refreshing` — a read is in flight over data already on screen;
 * - `failed`     — the last read failed; the data on screen is the last success;
 * - `ready`      — the profile is the result of the most recent successful read.
 */
type ConclusionsState = "loading" | "refreshing" | "failed" | "ready";

function conclusionsStateFor({
	hasProfile,
	isLoading,
	error,
}: {
	hasProfile: boolean;
	isLoading: boolean;
	error: string | null;
}): ConclusionsState {
	if (error) return "failed";
	if (!hasProfile) return "loading";
	return isLoading ? "refreshing" : "ready";
}

function formatDate(iso?: string): string {
	if (!iso) return "-";
	try {
		return new Date(iso).toLocaleString(currentLocale(), {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

function Section({
	title,
	children,
	action,
	count,
	defaultCollapsed = false,
	onBeforeCollapse,
}: {
	title: string;
	children: React.ReactNode;
	action?: React.ReactNode;
	count?: number;
	defaultCollapsed?: boolean;
	/**
	 * E4.9i-P2-2-R1: asked before this section collapses.
	 *
	 * Only the knowledge section passes it. A collapse unmounts the editors
	 * inside, so it needs the same verdict as every other exit — a save in
	 * flight refuses, a dirty draft asks once for the whole section.
	 */
	onBeforeCollapse?: () => boolean;
}) {
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	const toggle = () => {
		if (!collapsed && onBeforeCollapse && !onBeforeCollapse()) return;
		setCollapsed(!collapsed);
	};
	return (
		<section className="overflow-hidden rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)]">
			<div className="flex items-center gap-2 px-[18px] py-[15px]">
				<button
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={toggle}
					aria-expanded={!collapsed}
				>
					<ChevronDown
						size={16}
						className={`shrink-0 text-[var(--inno-text-muted)] transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
					/>
					<h4 className="truncate text-[14.5px] font-semibold text-[var(--inno-text)]">{title}</h4>
					{typeof count === "number" ? (
						<span className="rounded-[10px] bg-[var(--inno-accent-soft)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--inno-accent)]">
							{count}
						</span>
					) : null}
				</button>
				{!collapsed && action ? <div className="shrink-0">{action}</div> : null}
			</div>
			<AnimatePresence initial={false}>
				{!collapsed ? (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.2, ease: "easeOut" }}
						style={{ overflow: "hidden" }}
					>
						<div className="px-[18px] pb-[18px] pt-1">{children}</div>
					</motion.div>
				) : null}
			</AnimatePresence>
		</section>
	);
}

/**
 * 概览 — stats plus the learner's profile summary.
 *
 * The summary is a **reading card** by default: the panel is for understanding
 * what the system knows, not for editing prose, and a bare textarea made an
 * empty profile look like an unfinished form. Editing is an explicit step
 * (「编辑摘要」), and only then does the textarea appear.
 *
 * `patchSummary()` and the dirty-buffer rules are unchanged: while the buffer
 * is dirty it is never overwritten by a store refresh, cancel restores the
 * saved text, and a failed save keeps the editor open with its text.
 *
 * E4.9i-P2-3: the four tiles and the new conclusion now read from one
 * `ProfileOverview`, so the sentence and the numbers beside it cannot disagree.
 * The conclusion is withheld unless `conclusionsState` is `ready` — while a
 * refresh is in flight or after it failed, the last successful data is still on
 * screen, and it must not be described as a current conclusion.
 */
function SummarySection({ overview, conclusionsState }: { overview: ProfileOverview; conclusionsState: ConclusionsState }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({
		profile: learnerStore.profile,
		isSaving: learnerStore.isSaving,
	}));
	const [buffer, setBuffer] = useState("");
	const [dirty, setDirty] = useState(false);
	const [editing, setEditing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		if (!dirty) setBuffer(state.profile?.profile_summary ?? "");
	}, [state.profile?.profile_summary, dirty]);

	// Grow with the content instead of showing a resize handle: the editor is a
	// prose field, and a fixed box either clips long summaries or wastes space on
	// short ones.
	useLayoutEffect(() => {
		const node = textareaRef.current;
		if (!node || !editing) return;
		node.style.height = "auto";
		node.style.height = `${Math.max(96, node.scrollHeight)}px`;
	}, [buffer, editing]);

	const profile = state.profile;
	const saved = (profile?.profile_summary ?? "").trim();
	/**
	 * E4.9i-P2-1 kept the review-due tile a tally of the server's `review_due`
	 * classification rather than "a stored date that has passed" — the old
	 * `review_due_at <= now` expression skipped every rule the daily plan
	 * applies and disagreed with the badge on the same screen. P2-3 moved all
	 * four counts into `deriveProfileOverview`; the rules are unchanged.
	 */
	const { activeGoals, totalConcepts: concepts, reviewDueStates, openMisconceptions: openMisc } = overview;

	const beginEdit = () => {
		setError(null);
		setBuffer(profile?.profile_summary ?? "");
		setDirty(false);
		setEditing(true);
	};

	/** Leaving the editor discards nothing silently: unsaved text asks first. */
	const cancelEdit = () => {
		if (dirty && typeof window !== "undefined"
			&& !window.confirm(t("profile.summary.discardConfirm"))) return;
		setBuffer(profile?.profile_summary ?? "");
		setDirty(false);
		setError(null);
		setEditing(false);
	};

	const save = async () => {
		setError(null);
		try {
			await learnerStore.patchSummary(buffer);
			setDirty(false);
			setEditing(false);
		} catch (err) {
			// Stay in the editor with the learner's text: a failed save must not
			// look like a successful one, and retyping it would be worse.
			setError(t("profile.summary.saveFailed", {
				message: err instanceof Error ? err.message : String(err),
			}));
		}
	};

	return (
		<Section
			title={t("profile.sections.summary")}
			action={editing ? undefined : (
				<Button variant="secondary" size="xs" onClick={beginEdit}>
					{t("profile.summary.edit")}
				</Button>
			)}
		>
			{/*
			 * E4.9i-P2-3: the conclusion sits above the tiles, inside 学习概览.
			 * A refresh in flight or a failed refresh suppresses it instead of
			 * describing stale data as the current result.
			 */}
			{conclusionsState === "ready" ? (
				<ProfileConclusion overview={overview} />
			) : (
				<p className="m-0 mb-3.5 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-4 py-3 text-[13px] leading-relaxed text-[var(--inno-text-muted)]">
					{conclusionsState === "refreshing"
						? t("profile.conclusion.refreshing")
						: t("profile.conclusion.suspended")}
				</p>
			)}
			<div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label={t("profile.summary.activeGoals")} value={activeGoals} />
				<Stat label={t("profile.summary.concepts")} value={concepts} />
				<Stat label={t("profile.summary.reviewDueStates")} value={reviewDueStates} />
				<Stat label={t("profile.summary.openMisconceptions")} value={openMisc} />
			</div>
			{/*
			 * E4.9i-P2-1: says once, below the grid, that the number is a state
			 * tally. It must not be read as the server's due-review verdict —
			 * that check lives in the daily plan and is not reproduced here.
			 */}
			<p className="m-0 mb-3.5 text-[11px] leading-snug text-[var(--inno-text-subtle)]">
				{t("profile.summary.reviewDueStatesHintTitle")}
			</p>

			{editing ? (
				<div className="flex flex-col gap-2">
					<Textarea
						aria-label={t("profile.summary.readLabel")}
						ref={textareaRef}
						// E4.9c: the same prose surface as the practice answer — shared
						// border, radius and focus, no resize handle (height is set in JS).
						variant="prose"
						placeholder={t("profile.summary.placeholder") ?? ""}
						value={buffer}
						autoFocus
						onChange={(e) => {
							setBuffer(e.target.value);
							setDirty(true);
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								cancelEdit();
							}
						}}
					/>
					{error ? (
						<p role="alert" className="m-0 text-xs text-[var(--inno-danger)]">{error}</p>
					) : null}
					<div className="flex justify-end gap-2">
						<Button variant="secondary" size="sm" disabled={state.isSaving} onClick={cancelEdit}>
							{t("common.cancel")}
						</Button>
						<Button variant="primary" size="sm" disabled={state.isSaving} onClick={() => void save()}>
							{state.isSaving ? t("common.saving") : t("common.save")}
						</Button>
					</div>
				</div>
			) : saved ? (
				// Same width as the stat grid above: the summary is part of that
				// block, and a narrower box read as a separate, unrelated field.
				<div className="rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-4 py-3">
					<p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--inno-text-muted)]">
						{saved}
					</p>
				</div>
			) : (
				// Compact empty state: one quiet line, not a form-sized blank box.
				<p className="m-0 rounded-xl border border-dashed border-[var(--inno-border)] px-4 py-3 text-[13px] leading-relaxed text-[var(--inno-text-subtle)]">
					{t("profile.summary.empty")}
				</p>
			)}
		</Section>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-xl bg-[var(--inno-accent-soft)] px-4 py-3.5">
			<div className="mb-1.5 text-xs text-[var(--inno-text-muted)]">{label}</div>
			<div className="text-2xl font-semibold text-[var(--inno-text)]">{value}</div>
		</div>
	);
}

interface GoalDraft {
	title: string;
	type: GoalType;
	status: GoalStatus;
	priority: number;
	success_criteria: string[];
}

const emptyGoalDraft: GoalDraft = {
	title: "",
	type: "skill",
	status: "active",
	priority: 0.5,
	success_criteria: [],
};

function GoalsSection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));
	const goals = state.profile?.goals ?? [];
	const [showForm, setShowForm] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function openForm() {
		setError(null);
		setShowForm(true);
	}

	async function submit(draft: GoalDraft) {
		setError(null);
		try {
			await learnerStore.addGoal({
				title: draft.title.trim() || t("profile.goals.newGoalDefault"),
				type: draft.type,
				status: draft.status,
				priority: draft.priority,
				success_criteria: draft.success_criteria,
			});
			setShowForm(false);
		} catch (err) {
			setError(t("profile.goals.addFailed", { message: err instanceof Error ? err.message : String(err) }));
		}
	}

	return (
		<>
			<Section
				title={t("profile.sections.goals")}
				count={goals.length}
				action={
					<Button
						variant="primary"
						size="xs"
						onClick={openForm}
					>
						<Plus size={12} strokeWidth={2.2} />
						{t("profile.goals.addNew")}
					</Button>
				}
			>
				{error ? <div className="mb-2 rounded bg-[var(--inno-danger-bg)] p-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
				{goals.length === 0 ? (
					<p className="py-4 text-center text-[13px] text-[var(--inno-text-subtle)]">{t("profile.goals.empty")}</p>
				) : (
					<div className="flex flex-col gap-2.5">
						{goals.map((g) => (
							<GoalCard key={g.goal_id} goal={g} />
						))}
					</div>
				)}
			</Section>
			{showForm ? (
				<GoalFormDialog
					onClose={() => setShowForm(false)}
					onSubmit={submit}
				/>
			) : null}
		</>
	);
}

function GoalFormDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (draft: GoalDraft) => Promise<void> }) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<GoalDraft>(emptyGoalDraft);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setSaving(true);
		setError(null);
		try {
			await onSubmit(draft);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<motion.div
			className="fixed inset-0 z-50 flex items-center justify-center px-4"
			initial={{ backgroundColor: "rgba(0,0,0,0)" }}
			animate={{ backgroundColor: "rgba(0,0,0,0.45)" }}
			transition={{ duration: 0.2 }}
			onClick={onClose}
		>
			<motion.div
				className="max-h-[85vh] w-full max-w-[460px] overflow-y-auto rounded-2xl bg-[var(--inno-surface)] p-5 shadow-xl"
				initial={{ opacity: 0, scale: 0.95 }}
				animate={{ opacity: 1, scale: 1 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="mb-4 text-base font-medium text-[var(--inno-text)]">{t("profile.goals.newTitle")}</h3>
				<div className="flex flex-col gap-3">
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.title")}</span>
						<Input
							className="rounded-lg px-3 py-2 text-sm"
							placeholder={t("profile.goals.namePlaceholder") ?? ""}
							value={draft.title}
							autoFocus
							onChange={(e) => setDraft({ ...draft, title: e.target.value })}
						/>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<label className="block text-sm">
							<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.type")}</span>
							<Select
								value={draft.type}
								onValueChange={(type) => setDraft({ ...draft, type: type as GoalType })}
							>
								<SelectTrigger className="w-full min-h-10 text-sm"><SelectValue /></SelectTrigger>
								<SelectContent>
								{GOAL_TYPES.map((tp) => (
									<SelectOption key={tp} value={tp} label={t(`profile.goals.typeOptions.${tp}`)} />
								))}
								</SelectContent>
							</Select>
						</label>
						<label className="block text-sm">
							<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.status")}</span>
							<Select
								value={draft.status}
								onValueChange={(status) => setDraft({ ...draft, status: status as GoalStatus })}
							>
								<SelectTrigger className="w-full min-h-10 text-sm"><SelectValue /></SelectTrigger>
								<SelectContent>
								{GOAL_STATUSES.map((st) => (
									<SelectOption key={st} value={st} label={t(`profile.goals.statusOptions.${st}`)} />
								))}
								</SelectContent>
							</Select>
						</label>
					</div>
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">
							{t("profile.goals.priority")}: {Math.round(draft.priority * 100)}%
						</span>
						<input
							type="range"
							min={0}
							max={100}
							value={Math.round(draft.priority * 100)}
							onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) / 100 })}
							className="w-full"
						/>
					</label>
					<label className="block text-sm">
						<span className="mb-1 block font-medium text-[var(--inno-text)]">{t("profile.goals.successCriteria")}</span>
						<Textarea
							className="h-20 resize-none rounded-lg px-3 py-2 text-sm"
							placeholder={t("profile.goals.successCriteriaPlaceholder") ?? ""}
							value={draft.success_criteria.join("\n")}
							onChange={(e) =>
								setDraft({
									...draft,
									success_criteria: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
								})
							}
						/>
					</label>
				</div>
				<div className="mt-4 flex justify-end gap-2">
					{error ? <div className="mr-auto text-xs text-[var(--inno-danger)]">{error}</div> : null}
					<Button
						variant="secondary"
						size="sm"
						disabled={saving}
						onClick={onClose}
					>
						{t("common.cancel")}
					</Button>
					<Button
						variant="primary"
						size="sm"
						disabled={saving}
						onClick={() => void save()}
					>
						{saving ? t("common.saving") : t("common.save")}
					</Button>
				</div>
			</motion.div>
		</motion.div>
	);
}

function goalDotColor(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "var(--inno-accent)";
		case "completed":
			return "var(--inno-success)";
		case "paused":
			return "var(--inno-warning)";
		default:
			return "var(--inno-text-subtle)";
	}
}

function GoalCard({ goal }: { goal: LearningGoal }) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<LearningGoal>(() => goalEditingBaseline(goal));
	/**
	 * E4.9i-P2-6-R2 (T01): the record as it looked when this editing session
	 * opened.
	 *
	 * `goal` is the live prop and is replaced on every refresh, while `draft`
	 * keeps what the user is editing. Comparing the two would make every
	 * server-side change look like a user edit — the stale draft value would be
	 * re-sent, overwriting the newer one and re-stamping `manual.<field>` for a
	 * field the user never touched. The snapshot is the only correct baseline
	 * for "what did the user change?".
	 *
	 * It is deliberately not refreshed by a passive update: the draft belongs to
	 * this session, and merging a newer record into it would discard keystrokes.
	 */
	const [editingBaseline, setEditingBaseline] = useState<LearningGoal | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/**
	 * E4.9i-P2-6-R1 (F01): whether the user actually moved the priority control.
	 *
	 * The server treats the *presence* of `priority` in a PATCH as "a human set
	 * this field", so re-sending an untouched value silently re-claims ownership
	 * and can overwrite a newer priority the server received while this editor
	 * was open. A diff alone cannot stand in for this flag: an anomalous stored
	 * value (say 3) has no slider position, so "left alone" and "dragged to the
	 * end of the track" both leave `draft.priority` looking unchanged.
	 */
	const [priorityTouched, setPriorityTouched] = useState(false);

	useEffect(() => {
		if (!editing) setDraft(goalEditingBaseline(goal));
	}, [goal, editing]);

	function startEditing() {
		// Reopening must not inherit the previous session's draft, touch state or
		// snapshot: the baseline is always the newest server record.
		const baseline = goalEditingBaseline(goal);
		setEditingBaseline(baseline);
		setDraft(goalEditingBaseline(baseline));
		setPriorityTouched(false);
		setError(null);
		setEditing(true);
	}

	function cancelEditing() {
		setDraft(goalEditingBaseline(goal));
		setEditingBaseline(null);
		setPriorityTouched(false);
		setError(null);
		setEditing(false);
	}

	async function save() {
		// Without a snapshot there is no honest way to tell an edit from a stale
		// value. Refusing is safer than falling back to the live record, which is
		// exactly the comparison T01 removes.
		if (!editingBaseline) {
			setError(t("profile.goals.editBaselineMissing"));
			return;
		}
		const patch = goalPatchFromDraft(editingBaseline, draft, priorityTouched);
		// Nothing changed: closing without a request is the only way to leave the
		// server's ownership stamps alone.
		if (Object.keys(patch).length === 0) {
			setEditingBaseline(null);
			setEditing(false);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await learnerStore.patchGoal(goal.goal_id, patch);
			// The store already holds the record the server returned; the effect
			// above re-seeds the draft from it on the next render.
			setEditingBaseline(null);
			setEditing(false);
		} catch (err) {
			// A failed save keeps the draft (and the touch flag) so the user can
			// retry without redoing the edit. The snapshot is kept too: the retry
			// must still compare against the session's opening record, not against
			// whatever the server may have changed in between.
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	async function doDelete() {
		setError(null);
		try {
			await learnerStore.deleteGoal(goal.goal_id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	if (!editing) {
		return (
			<div className="flex items-start gap-3 rounded-xl border border-[var(--inno-border)] px-[15px] py-[13px]">
				<span
					className="mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full"
					style={{ background: goalDotColor(goal.status) }}
				/>
				<div className="min-w-0 flex-1">
					<div className="mb-0.5 text-[13.5px] font-medium text-[var(--inno-text)]">{goal.title}</div>
					<div className="flex flex-wrap items-center gap-2 text-xs text-[var(--inno-text-subtle)]">
						<span className="rounded-md bg-[var(--inno-chip-bg)] px-1.5 py-0.5">{t(`profile.goals.typeOptions.${goal.type}`)}</span>
						{/*
						 * E4.9i-P2-6 (T06): a stored priority outside 0–1 used to be
						 * rendered as `300%` (and NaN as `NaN%`), which claims a
						 * meaningful weight the record does not have. It is now shown
						 * as an anomaly with its raw value, so the reader sees what is
						 * actually stored instead of a plausible-looking percentage.
						 */}
						<span>· {goalPriorityLine(t, goal.priority)}</span>
					</div>
					{goal.success_criteria.length > 0 ? (
						<ul className="mt-2 max-w-[780px] list-disc pl-5 text-xs text-[var(--inno-text-muted)]">
							{goal.success_criteria.map((s) => (
								<li key={s}>{s}</li>
							))}
						</ul>
					) : null}
					{error ? <div className="mt-2 rounded bg-[var(--inno-danger-bg)] p-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					<span className={`rounded-[9px] px-2.5 py-0.5 text-[11px] ${statusToneFor(goal.status)}`}>
						{t(`profile.goals.statusOptions.${goal.status}`)}
					</span>
					<Button
						variant="secondary"
						size="xs"
						onClick={startEditing}
					>
						{t("common.edit")}
					</Button>
					<Button
						variant="danger"
						size="xs"
						onClick={() => void doDelete()}
					>
						{t("common.delete")}
					</Button>
				</div>
			</div>
		);
	}
	return (
		<div className="rounded-xl border border-[var(--inno-border)] px-[15px] py-[13px]">
			<div className="grid gap-2">
				<Input
					className="rounded-lg px-3 py-2 text-sm"
					value={draft.title}
					onChange={(e) => setDraft({ ...draft, title: e.target.value })}
				/>
				<div className="grid grid-cols-2 gap-2">
					<label className="block text-xs">
						<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.goals.type")}</span>
						<Select
							value={draft.type}
							onValueChange={(type) => setDraft({ ...draft, type: type as GoalType })}
						>
							<SelectTrigger className="w-full min-h-9 text-sm"><SelectValue /></SelectTrigger>
							<SelectContent>
							{GOAL_TYPES.map((tp) => (
								<SelectOption key={tp} value={tp} label={t(`profile.goals.typeOptions.${tp}`)} />
							))}
							</SelectContent>
						</Select>
					</label>
					<label className="block text-xs">
						<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.goals.status")}</span>
						<Select
							value={draft.status}
							onValueChange={(status) => setDraft({ ...draft, status: status as GoalStatus })}
						>
							<SelectTrigger className="w-full min-h-9 text-sm"><SelectValue /></SelectTrigger>
							<SelectContent>
							{GOAL_STATUSES.map((st) => (
								<SelectOption key={st} value={st} label={t(`profile.goals.statusOptions.${st}`)} />
							))}
							</SelectContent>
						</Select>
					</label>
				</div>
				{/*
				 * E4.9i-P2-6 (T06): `draft.priority` keeps the stored value, even
				 * when it is outside 0–1. Only `onChange` replaces it, so opening
				 * the editor, editing the title or status, or cancelling all leave
				 * an anomalous priority untouched — the browser clamps the slider's
				 * *thumb* to 0–100 but does not fire a change event for it.
				 *
				 * The label shows the anomaly instead of a clamped percentage, so
				 * the editor does not claim a weight the record does not have.
				 */}
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">
						{goalPriorityLine(t, draft.priority)}
					</span>
					<input
						type="range"
						min={0}
						max={100}
						aria-label={t("profile.goals.priority")}
						value={Math.round(priorityForSlider(draft.priority) * 100)}
						onChange={(e) => {
							setDraft({ ...draft, priority: Number(e.target.value) / 100 });
							setPriorityTouched(true);
						}}
						className="w-full"
					/>
					{formatGoalPriority(draft.priority).kind !== "percent" ? (
						<span className="mt-0.5 block text-[11px] leading-snug text-[var(--inno-warning)]">
							{t(formatGoalPriority(draft.priority).kind === "anomaly"
								? "profile.goals.priorityAnomalyHint"
								: "profile.goals.priorityUnavailableHint")}
						</span>
					) : null}
				</label>
				{/*
				 * E4.9i-P2-6-R1 (F01): an anomalous or unusable value parks the
				 * thumb at one end of the track. Clicking that end does not move
				 * the control, so the browser fires no `change` and the user could
				 * never choose that endpoint as the new value. This button makes
				 * the choice explicit: it sets the endpoint the thumb is already
				 * showing and marks the field as edited.
				 *
				 * It sits outside the <label>: a button nested in a label is also
				 * a click target for the labelled control, which would make the
				 * two actions fight over one press.
				 */}
				{formatGoalPriority(draft.priority).kind !== "percent" ? (
					<div>
						<Button
							variant="secondary"
							size="xs"
							onClick={() => {
								setDraft({ ...draft, priority: priorityForSlider(draft.priority) });
								setPriorityTouched(true);
							}}
						>
							{t("profile.goals.priorityUseEndpoint", {
								percent: Math.round(priorityForSlider(draft.priority) * 100),
							})}
						</Button>
					</div>
				) : null}
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.goals.successCriteria")}</span>
					<Textarea
						className="h-20 max-w-[780px] rounded-lg px-2 py-1.5 text-sm"
						placeholder={t("profile.goals.successCriteriaPlaceholder") ?? ""}
						value={draft.success_criteria.join("\n")}
						onChange={(e) => setDraft({ ...draft, success_criteria: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
					/>
				</label>
				<div className="flex justify-end gap-2 pt-1">
					<Button variant="secondary" size="xs" onClick={cancelEditing}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" size="xs" disabled={saving} onClick={() => void save()}>
						{saving ? t("common.saving") : t("common.save")}
					</Button>
				</div>
				{error ? <div className="mt-1 rounded bg-[var(--inno-danger-bg)] p-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
			</div>
		</div>
	);
}

function statusToneFor(status: string): string {
	switch (status) {
		case "active":
			return "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]";
		case "paused":
			return "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]";
		case "completed":
			return "bg-[var(--inno-success-bg)] text-[var(--inno-success)]";
		case "archived":
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
		case "repairing":
			return "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]";
		case "resolved":
			return "bg-[var(--inno-success-bg)] text-[var(--inno-success)]";
		case "stale":
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
		default:
			return "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]";
	}
}

/**
 * 知识状态 with the six state filters (E4.9i-P2-4).
 *
 * The filter is a *view*: it selects from `knowledge_states` and changes
 * nothing else. The overview, the conclusion and 需要关注的知识点 all keep
 * reading the unfiltered profile, so selecting 「稳定」 does not rewrite what
 * the page says about the whole profile.
 *
 * Switching filters can unmount an open editor, so every switch — including
 * one to the same value — goes through the same exit policy as a collapse or a
 * course switch. `confirmLeave()` refuses while a save is in flight and asks
 * once for any dirty draft; a refusal leaves the filter, the editor and its
 * draft exactly as they were.
 */
function KnowledgeSection() {
	const { t } = useTranslation();
	const guard = useKnowledgeDraftGuard();
	const openEditors = useOpenKnowledgeEditors();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));
	const knowledge = state.profile?.knowledge_states ?? [];
	const [filter, setFilter] = useState<KnowledgeFilter>(DEFAULT_KNOWLEDGE_FILTER);

	const counts = useMemo(() => countKnowledgeFilters(knowledge), [knowledge]);
	const matched = useMemo(() => filterKnowledgeStates(knowledge, filter), [knowledge, filter]);

	/**
	 * Editors the learner explicitly discarded by confirming a filter switch.
	 *
	 * Protection exists for *passive* changes: the server moved a concept and
	 * the learner never agreed to lose anything. An active switch that the
	 * learner confirmed is the opposite — they were asked once and said yes, so
	 * those editors must close as before. Each id is dropped from this set once
	 * its editor actually unmounts, so a later edit is protected again.
	 */
	const [discarded, setDiscarded] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		setDiscarded((current) => {
			if (current.size === 0) return current;
			const next = new Set([...current].filter((id) => openEditors.has(id)));
			return next.size === current.size ? current : next;
		});
	}, [openEditors]);

	/**
	 * E4.9i-P2-4-R1 — a row with an open editor stays mounted even when the
	 * server moved it out of the current filter.
	 *
	 * `matched` is still the only thing the filter counts and the only thing
	 * the empty state looks at. The extra rows are appended so a passive refresh
	 * cannot unmount a draft; they keep their own key, so React updates them in
	 * place instead of remounting the editor. `matchedIds` is a Set so the
	 * check stays linear and each concept appears exactly once.
	 *
	 * They are appended *after* the matched rows, which is a deliberate
	 * exception to "server order": these are not results of the filter, they
	 * are editors the learner is using, and the order among matched rows is
	 * untouched.
	 */
	const matchedIds = useMemo(() => new Set(matched.map((item) => item.concept_id)), [matched]);

	/**
	 * The last state seen for each concept, so a row can still render after the
	 * server stops returning it.
	 *
	 * A concept that disappears from the profile while its editor is open has no
	 * record left to render from. Without this the row would vanish and take the
	 * learner's unsaved words with it — the one outcome R1 exists to prevent. The
	 * cache is a ref written during render (no state update, so no extra pass);
	 * it only ever feeds a protected row, never the filter, the counts or any
	 * "this concept exists" claim.
	 */
	const lastKnown = useRef(new Map<string, KnowledgeState>());
	for (const item of knowledge) lastKnown.current.set(item.concept_id, item);

	const protectedRows = useMemo(() => {
		if (openEditors.size === 0) return [];
		const rows: KnowledgeState[] = [];
		for (const conceptId of openEditors) {
			if (discarded.has(conceptId) || matchedIds.has(conceptId)) continue;
			const live = knowledge.find((item) => item.concept_id === conceptId);
			const retained = live ?? lastKnown.current.get(conceptId);
			if (retained) rows.push(retained);
		}
		return rows;
	}, [knowledge, openEditors, discarded, matchedIds]);
	const visible = useMemo(() => [...matched, ...protectedRows], [matched, protectedRows]);
	// Only the rows kept *outside* the filter are marked; a matching row with an
	// open editor is an ordinary result and needs no explanation.
	const protectedIds = useMemo(
		() => new Set(protectedRows.map((item) => item.concept_id)),
		[protectedRows],
	);
	/** Protected rows whose concept the latest profile no longer contains. */
	const missingIds = useMemo(
		() => new Set(protectedRows.filter((item) => !knowledge.includes(item)).map((item) => item.concept_id)),
		[knowledge, protectedRows],
	);

	/** Same-value clicks are a no-op: no confirm, no unmount, no state change. */
	const changeFilter = (next: KnowledgeFilter) => {
		if (next === filter) return;
		// Say what *this* exit does: the generic copy talks about discarding one
		// concept, while a switch can hide several editors at once.
		if (!guard.confirmLeave(t("profile.knowledge.filters.switchConfirm"))) return;
		// The learner confirmed: editors that this switch hides are allowed to
		// close, exactly as before protection existed.
		const hidden = [...openEditors].filter((id) => !new Set(
			filterKnowledgeStates(knowledge, next).map((item) => item.concept_id),
		).has(id));
		if (hidden.length > 0) setDiscarded(new Set([...discarded, ...hidden]));
		setFilter(next);
	};

	// The empty profile keeps its section so the header still reads "知识状态 0",
	// but a protected editor must never be dropped by this early return.
	if (knowledge.length === 0 && protectedRows.length === 0) {
		return (
			<Section title={t("profile.sections.knowledge")} count={0}>
				<KnowledgeList states={knowledge} />
			</Section>
		);
	}
	return (
		<Section
			title={t("profile.sections.knowledge")}
			count={knowledge.length}
			defaultCollapsed={knowledge.length > 5}
			// Collapsing unmounts every editor inside, so it takes the same
			// verdict as a row collapse — one confirm for the whole section.
			onBeforeCollapse={guard.confirmLeave}
		>
			{knowledge.length > 0 ? (
				<div className="mb-3">
					<KnowledgeStateFilters value={filter} counts={counts} onChange={changeFilter} />
				</div>
			) : null}
			{/*
			 * E4.9i-P2-2: the row, its reading view and its edit panel now live in
			 * react/profile/. This container is the only place that talks to
			 * `learnerStore`, which keeps the course view read-only by
			 * construction rather than by a flag.
			 *
			 * P2-4: the filtered list is a subset of the same array, so the row
			 * order is still the server's. A filter with no match shows its own
			 * message — never the "no concepts tracked" state, which would claim
			 * the profile is empty.
			 */}
			<KnowledgeList
				states={visible}
				protectedIds={protectedIds}
				missingIds={missingIds}
				onSave={(conceptId, patch) => learnerStore.patchKnowledge(conceptId, {
					diagnosis: patch.diagnosis,
					next_actions: patch.nextActions,
					mastery: patch.mastery,
				})}
				emptyMessage={
					knowledge.length === 0
						? undefined
						: filter === DEFAULT_KNOWLEDGE_FILTER
							? undefined
							: t("profile.knowledge.filters.empty")
				}
			/>
		</Section>
	);
}

/**
 * 需要关注的知识点 (E4.9i-P2-3).
 *
 * The all-courses view had no such block; the course-scoped view had one. This
 * renders the same filtered set for the whole profile, read-only: the stored
 * `next_actions` are shown, nothing is generated, and there is no per-concept
 * practice button — the app has no navigation that pre-fills a normal practice
 * session for one concept, and faking one through the review flow would bypass
 * its eligibility check. The main 练习与反馈 entry stays where it is.
 */
function WeakKnowledgeCard({ overview, conclusionsState }: { overview: ProfileOverview; conclusionsState: ConclusionsState }) {
	const { t } = useTranslation();
	return (
		<Section title={t("profile.weak.title")} count={overview.weakConcepts.length}>
			{conclusionsState === "ready" ? (
				<WeakKnowledgeSection
					weakConcepts={overview.weakConcepts}
					totalConcepts={overview.totalConcepts}
					unknownCount={overview.unknownCount}
				/>
			) : (
				<p className="m-0 text-[13px] leading-relaxed text-[var(--inno-text-muted)]">
					{conclusionsState === "refreshing" ? t("profile.weak.refreshing") : t("profile.weak.suspended")}
				</p>
			)}
		</Section>
	);
}

function MisconceptionsSection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile }));
	const items = state.profile?.misconceptions ?? [];

	if (items.length === 0) {
		return (
			<Section title={t("profile.sections.misconceptions")} count={0}>
				<p className="py-4 text-center text-[13px] text-[var(--inno-text-subtle)]">{t("profile.misconceptions.empty")}</p>
			</Section>
		);
	}
	return (
		<Section
			title={t("profile.sections.misconceptions")}
			count={items.length}
			defaultCollapsed={items.length > 5}
		>
			<div className="flex flex-col gap-2.5">
				{items.map((m) => (
					<MisconceptionRow key={m.misconception_id} item={m} />
				))}
			</div>
		</Section>
	);
}

function MisconceptionRow({ item }: { item: Misconception }) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState({ status: item.status, severity: item.severity, repair: item.repair_strategy });
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) setDraft({ status: item.status, severity: item.severity, repair: item.repair_strategy });
	}, [item, dirty]);

	async function save() {
		setSaving(true);
		try {
			await learnerStore.patchMisconception(item.misconception_id, {
				status: draft.status,
				severity: draft.severity,
				repair_strategy: draft.repair,
			});
			setDirty(false);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="rounded-xl border border-[color-mix(in_srgb,var(--inno-danger)_28%,transparent)] bg-[var(--inno-danger-bg)] px-[15px] py-[13px]">
			<div className="mb-1 flex items-center gap-2 text-[13.5px] font-medium text-[var(--inno-danger)]">
				<TriangleAlert size={14} className="shrink-0" />
				<span className="min-w-0 max-w-[780px]">{item.description}</span>
				<span className={`ml-auto shrink-0 rounded-[9px] px-2.5 py-0.5 text-[11px] ${statusToneFor(item.status)}`}>
					{t(`profile.misconceptions.statusOptions.${item.status}`)}
				</span>
			</div>
			<div className="mb-2 text-xs text-[var(--inno-text-subtle)]">{item.concept_id} · {formatDate(item.last_seen_at)}</div>
			<div className="grid grid-cols-2 gap-2">
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.misconceptions.status")}</span>
					<Select
						value={draft.status}
						onValueChange={(status) => {
							setDraft({ ...draft, status: status as MisconceptionStatus });
							setDirty(true);
						}}
					>
						<SelectTrigger className="w-full min-h-9 text-sm"><SelectValue /></SelectTrigger>
						<SelectContent>
						{MISC_STATUSES.map((s) => (
							<SelectOption key={s} value={s} label={t(`profile.misconceptions.statusOptions.${s}`)} />
						))}
						</SelectContent>
					</Select>
				</label>
				<label className="block text-xs">
					<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.misconceptions.severity")}: {Math.round(draft.severity * 100)}%</span>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round(draft.severity * 100)}
						onChange={(e) => {
							setDraft({ ...draft, severity: Number(e.target.value) / 100 });
							setDirty(true);
						}}
						className="w-full"
					/>
				</label>
			</div>
			<label className="mt-2 block text-xs">
				<span className="mb-0.5 block text-[var(--inno-text-subtle)]">{t("profile.misconceptions.repair")}</span>
				<Textarea
					className="h-16 max-w-[780px] rounded-lg px-2 py-1.5 text-sm"
					value={draft.repair}
					onChange={(e) => {
						setDraft({ ...draft, repair: e.target.value });
						setDirty(true);
					}}
				/>
			</label>
			{dirty ? (
				<div className="mt-2 flex justify-end gap-2">
					<Button variant="secondary" size="xs" onClick={() => setDirty(false)}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" size="xs" disabled={saving} onClick={() => void save()}>
						{saving ? t("common.saving") : t("common.save")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function PreferencesSection() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile, isSaving: learnerStore.isSaving }));
	const prefs = state.profile?.preferences ?? { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] };
	const [draft, setDraft] = useState(prefs);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) setDraft(prefs);
	}, [state.profile, dirty, prefs]);

	function update(key: keyof typeof prefs, values: string[]) {
		setDraft({ ...draft, [key]: values });
		setDirty(true);
	}

	async function save() {
		await learnerStore.patchPreferences(draft);
		setDirty(false);
	}

	const fields: { key: keyof typeof prefs; label: string }[] = [
		{ key: "explanation_style", label: t("profile.preferences.explanationStyle") },
		{ key: "practice_style", label: t("profile.preferences.practiceStyle") },
		{ key: "feedback_tone", label: t("profile.preferences.feedbackTone") },
		{ key: "avoid", label: t("profile.preferences.avoid") },
	];

	return (
		<Section title={t("profile.sections.preferences")}>
			<div className="grid gap-3 sm:grid-cols-2">
				{fields.map(({ key, label }) => (
					<ChipInput key={key} label={label} values={draft[key]} onChange={(v) => update(key, v)} placeholder={t("profile.preferences.addPlaceholder") ?? ""} />
				))}
			</div>
			{dirty ? (
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="secondary" size="sm" onClick={() => setDirty(false)}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" size="sm" disabled={state.isSaving} onClick={() => void save()}>
						{state.isSaving ? t("common.saving") : t("common.save")}
					</Button>
				</div>
			) : null}
		</Section>
	);
}

function ChipInput({ label, values, onChange, placeholder }: { label: string; values: string[]; onChange(next: string[]): void; placeholder: string }) {
	const [input, setInput] = useState("");
	function add() {
		const v = input.trim();
		if (!v || values.includes(v)) {
			setInput("");
			return;
		}
		onChange([...values, v]);
		setInput("");
	}
	return (
		<div>
			<div className="mb-1 text-xs font-medium text-[var(--inno-text)]">{label}</div>
			<div className="flex flex-wrap gap-1">
				{values.map((v) => (
					<span key={v} className="inline-flex items-center gap-1 rounded-full bg-[var(--inno-accent-soft)] px-2 py-0.5 text-xs text-[var(--inno-accent)]">
						{v}
						<button className="text-[var(--inno-accent)]" onClick={() => onChange(values.filter((x) => x !== v))}>
							×
						</button>
					</span>
				))}
				<Input
					size="sm"
					className="min-w-[120px] flex-1 rounded-lg px-2 py-1 text-xs"
					placeholder={placeholder}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
					}}
					onBlur={add}
				/>
			</div>
		</div>
	);
}

export function LearnerProfilePanel() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(learnerStore, () => ({
		profile: learnerStore.profile,
		isLoading: learnerStore.isLoading,
		error: learnerStore.error,
	}));

	useEffect(() => {
		void learnerStore.load();
	}, []);

	/**
	 * E4.9i-P2-3: the panel deliberately keeps showing the last successful data
	 * on a failed refresh (the learner's editor and its unsaved draft live in
	 * it), but a conclusion derived from it would be presented as the result of
	 * a read that just failed — or, while a refresh is in flight, as the latest
	 * one. So the conclusion and the weak-knowledge advice only render in
	 * `ready`; otherwise the cards say why, the tiles and the knowledge list
	 * stay, and the existing 刷新 button retries. No local cache fills a failure.
	 */
	const conclusionsState = conclusionsStateFor({
		hasProfile: Boolean(state.profile),
		isLoading: state.isLoading,
		error: state.error,
	});
	const overview = useMemo(
		() => (state.profile ? deriveProfileOverview(state.profile) : null),
		[state.profile],
	);

	return (
		<div className="h-full overflow-y-auto">
			<div className="mla-profile-container mx-auto flex w-full flex-col gap-4 pb-8 pt-2.5">
				<div className="flex items-start justify-between gap-3 pb-1">
					<div className="text-[12.5px] leading-relaxed text-[var(--inno-text-subtle)]">
						<p>{t("profile.subtitle")}</p>
						{state.profile ? (
							<p>{t("profile.version", { version: state.profile.version, updated: formatDate(state.profile.updated_at) })}</p>
						) : null}
					</div>
					<Button
						variant="primary"
						size="md"
						className="shrink-0"
						onClick={() => void learnerStore.load()}
					>
						<RefreshCw size={14} />
						{t("profile.refresh")}
					</Button>
				</div>

				{state.isLoading ? (
					<div className="flex items-center justify-center py-8 text-[var(--inno-text-muted)]">
						<Spinner size={16} className="mr-2" />
						{t("common.loading")}
					</div>
				) : null}

				{state.error ? (
					<div role="alert" className="rounded-lg bg-[var(--inno-danger-bg)] p-2 text-sm text-[var(--inno-danger)]">
						<div>{state.error}</div>
						{/*
						 * Only when stale data is still on screen: say so, and say which
						 * parts are paused. The knowledge list stays mounted so an unsaved
						 * draft is never dropped by the error branch (P2-2-R1).
						 */}
						{state.profile ? (
							<p className="m-0 mt-1 text-xs leading-relaxed text-[var(--inno-text-muted)]">
								{t("profile.conclusion.staleNotice")}
							</p>
						) : null}
					</div>
				) : null}

				{state.profile && overview ? (
					<>
						<SummarySection overview={overview} conclusionsState={conclusionsState} />
						<KnowledgeSection />
						<WeakKnowledgeCard overview={overview} conclusionsState={conclusionsState} />
						<GoalsSection />
						<MisconceptionsSection />
						<PreferencesSection />
					</>
				) : null}
			</div>
		</div>
	);
}
