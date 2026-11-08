import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, IconButton, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Textarea } from "../ui/index.js";
import type { StageDraft, TaskDifficulty, TaskDraft } from "../../api/courses.js";
import { difficultyLabel } from "../../stores/courses-store.js";

/**
 * Phase/task editor for a manual plan or an AI draft (E4.5c).
 *
 * Local state only: the parent owns the server revision and submits the whole
 * structure in one `PUT .../draft` (or one `POST /plans`), so an edit can never
 * be half-applied. Existing task ids are preserved so the server keeps their
 * session bindings, progress and server-issued `source_refs`; a new row is sent
 * without `source_refs` at all, because a citation is server output.
 */
export interface EditableStage extends StageDraft {
	tasks: EditableTask[];
}

export interface EditableTask extends TaskDraft {
	/** Client-side row identity; never sent to the server. */
	rowKey: string;
	/** Server task id when the row already exists. */
	task_id?: string | null;
	concept_labels?: string[];
	source_ids?: string[];
}

let rowSeq = 0;
function nextRowKey(): string {
	rowSeq += 1;
	return `row_${rowSeq}`;
}

export function toEditableStages(
	stages: ReadonlyArray<{ stage_id: string; title: string; description: string }>,
	tasks: ReadonlyArray<{
		task_id: string;
		stage_id: string | null;
		title: string;
		estimated_minutes: number | null;
		difficulty: TaskDifficulty;
		status: string;
		concept_labels?: string[];
		source_ids: string[];
		rationale?: string;
	}>,
): EditableStage[] {
	return stages.map((stage) => ({
		stage_id: stage.stage_id,
		title: stage.title,
		description: stage.description,
		tasks: tasks
			.filter((task) => task.stage_id === stage.stage_id)
			.map((task) => ({
				rowKey: nextRowKey(),
				task_id: task.task_id,
				title: task.title,
				estimated_minutes: task.estimated_minutes,
				difficulty: task.difficulty,
				status: task.status as TaskDraft["status"],
				concept_labels: task.concept_labels,
				source_ids: task.source_ids,
				rationale: task.rationale,
			})),
	}));
}

/** Serialize the editor state back to the API's draft shape. */
export function toStageDrafts(stages: readonly EditableStage[]): StageDraft[] {
	return stages.map((stage) => ({
		stage_id: stage.stage_id ?? null,
		title: stage.title,
		description: stage.description,
		tasks: stage.tasks.map((task) => ({
			task_id: task.task_id ?? null,
			title: task.title,
			estimated_minutes: task.estimated_minutes ?? null,
			difficulty: task.difficulty,
			...(task.concept_labels ? { concept_labels: task.concept_labels } : {}),
			...(task.source_ids ? { source_ids: task.source_ids } : {}),
			...(task.rationale ? { rationale: task.rationale } : {}),
			// `status` is preserved so an already-started task keeps its progress.
			...(task.status ? { status: task.status } : {}),
		})),
	}));
}

const DIFFICULTIES: TaskDifficulty[] = ["basic", "standard", "challenge"];

function moveItem<T>(items: readonly T[], index: number, delta: number): T[] {
	const target = index + delta;
	if (target < 0 || target >= items.length) return [...items];
	const next = [...items];
	const [item] = next.splice(index, 1);
	next.splice(target, 0, item);
	return next;
}

