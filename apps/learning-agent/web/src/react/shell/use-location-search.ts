import { useEffect, useState } from "react";
import { NAVIGATION_HISTORY_CHANGE_EVENT } from "../../stores/navigation-history.js";

/**
 * The current URL query, kept in React state.
 *
 * The shell only re-renders when `appStore.activePage` changes, so a page that
 * is *already* mounted and switches a URL parameter (a course-detail tab, for
 * example) would otherwise keep rendering its old value. This hook subscribes
 * to both in-app history writes and browser Back/Forward, which makes the URL
 * query usable as the single source of truth for such pages.
 */
export function useLocationSearch(): string {
	const [search, setSearch] = useState(() => (typeof window === "undefined" ? "" : window.location.search));

	useEffect(() => {
		const sync = () => setSearch(window.location.search);
		window.addEventListener("popstate", sync);
		window.addEventListener(NAVIGATION_HISTORY_CHANGE_EVENT, sync);
		// Catch a change that happened between the first render and this effect.
		sync();
		return () => {
			window.removeEventListener("popstate", sync);
			window.removeEventListener(NAVIGATION_HISTORY_CHANGE_EVENT, sync);
		};
	}, []);

	return search;
}
