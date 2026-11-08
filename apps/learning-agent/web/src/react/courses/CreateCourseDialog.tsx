import { useState } from "react";
import { Button, Dialog, Input, Textarea } from "../ui/index.js";

/**
 * Create-course form (E4.5b).
 *
 * The server owns validation and ids; this dialog only collects a title and an
 * optional description, and reports the server's answer through `onCreate`.
 * A failure keeps the dialog open with the typed text intact so the learner can
 * correct it instead of retyping.
 */
export function CreateCourseDialog({
	open,
	pending,
	error,
	onClose,
	onCreate,
}: {
	open: boolean;
	pending: boolean;
	error: string | null;
	onClose: () => void;
	onCreate: (input: { title: string; description?: string }) => Promise<boolean>;
}) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	if (!open) return null;

	const submit = async () => {
		const trimmed = title.trim();
		if (!trimmed) {
			setLocalError("请填写课程名称。");
			return;
		}
		setLocalError(null);
		const created = await onCreate({ title: trimmed, description: description.trim() || undefined });
		if (created) {
			setTitle("");
			setDescription("");
		}
	};

	return (
		<Dialog label="创建课程" className="mla-dialog" onClose={() => { if (!pending) onClose(); }}>
			<div className="mla-dialog-body">
				<h2>创建课程</h2>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					课程用来把学习目标、教材、学习计划和学习记录放在一起。创建后可以继续设置目标和上传教材。
				</p>
				<label className="mla-field">
					<span>课程名称</span>
					<Input
						value={title}
						autoFocus
						maxLength={120}
						placeholder="例如：Python 编程"
						disabled={pending}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				<label className="mla-field">
					<span>课程说明（可选）</span>
					<Textarea
						value={description}
						rows={3}
						maxLength={4000}
						placeholder="想通过这门课学到什么？"
						disabled={pending}
						onChange={(event) => setDescription(event.target.value)}
					/>
				</label>
				{localError || error ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
						{localError ?? error}
					</p>
				) : null}
				<div className="mla-dialog-actions">
					<Button onClick={onClose} disabled={pending}>取消</Button>
					<Button variant="primary" disabled={pending} onClick={() => void submit()}>
						{pending ? "正在创建…" : "创建课程"}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}
