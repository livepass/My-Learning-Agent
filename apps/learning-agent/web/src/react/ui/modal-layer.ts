import { useEffect, type RefObject } from "react";

/**
 * E4.9g-P2-4-R1 — modal behaviour for an element that is *always mounted*.
 *
 * `Sheet` unmounts its panel when closed, so it can do everything in one
 * effect keyed on `open`. The history drawer cannot: it is the same `<aside>`
 * in both presentations, and it must stay in the DOM so its slide transition
 * still runs. That means the modal concerns have to be applied to an existing
 * node — and removed completely when the drawer closes or when the window
 * grows into the permanent rail.
 *
 * Two details make this safe next to Radix menus and dialogs, which render
 * through portals into `document.body`:
 *
 * 1. background isolation skips overlay portals, so a menu opened from inside
 *    the drawer is not inerted by its own drawer;
 * 2. the Tab trap only acts when focus is inside the panel. While a menu or
 *    dialog owns focus, the trap stays out of the way instead of fighting it.
 */

const FOCUSABLE =
	"button:not([disabled]):not([tabindex='-1']), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function focusableIn(panel: HTMLElement): HTMLElement[] {
	return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** True for a portal root that is its own overlay layer (menu, dialog). */
function isOverlayPortal(element: Element): boolean {
	return element.matches(
		"[data-radix-popper-content-wrapper], dialog, [role='dialog'], [role='menu'], [role='listbox']",
	);
}

/** Rendered and focusable by the page's own CSS (not `display:none` etc.). */
function isRendered(element: HTMLElement): boolean {
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		const style = getComputedStyle(node);
		if (style.display === "none" || style.visibility === "hidden") return false;
	}
	return true;
}

/** True while some other overlay is open and should receive Escape first. */
export function hasOpenOverlay(): boolean {
	return Boolean(document.querySelector(
		"dialog[open], [role='menu'][data-state='open'], [role='listbox'][data-state='open'], [data-radix-popper-content-wrapper]",
	));
}

/**
 * Body scroll lock shared by every modal layer.
 *
 * A counter, not a boolean: closing one layer must not unlock the page while
 * another layer still needs it. The original inline value is restored by the
 * last layer out.
 */
let scrollLocks = 0;
let savedOverflow: string | null = null;

function lockScroll(): () => void {
	if (scrollLocks === 0) {
		savedOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
	}
	scrollLocks += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		scrollLocks = Math.max(0, scrollLocks - 1);
		if (scrollLocks === 0) {
			document.body.style.overflow = savedOverflow ?? "";
			savedOverflow = null;
		}
	};
}

export interface ModalLayerOptions {
	/** Apply modality only while this is true (drawer open, not permanent). */
	active: boolean;
	/** Where focus lands on open; defaults to the panel itself. */
	initialFocus?: (panel: HTMLElement) => HTMLElement | null;
	/** Where focus goes on close when the previous target is gone. */
	fallbackFocus?: () => HTMLElement | null;
}

/**
 * Make `panelRef` behave as a modal layer while `active`.
 *
 * Applies: background `inert`, body scroll lock, focus in on open, a Tab loop
 * confined to the panel, and focus restoration on close. Everything is undone
 * when `active` flips, so a viewport change that turns the drawer into the
 * permanent rail leaves no modal state behind.
 */
export function useModalLayer(
	panelRef: RefObject<HTMLElement | null>,
	{ active, initialFocus, fallbackFocus }: ModalLayerOptions,
): void {
	useEffect(() => {
		if (!active) return;
		const panel = panelRef.current;
		if (!panel) return;

		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

		// ── Background isolation ──────────────────────────────────────────
		const inerted: Array<[HTMLElement, boolean]> = [];
		const isolate = () => {
			let node: Element | null = panel;
			while (node && node !== document.body) {
				const parent: Element | null = node.parentElement;
				if (!parent) break;
				for (const sibling of parent.children) {
					if (sibling === node || !(sibling instanceof HTMLElement)) continue;
					if (sibling.contains(panel)) continue;
					// Portals are separate layers with their own modality. Inerting
					// them would disable the menu a learner just opened.
					if (isOverlayPortal(sibling)) continue;
					if (sibling.inert) continue;
					// Store a boolean, not the raw value: `inert` is not an own
					// property on every element (jsdom has none), so restoring the
					// captured `undefined` would leave a non-boolean in place.
					inerted.push([sibling, Boolean(sibling.inert)]);
					sibling.inert = true;
				}
				node = parent;
			}
		};
		isolate();
		const unlockScroll = lockScroll();

		// ── Focus ────────────────────────────────────────────────────────
		const target = initialFocus?.(panel) ?? focusableIn(panel)[0] ?? panel;
		target.focus({ preventScroll: true });

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || event.defaultPrevented) return;
			const activeEl = document.activeElement;
			if (!(activeEl instanceof HTMLElement)) return;
			// A menu or dialog owns focus: it traps its own Tab order.
			if (activeEl !== panel && !panel.contains(activeEl)) return;

			const items = focusableIn(panel);
			if (items.length === 0) {
				event.preventDefault();
				panel.focus({ preventScroll: true });
				return;
			}
			const first = items[0]!;
			const last = items[items.length - 1]!;
			if (event.shiftKey && (activeEl === first || activeEl === panel)) {
				event.preventDefault();
				last.focus({ preventScroll: true });
			} else if (!event.shiftKey && activeEl === last) {
				event.preventDefault();
				first.focus({ preventScroll: true });
			}
		};
		document.addEventListener("keydown", onKeyDown, true);

		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			unlockScroll();
			for (const [node, inert] of inerted) node.inert = inert;

			// Restore focus only to something the learner can actually see. After a
			// viewport change the trigger may be display:none (the permanent rail has
			// no drawer button), and focusing it would silently strand focus on
			// <body>. Computed style rather than `getClientRects()`: jsdom has no
			// layout engine and reports empty rects for every element.
			const back = previousFocus?.isConnected ? previousFocus : null;
			const visible = back ? isRendered(back) : false;
			if (visible) back!.focus({ preventScroll: true });
			else fallbackFocus?.()?.focus({ preventScroll: true });
		};
	}, [active, panelRef, initialFocus, fallbackFocus]);
}
