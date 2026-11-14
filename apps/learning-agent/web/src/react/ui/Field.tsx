import { useId, type ReactNode } from "react";

/**
 * Labelled form field: label, optional hint, error, and the control itself.
 *
 * E4.9c: course forms repeated `<label class="mla-small"> + input + span.hint`
 * by hand, with the error sometimes above and sometimes below the control, and
 * the label not always associated with the input (`htmlFor` missing). This
 * component owns the association (`id` + `htmlFor` + `aria-describedby`) and
 * the visual rhythm; the control is passed in as children so each caller keeps
 * its own widget (`Input`, `Select`, `Textarea`, or a specialised control).
 *
 * The caller may pass its own `id`; otherwise one is generated and handed to
 * the child through a render prop, so the association can never be forgotten.
 */
export interface FieldProps {
	label: ReactNode;
	/** Guidance under the control; hidden from the a11y name, linked by id. */
	hint?: ReactNode;
	/** Error text; replaces the hint and sets `aria-invalid` on the control. */
	error?: ReactNode;
	/** Optional trailing note in the label row (e.g. "optional"). */
	badge?: ReactNode;
	/** Fixed id for the control, when the caller needs to query it. */
	id?: string;
	/** The control, receiving the props it must spread. */
	children: (control: {
		id: string;
		"aria-describedby": string | undefined;
		"aria-invalid": boolean | undefined;
	}) => ReactNode;
	className?: string;
}

export function Field({ label, hint, error, badge, id, children, className = "" }: FieldProps) {
	const generated = useId();
	const controlId = id ?? generated;
	const messageId = `${controlId}-message`;
	const message = error ?? hint;
	const hasError = Boolean(error);

	return (
		<div className={`mla-field${className ? ` ${className}` : ""}`}>
			<span className="mla-field-label">
				<label htmlFor={controlId}>{label}</label>
				{badge}
			</span>
			{children({
				id: controlId,
				"aria-describedby": message ? messageId : undefined,
				"aria-invalid": hasError || undefined,
			})}
			{message ? (
				<span
					id={messageId}
					className={hasError ? "mla-field-message mla-field-message--error" : "mla-field-message"}
					role={hasError ? "alert" : undefined}
				>
					{message}
				</span>
			) : null}
		</div>
	);
}
