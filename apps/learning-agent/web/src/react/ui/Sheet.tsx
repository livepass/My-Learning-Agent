import { useEffect, useRef, type ReactNode } from "react";

/**
 * E4.9g-P2-3 — a lightweight, non-`<dialog>` surface for contextual panels.
 *
 * Why not `Dialog`: that component is a true modal (`showModal()`, `aria-modal`,
 * page-wide `inert`). A desktop learning-context panel is deliberately **not**
 * modal — the learner keeps reading and scrolling the chat while it is open —
 * while the same panel on a phone *is* a modal bottom sheet. One component
 * cannot be both, so this one takes the modality as a prop and implements the
 * two semantics explicitly instead of faking one with the other's markup.
 *
 * - desktop (`modal={false}`): no backdrop, no scroll lock, no `inert`; Escape
 *   and an outside click close it; focus moves in on open and returns on close.
 * - phone (`modal={true}`): backdrop, background `inert`, background scroll
 *   locked, focus trapped inside; the same close paths still apply.
 *
 * The panel is unmounted by its owner when closed, so nothing stays in the Tab
 * order after closing. Focus return is implemented here because the trigger
 * lives in the course bar, outside the panel.
 */
export function Sheet({
	open,
	modal,
	label,
	className = "",
	onClose,
	children,
}: {
	open: boolean;
	/** Phone bottom sheet semantics; desktop overlay is non-modal. */
	modal: boolean;
	/** Accessible name of the panel; also the role's name for both modes. */
	label: string;
	className?: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		const panel = panelRef.current;
		if (!panel) return;
		const previousFocus = document.activeElement;

		// Background isolation is the only thing modality adds here; the visual
		// backdrop is CSS. Keeping it in the same effect means the two modes can
		// never end up half-applied.
		const inertNodes: Array<[HTMLElement, boolean]> = [];
		const inertBackground = () => {
			let node: Element | null = panel.parentElement;
			while (node && node !== document.body) {
				for (const sibling of node.parentElement?.children ?? []) {
					if (sibling === node || !(sibling instanceof HTMLElement)) continue;
					// The panel's own overlay wrapper is part of the sheet, not the
					// background: inerting it would make the sheet itself unusable.
					if (sibling.contains(panel)) continue;
					inertNodes.push([sibling, sibling.inert]);
					sibling.inert = true;
				}
				node = node.parentElement;
			}
		};
		if (modal) inertBackground();
		const previousOverflow = document.body.style.overflow;
		if (modal) document.body.style.overflow = "hidden";

		// No visibility filter: jsdom reports `offsetParent === null` for every
		// node, so filtering on layout would make the trap a no-op in tests while
		// looking correct in a browser. The sheet's own markup has no hidden
		// focusables, so the selector alone is the right set.
		const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
			"button:not([disabled]):not([tabindex='-1']), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
		));

		// Focus the panel heading area first: it is the least destructive place to
		// land and keeps the first Tab going to the close button.
		panel.focus({ preventScroll: true });

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				event.preventDefault();
				closeRef.current();
				return;
			}
			if (!modal || event.key !== "Tab") return;
			// Modal only: keep Tab inside the sheet.
			const items = focusable();
			if (items.length === 0) {
				event.preventDefault();
				return;
			}
			const first = items[0]!;
			const last = items[items.length - 1]!;
			const active = document.activeElement;
			if (event.shiftKey && (active === first || active === panel)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", onKeyDown);

		// Non-modal outside click. A click inside the panel, or on the trigger that
		// opened it, is not "outside" — the trigger owns its own toggle and would
		// otherwise close and immediately reopen the panel.
		const onPointerDown = (event: PointerEvent) => {
			if (modal) return;
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (panel.contains(target)) return;
			if (target instanceof Element && target.closest("[data-sheet-trigger]")) return;
			closeRef.current();
		};
		if (!modal) window.addEventListener("pointerdown", onPointerDown);

		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("pointerdown", onPointerDown);
			if (modal) {
				document.body.style.overflow = previousOverflow;
				inertNodes.forEach(([node, inert]) => { node.inert = inert; });
			}
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
				previousFocus.focus({ preventScroll: true });
			}
		};
	}, [open, modal]);

	if (!open) return null;

	return (
		<div className={`mla-sheet-layer${modal ? " mla-sheet-layer--modal" : ""}`}>
			{modal ? (
				<button
					type="button"
					className="mla-sheet-backdrop"
					aria-label={label}
					tabIndex={-1}
					onClick={onClose}
				/>
			) : null}
			<div
				ref={panelRef}
				role={modal ? "dialog" : "region"}
				aria-modal={modal ? true : undefined}
				aria-label={label}
				tabIndex={-1}
				className={`mla-sheet${className ? ` ${className}` : ""}`}
			>
				{children}
			</div>
		</div>
	);
}