export function PlanStructureEditor({
	stages,
	onChange,
	disabled = false,
}: {
	stages: EditableStage[];
	onChange: (next: EditableStage[]) => void;
	disabled?: boolean;
}) {
	const updateStage = (index: number, patch: Partial<EditableStage>) => {
		onChange(stages.map((stage, current) => (current === index ? { ...stage, ...patch } : stage)));
	};

	const updateTask = (stageIndex: number, taskIndex: number, patch: Partial<EditableTask>) => {
		onChange(stages.map((stage, current) => current === stageIndex
			? { ...stage, tasks: stage.tasks.map((task, taskCurrent) => (taskCurrent === taskIndex ? { ...task, ...patch } : task)) }
			: stage));
	};

	const removeTask = (stageIndex: number, taskIndex: number) => {
		onChange(stages.map((stage, current) => current === stageIndex
			? { ...stage, tasks: stage.tasks.filter((_, taskCurrent) => taskCurrent !== taskIndex) }
			: stage));
	};

	const addTask = (stageIndex: number) => {
		onChange(stages.map((stage, current) => current === stageIndex
			? {
				...stage,
				tasks: [...stage.tasks, {
					rowKey: nextRowKey(),
					title: "",
					estimated_minutes: 25,
					difficulty: "standard" as TaskDifficulty,
				}],
			}
			: stage));
	};

	const addStage = () => {
		onChange([...stages, { title: `阶段 ${stages.length + 1}`, description: "", tasks: [] }]);
	};

	return (
		<div className="mla-stack" style={{ gap: 16 }}>
			{stages.length === 0 ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					还没有学习阶段。可以先添加一个阶段，再往里面添加任务。
				</p>
			) : null}
			{stages.map((stage, stageIndex) => (
				<div className="mla-plan-stage" key={stage.stage_id ?? `new_${stageIndex}`}>
					<div className="mla-plan-stage-head">
						<Input
							aria-label={`第 ${stageIndex + 1} 个阶段名称`}
							value={stage.title}
							maxLength={120}
							disabled={disabled}
							onChange={(event) => updateStage(stageIndex, { title: event.target.value })}
						/>
						<div className="mla-inline" style={{ flexWrap: "nowrap" }}>
							<IconButton
								size="xs"
								aria-label="阶段上移"
								title="上移"
								disabled={disabled || stageIndex === 0}
								onClick={() => onChange(moveItem(stages, stageIndex, -1))}
							>
								<ArrowUp size={14} />
							</IconButton>
							<IconButton
								size="xs"
								aria-label="阶段下移"
								title="下移"
								disabled={disabled || stageIndex === stages.length - 1}
								onClick={() => onChange(moveItem(stages, stageIndex, 1))}
							>
								<ArrowDown size={14} />
							</IconButton>
							<IconButton
								size="xs"
								aria-label="删除阶段"
								title="删除阶段（其中的任务会一起移除）"
								disabled={disabled}
								onClick={() => onChange(stages.filter((_, current) => current !== stageIndex))}
							>
								<Trash2 size={14} />
							</IconButton>
						</div>
					</div>
					<Textarea
						aria-label="阶段说明"
						value={stage.description ?? ""}
						rows={2}
						maxLength={1000}
						placeholder="这个阶段要掌握什么？"
						disabled={disabled}
						onChange={(event) => updateStage(stageIndex, { description: event.target.value })}
					/>

					<div className="mla-stack" style={{ gap: 10 }}>
						{stage.tasks.map((task, taskIndex) => (
							<div className="mla-plan-task" key={task.rowKey}>
								<Input
									aria-label={`任务名称：${stage.title}`}
									value={task.title}
									maxLength={200}
									placeholder="学习任务，例如：理解装饰器的求值顺序"
									disabled={disabled}
									onChange={(event) => updateTask(stageIndex, taskIndex, { title: event.target.value })}
								/>
								<div className="mla-plan-task-meta">
									<label className="mla-inline" style={{ gap: 6 }}>
										<span className="mla-small mla-muted">分钟</span>
										<Input
											aria-label="预计分钟"
											type="number"
											min={5}
											max={600}
											step={5}
											value={task.estimated_minutes ?? 25}
											disabled={disabled}
											style={{ width: 88 }}
											onChange={(event) => {
												const value = Number(event.target.value);
												updateTask(stageIndex, taskIndex, {
													estimated_minutes: Number.isFinite(value) ? value : null,
												});
											}}
										/>
									</label>
									<Select
										value={task.difficulty ?? "standard"}
										disabled={disabled}
										onValueChange={(value) => updateTask(stageIndex, taskIndex, { difficulty: value as TaskDifficulty })}
									>
										<SelectTrigger aria-label="难度" className="mla-small">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{DIFFICULTIES.map((difficulty) => (
												<SelectOption key={difficulty} value={difficulty} label={difficultyLabel(difficulty)} />
											))}
										</SelectContent>
									</Select>
									<div className="mla-inline" style={{ marginLeft: "auto", flexWrap: "nowrap" }}>
										<IconButton
											size="xs"
											aria-label="任务上移"
											title="上移"
											disabled={disabled || taskIndex === 0}
											onClick={() => updateStage(stageIndex, { tasks: moveItem(stage.tasks, taskIndex, -1) })}
										>
											<ArrowUp size={14} />
										</IconButton>
										<IconButton
											size="xs"
											aria-label="任务下移"
											title="下移"
											disabled={disabled || taskIndex === stage.tasks.length - 1}
											onClick={() => updateStage(stageIndex, { tasks: moveItem(stage.tasks, taskIndex, 1) })}
										>
											<ArrowDown size={14} />
										</IconButton>
										<IconButton
											size="xs"
											aria-label="删除任务"
											title="删除任务"
											disabled={disabled}
											onClick={() => removeTask(stageIndex, taskIndex)}
										>
											<Trash2 size={14} />
										</IconButton>
									</div>
								</div>
								{task.concept_labels?.length ? (
									<span className="mla-small mla-muted">
										关联知识点：{task.concept_labels.join("、")}
									</span>
								) : null}
							</div>
						))}
						<Button size="xs" disabled={disabled} onClick={() => addTask(stageIndex)}>
							<Plus size={14} />
							添加任务
						</Button>
					</div>
				</div>
			))}
			<div>
				<Button size="xs" disabled={disabled} onClick={addStage}>
					<Plus size={14} />
					添加学习阶段
				</Button>
			</div>
		</div>
	);
}
