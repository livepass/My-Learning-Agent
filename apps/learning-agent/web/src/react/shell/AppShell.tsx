import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Settings2 } from "lucide-react";
import { appStore, type ShellPage } from "../../stores/app-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Tooltip } from "../ui/index.js";
import { pageMeta, NAV_PAGES, navigate, startShellNavigation } from "./navigation.js";
import "./shell.css";

/**
 * Application shell for the four learning pages.
 *
 * E4.8c: the desktop navigation is one 64px icon rail on every page (the
 * workbench is no longer the only compact page), and every page keeps the same
 * top bar. Below 900px the rail becomes a sticky bottom navigation. Settings is
 * not repeated in either navigation: it stays reachable from the top-bar action
 * (and by URL), so the learning pages keep a single, focused set of entries.
 */
function NavButton({ page, current, tooltip = false }: { page: ShellPage; current: ShellPage; tooltip?: boolean }) {
	const { t } = useTranslation();
	const meta = pageMeta(page);
	const Icon = meta.icon;
	const active = page === current;
	// Keys, not text: a language switch re-renders this button in place.
	const label = t(meta.labelKey);
	const button = (
		<button
			type="button"
			className="mla-nav-button"
			aria-current={active ? "page" : undefined}
			aria-label={label}
			onClick={() => navigate(page, { history: "push" })}
		>
			<Icon size={18} aria-hidden="true" />
			{/* Long label on desktop, short label once the bottom navigation kicks in. */}
			<span className="mla-nav-label">{label}</span>
			<span className="mla-nav-label-short" aria-hidden="true">{t(meta.shortLabelKey)}</span>
		</button>
	);
	// The desktop rail is icon-only, so it carries the page name on hover and
	// keyboard focus; the bottom navigation already shows its short label.
	return tooltip
		? <Tooltip label={label} description={t(meta.descriptionKey)} side="right">{button}</Tooltip>
		: button;
}

export function AppShell({ children }: { children: ReactNode }) {
	const { t } = useTranslation();
	const { activePage } = useStoreSnapshot(appStore, () => ({ activePage: appStore.activePage }));
	const meta = pageMeta(activePage);
	// Immersive pages (AI 学习, 学习档案) own their insets and scrolling; every
	// other page gets the shared page measure from `.mla-page`.
	const immersive = activePage === "learn" || activePage === "profile";

	useEffect(() => startShellNavigation(), []);

	return (
		<div className="mla-shell">
			<a
				href="#mla-main"
				className="mla-small"
				style={{
					position: "absolute",
					left: -9999,
					top: 0,
					padding: 8,
					background: "var(--inno-surface)",
					color: "var(--inno-accent)",
					zIndex: 100,
				}}
				onFocus={(event) => { event.currentTarget.style.left = "8px"; }}
				onBlur={(event) => { event.currentTarget.style.left = "-9999px"; }}
			>
				{t("shell.skipToContent")}
			</a>

			<header className="mla-topbar">
				<div className="mla-brand">
					<span className="mla-brand-mark" aria-hidden="true">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
							<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
							<path d="M3 12.5 12 17l9-4.5" />
							<path d="M3 17 12 21.5 21 17" />
						</svg>
					</span>
					<span className="mla-brand-text">
						<strong>My Learning Agent</strong>
						<span>{t(meta.labelKey)}</span>
					</span>
				</div>
				<div className="mla-top-actions">
					<button
						type="button"
						className="mla-nav-button"
						aria-label={t("nav.settingsPage.label")}
						onClick={() => navigate("settings", { history: "push" })}
					>
						<Settings2 size={16} aria-hidden="true" />
						<span>{t("nav.settingsPage.short")}</span>
					</button>
				</div>
			</header>

			<div className="mla-body">
				<aside className="mla-sidebar">
					<nav className="mla-nav" aria-label={t("shell.primaryNav")}>
						{NAV_PAGES.map((item) => (
							<NavButton key={item.id} page={item.id} current={activePage} tooltip />
						))}
					</nav>
				</aside>

				<div className="mla-content">
					<main
						id="mla-main"
						className={immersive ? "mla-main mla-main--flush" : "mla-main"}
						tabIndex={-1}
					>
						{immersive ? children : <div className="mla-page">{children}</div>}
					</main>
				</div>
			</div>

			<nav className="mla-bottomnav" aria-label={t("shell.primaryNavMobile")}>
				<div className="mla-nav">
					{NAV_PAGES.map((item) => (
						<NavButton key={item.id} page={item.id} current={activePage} />
					))}
				</div>
			</nav>
		</div>
	);
}
