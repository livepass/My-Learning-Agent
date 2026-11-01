import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { useStoreSnapshot } from "@inno-web/react/hooks.js";
import { replayDriver } from "./driver.js";

/**
 * Floating replay transport, overlaid at the top of the chat column. This is
 * the only piece of UI the showcase adds on top of the unmodified product
 * components.
 */
export function ReplayTransport() {
	const snap = useStoreSnapshot(replayDriver, () => ({
		caseId: replayDriver.caseId,
		ready: replayDriver.doc !== null,
		step: replayDriver.step,
		total: replayDriver.total,
		playing: replayDriver.playing,
		finished: replayDriver.finished,
		speed: replayDriver.speed,
	}));

	if (!snap.caseId) return null;

	return (
		<div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2">
			<div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface)]/95 py-1 pl-1.5 pr-2.5 shadow-[var(--inno-shadow-soft)] backdrop-blur">
				<button
					onClick={() => replayDriver.toggle()}
					disabled={!snap.ready}
					className="inno-icon-button flex h-7 w-7 items-center justify-center rounded-full disabled:opacity-50"
					title={snap.playing && !snap.finished ? "暂停" : "播放"}
				>
					{snap.playing && !snap.finished ? <Pause size={13} /> : <Play size={13} />}
				</button>
				<button
					onClick={() => replayDriver.restart()}
					disabled={!snap.ready}
					className="inno-icon-button flex h-7 w-7 items-center justify-center rounded-full disabled:opacity-50"
					title="从头播放"
				>
					<RotateCcw size={12} />
				</button>
				<input
					type="range"
					min={0}
					max={snap.total}
					value={snap.step}
					disabled={!snap.ready}
					onChange={(e) => replayDriver.seek(Number(e.target.value))}
					className="inno-replay-slider w-32 sm:w-52"
				/>
				<span className="shrink-0 text-[10px] tabular-nums text-[var(--inno-text-subtle)]">
					{snap.step}/{snap.total}
				</span>
				<button
					onClick={() => replayDriver.cycleSpeed()}
					className="shrink-0 rounded-full border border-[var(--inno-border)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
					title="切换倍速"
				>
					{snap.speed}×
				</button>
				<button
					onClick={() => replayDriver.skipToEnd()}
					disabled={!snap.ready}
					className="inno-icon-button flex h-7 w-7 items-center justify-center rounded-full disabled:opacity-50"
					title="跳到结尾"
				>
					<SkipForward size={12} />
				</button>
				<span className="ml-0.5 hidden shrink-0 rounded-full bg-[var(--inno-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--inno-accent)] sm:inline">
					会话回放
				</span>
			</div>
		</div>
	);
}
