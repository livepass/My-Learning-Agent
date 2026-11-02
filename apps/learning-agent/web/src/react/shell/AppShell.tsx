import { useEffect, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { appStore, type ShellPage } from "../../stores/app-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { pageMeta, SHELL_PAGE_META, navigate, startShellNavigation } from "./navigation.js";
import "./shell.css";

/**
 * Application shell for the five learning pages.
 *
 * Desktop keeps the fixed sidebar described by the prototype; below 900px the
 * sidebar collapses into a sticky bottom navigation. Settings stays reachable
 * from both the navigation and the top-bar action.
 */
function NavButton({ page, current }: { page: ShellPage; current: ShellPage }) {
	const meta = pageMeta(page);
	const Icon = meta.icon;
	const active = page === current;
	return (
		<button
			type="button"
			className="mla-nav-button"
			aria-current={active ? "page" : undefined}
			aria-label={meta.label}
			onClick={() => navigate(page, { history: "push" })}
		>
			<Icon size={18} aria-hidden="true" />
			{/* Long label on desktop, short label once the bottom navigation kicks in. */}
			<span className="mla-nav-label">{meta.label}</span>
			<span className="mla-nav-label-short" aria-hidden="true">{meta.shortLabel}</span>
		</button>
	);
}

export function AppShell({ children }: { children: ReactNode }) {
	const { activePage } = useStoreSnapshot(appStore, () => ({ activePage: appStore.activePage }));
	const meta = pageMeta(activePage);

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
				跳到主要内容
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
						<span>{meta.label}</span>
					</span>
				</div>
				<div className="mla-top-actions">
					<button
						type="button"
						className="mla-nav-button"
						aria-label="设置"
						onClick={() => navigate("settings", { history: "push" })}
					>
						<Settings2 size={16} aria-hidden="true" />
						<span>设置</span>
					</button>
				</div>
			</header>

			<div className="mla-body">
				<aside className="mla-sidebar">
					<nav className="mla-nav" aria-label="主导航">
						{SHELL_PAGE_META.map((item) => (
							<NavButton key={item.id} page={item.id} current={activePage} />
						))}
					</nav>
					<div className="mla-sidebar-block">
						<span className="mla-overline">学习模式</span>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							对话、检查点与学习档案来自本机真实数据；出题与评分尚未开放。
						</p>
					</div>
					<div className="mla-sidebar-foot">
						数据保存在本机数据目录，不会上传到第三方服务。
					</div>
				</aside>

				<div className="mla-content">
					<main
						id="mla-main"
						className={activePage === "learn" || activePage === "profile" ? "mla-main mla-main--flush" : "mla-main"}
						tabIndex={-1}
					>
						{children}
					</main>
				</div>
			</div>

			<nav className="mla-bottomnav" aria-label="主导航（移动端）">
				<div className="mla-nav">
					{SHELL_PAGE_META.map((item) => (
						<NavButton key={item.id} page={item.id} current={activePage} />
					))}
				</div>
			</nav>
		</div>
	);
}
