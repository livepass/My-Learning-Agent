import { useState } from "react";
import { useTranslation } from "react-i18next";
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
	const { t } = useTranslation();
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	if (!open) return null;

	const submit = async () => {
		const trimmed = title.trim();
		if (!trimmed) {
			setLocalError(t("course.create.titleRequired"));
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
		<Dialog label={t("course.create.title")} className="mla-dialog" onClose={() => { if (!pending) onClose(); }}>
			<div className="mla-dialog-body">
				<h2>{t("course.create.title")}</h2>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.create.hint")}
				</p>
				<label className="mla-field">
					<span>{t("course.create.nameLabel")}</span>
					<Input
						value={title}
						autoFocus
						maxLength={120}
						placeholder={t("course.create.namePlaceholder")}
						disabled={pending}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				<label className="mla-field">
					<span>{t("course.create.descriptionLabel")}</span>
					<Textarea
						value={description}
						rows={3}
						maxLength={4000}
						placeholder={t("course.create.descriptionPlaceholder")}
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
					<Button onClick={onClose} disabled={pending}>{t("course.create.cancel")}</Button>
					<Button variant="primary" disabled={pending} onClick={() => void submit()}>
						{pending ? t("course.create.creating") : t("course.create.submit")}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}
