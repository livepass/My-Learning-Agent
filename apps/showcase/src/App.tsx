import { useCallback, useEffect, useRef } from "react";
import { appStore, type RightPanelTab, type WorkspaceMode } from "@inno-web/stores/app-store.js";
import { sessionsStore } from "@inno-web/stores/sessions-store.js";
import { settingsStore } from "@inno-web/stores/settings-store.js";
import { workspacesStore } from "@inno-web/stores/workspaces-store.js";
import { useStoreSnapshot } from "@inno-web/react/hooks.js";
import { ChatCenter } from "@inno-web/react/ChatCenter.js";
import { SessionSidebar } from "@inno-web/react/SessionSidebar.js";
import { WorkspacePanel } from "@inno-web/react/WorkspacePanel.js";
import { fetchCaseIndex } from "./cases.js";
import { mockBackend } from "./mock/runtime.js";
import { replayDriver } from "./replay/driver.js";
import { ReplayTransport } from "./replay/Transport.js";

let initializationPromise: Promise<void> | null = null;

/**
 * Boot the real product stores against the mock backend, then open the case
 * from the URL hash (or the first case) so the replay starts immediately.
 */
function initializeShowcase(): Promise<void> {
	if (initializationPromise) return initializationPromise;
	initializationPromise = (async () => {
		const cases = await fetchCaseIndex();
		mockBackend.setCases(cases);
		// Preload every case doc so the sidebar/workspace names render from real
		// data and case switches are instant.
		await Promise.all(
			cases.map(async (c) => {
				const { fetchCase } = await import("./cases.js");
				mockBackend.registerDoc(await fetchCase(c.id));
			}),
		);
		await Promise.all([sessionsStore.load(), workspacesStore.load()]);
		void settingsStore.load();
		const hashMatch = /^#\/case\/([^/]+)$/.exec(window.location.hash);
		const initialId = hashMatch ? decodeURIComponent(hashMatch[1]) : cases[0]?.id;
		if (initialId) await sessionsStore.openSession(initialId, { historyMode: "none" });
	})().catch((err) => {
		console.error("[showcase] init failed:", err);
	});
	return initializationPromise;
}

/**
 * The showcase shell: the product's REAL sidebar, chat center and workspace
 * panel, plus the replay transport overlay. Nothing here is a copy — every
 * pixel of the chat experience comes from apps/learning-agent/web source.
 */
export function App() {
	const app = useStoreSnapshot(appStore, () => ({
		rightPanelTab: appStore.rightPanelTab,
		sidebarCollapsed: appStore.sidebarCollapsed,
		workspaceMode: appStore.workspaceMode,
		workspaceWidth: appStore.workspaceWidth,
	}));
	const currentSessionId = useStoreSnapshot(sessionsStore, () => sessionsStore.currentSessionId);

	useEffect(() => {
		void initializeShowcase();
	}, []);

	// Keep the URL hash in sync so cases are deep-linkable.
	useEffect(() => {
		if (!currentSessionId) return;
		const target = `#/case/${encodeURIComponent(currentSessionId)}`;
		if (window.location.hash !== target) {
			window.history.replaceState(null, "", target);
		}
	}, [currentSessionId]);

	// Back/forward navigation between cases.
	useEffect(() => {
		const onHashChange = () => {
			const match = /^#\/case\/([^/]+)$/.exec(window.location.hash);
			const id = match ? decodeURIComponent(match[1]) : null;
			if (id && id !== sessionsStore.currentSessionId) {
				void sessionsStore.openSession(id, { historyMode: "none" });
			}
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	const setTab = useCallback((tab: RightPanelTab) => appStore.setRightPanelTab(tab), []);
	const setWorkspaceMode = useCallback((mode: WorkspaceMode) => appStore.setWorkspaceMode(mode), []);
	const setWorkspaceWidth = useCallback((width: number) => appStore.setWorkspaceWidth(width), []);
	const openSidebar = useCallback(() => appStore.setSidebarCollapsed(false), []);
	const openPresetPanels = useCallback(() => {
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceMode("half");
	}, []);
	const openRightPanel = useCallback((tab: Exclude<RightPanelTab, "preview">) => {
		appStore.setRightPanelTab(tab);
		appStore.setWorkspaceMode("quarter");
	}, []);
	const openPreviewFile = useCallback((minimumWidth: number) => {
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceWidth(Math.max(minimumWidth, appStore.workspaceWidth));
		appStore.setWorkspaceMode("half");
	}, []);

	// Same viewport breakpoint behavior as the product shell: collapse the
	// sidebar and workspace panel when the window narrows.
	const userExpandedSidebar = useRef(false);
	useEffect(() => {
		const mql = window.matchMedia("(max-width: 960px)");
		const handler = (e: MediaQueryListEvent | MediaQueryList) => {
			if (e.matches) {
				if (!appStore.sidebarCollapsed) {
					userExpandedSidebar.current = false;
					appStore.setSidebarCollapsed(true);
				}
			} else if (appStore.sidebarCollapsed && !userExpandedSidebar.current) {
				appStore.setSidebarCollapsed(false);
			}
		};
		handler(mql);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);

	useEffect(() => {
		const mql = window.matchMedia("(max-width: 820px)");
		const handler = (e: MediaQueryListEvent | MediaQueryList) => {
			if (e.matches && appStore.workspaceMode === "half") {
				appStore.setWorkspaceMode("collapsed");
			}
		};
		handler(mql);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);

	return (
		<div
			className={`app-layout app-layout--sidebar-${app.sidebarCollapsed ? "collapsed" : "expanded"} app-layout--workspace-${app.workspaceMode}`}
			style={{ "--inno-workspace-width": `${app.workspaceWidth}px` } as React.CSSProperties}
		>
			<SessionSidebar collapsed={app.sidebarCollapsed} onOpen={openSidebar} />
			<div className="relative h-full min-h-0 min-w-0">
				<ChatCenter
					onOpenPresetPanels={openPresetPanels}
					onOpenRightPanel={openRightPanel}
					onPreviewFile={openPreviewFile}
				/>
				<ReplayTransport />
			</div>
			<WorkspacePanel
				activeTab={app.rightPanelTab}
				mode={app.workspaceMode}
				width={app.workspaceWidth}
				onTabChange={setTab}
				onModeChange={setWorkspaceMode}
				onWidthChange={setWorkspaceWidth}
				onPreviewFile={openPreviewFile}
			/>
		</div>
	);
}
