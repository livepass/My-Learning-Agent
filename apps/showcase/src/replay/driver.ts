import { EventEmitter } from "@inno-web/stores/event-emitter.js";
import { appStore } from "@inno-web/stores/app-store.js";
import { chatStore } from "@inno-web/stores/chat-store.js";
import { learnerStore } from "@inno-web/stores/learner-store.js";
import { sessionsStore } from "@inno-web/stores/sessions-store.js";
import type { CaseDoc } from "../cases.js";
import { fetchCase } from "../cases.js";
import { mockBackend } from "../mock/runtime.js";
import { replayControl } from "../mock/streaming.js";

const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

// Inter-turn pacing: honor the real time gap between turns, clamped so short
// bursts stay readable and long thinking gaps don't bore the viewer.
const TURN_GAP_MIN = 800;
const TURN_GAP_MAX = 4000;

interface ReplayDriverEvents {
	change: void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drives a recorded case through the REAL product chat pipeline: for each
 * recorded user turn it calls chatStore.send(), and the mock backend answers
 * /api/chat/stream with a paced SSE stream rebuilt from the recording. Every
 * pixel of the streaming experience (typing text, thinking, tool chips, the
 * "正在生成内容" file preview, workspace panel auto-open, wiki refresh on
 * l2_archive, canonical history swap on done) is the unmodified product code
 * path reacting to those events.
 *
 * The driver only orchestrates: turn sequencing, pause/speed (via the shared
 * replayControl the SSE producer reads), seek (detach + canonical prefix),
 * and one-time right-panel tab reveals for the notebook/profile panels —
 * the preview panel reveals itself through the store's file-tool machinery.
 */
export class ReplayDriver extends EventEmitter<ReplayDriverEvents> {
	caseId: string | null = null;
	doc: CaseDoc | null = null;
	playing = false;
	speed: Speed = 2;

	private playToken = 0;
	private attachRequestId = 0;
	private lastWikiCount = 0;
	private lastProfileVisible = false;
	private autoOpenedTabs = new Set<string>();

	constructor() {
		super();
		// The real SessionSidebar opens sessions through sessionsStore; treat
		// every newly-opened session as "attach this case to the driver".
		sessionsStore.on("change", () => {
			const id = sessionsStore.currentSessionId;
			if (id && id !== this.caseId) void this.attach(id);
		});
	}

	get step(): number {
		return mockBackend.pointer;
	}

	get total(): number {
		return this.doc?.messages.length ?? 0;
	}

	get finished(): boolean {
		return this.doc !== null && this.step >= this.total;
	}

	async attach(caseId: string): Promise<void> {
		const requestId = ++this.attachRequestId;
		this.playToken++;
		this.playing = false;
		replayControl.paused = false;
		this.doc = null;
		this.lastWikiCount = 0;
		this.lastProfileVisible = false;
		this.autoOpenedTabs.clear();
		this.caseId = caseId;
		chatStore.detach();
		mockBackend.setCurrent(caseId, 0);
		this.emit("change", undefined);

		try {
			const loaded = await fetchCase(caseId);
			if (requestId !== this.attachRequestId) return;
			mockBackend.registerDoc(loaded);
			this.doc = loaded;
			chatStore.loadHistory([], caseId);
			this.play();
		} catch (err) {
			console.error(`[showcase] failed to load case ${caseId}`, err);
		}
		this.emit("change", undefined);
	}

	/** Wait `ms` of scaled time, honoring pause/speed and play invalidation. */
	private async waitGap(ms: number, token: number): Promise<void> {
		let remaining = ms;
		while (remaining > 0 && token === this.playToken) {
			if (replayControl.paused) {
				await sleep(100);
				continue;
			}
			const slice = Math.min(remaining, 100);
			await sleep(slice / replayControl.speed);
			remaining -= slice;
		}
	}

	/** Sequential turn loop — each send() resolves after the turn's canonical
	 *  history reload, at which point the mock pointer has advanced. */
	private async runLoop(token: number): Promise<void> {
		while (this.playing && token === this.playToken) {
			const doc = this.doc;
			if (!doc || !this.caseId) break;
			const pointer = mockBackend.pointer;
			if (pointer >= doc.messages.length) {
				this.playing = false;
				this.emit("change", undefined);
				break;
			}
			const message = doc.messages[pointer];
			if (message.role !== "user") {
				// Assistant message without a preceding user turn (edge): fold it
				// into the canonical prefix directly instead of streaming.
				mockBackend.setCurrent(this.caseId, pointer + 1);
				chatStore.loadHistory(doc.messages.slice(0, pointer + 1), this.caseId);
				this.syncPanels();
				continue;
			}
			if (pointer > 0) {
				const gap = message.timestamp - (doc.messages[pointer - 1]?.timestamp ?? message.timestamp);
				await this.waitGap(Math.min(TURN_GAP_MAX, Math.max(TURN_GAP_MIN, gap)), token);
				if (!this.playing || token !== this.playToken) break;
			}
			try {
				await chatStore.send(message.content, undefined, this.caseId);
			} catch (err) {
				console.warn("[showcase] turn stream failed", err);
				break;
			}
			if (token !== this.playToken) break;
			this.syncPanels();
			this.emit("change", undefined);
		}
	}

	/** One-time right-panel reveals for the panels that don't open themselves:
	 *  the preview panel opens via the store's file-tool machinery; the wiki
	 *  list refresh is triggered by the store on l2_archive completion — the
	 *  driver only switches the tab so the viewer notices. */
	private syncPanels(): void {
		const wikiCount = mockBackend.wikiVisibleCount();
		if (wikiCount > this.lastWikiCount) {
			this.lastWikiCount = wikiCount;
			this.autoOpenPanel("notebook");
		}
		const profileVisible = mockBackend.profileVisible();
		if (profileVisible !== this.lastProfileVisible) {
			this.lastProfileVisible = profileVisible;
			if (profileVisible) {
				void learnerStore.load();
				this.autoOpenPanel("profile");
			}
		}
	}

	private autoOpenPanel(tab: "notebook" | "profile"): void {
		if (this.autoOpenedTabs.has(tab)) return;
		this.autoOpenedTabs.add(tab);
		if (appStore.workspaceMode === "collapsed") {
			appStore.setWorkspaceMode("half");
			appStore.setWorkspaceWidth(560);
		}
		appStore.setRightPanelTab(tab);
	}

	play(): void {
		if (!this.doc) return;
		if (this.finished) this.resetTo(0);
		this.playing = true;
		replayControl.paused = false;
		replayControl.speed = this.speed;
		this.emit("change", undefined);
		// If a turn stream is mid-flight (stalled by pause), unpausing resumes
		// it and the awaiting loop continues on its own.
		if (!chatStore.isSending) void this.runLoop(++this.playToken);
	}

	pause(): void {
		this.playing = false;
		replayControl.paused = true;
		this.emit("change", undefined);
	}

	toggle(): void {
		if (this.playing) this.pause();
		else this.play();
	}

	private resetTo(pointer: number): void {
		this.playToken++;
		chatStore.detach();
		mockBackend.setCurrent(this.caseId, pointer);
		chatStore.loadHistory(this.doc?.messages.slice(0, pointer) ?? [], this.caseId ?? undefined);
		this.lastWikiCount = mockBackend.wikiVisibleCount();
		this.lastProfileVisible = mockBackend.profileVisible();
		this.emit("change", undefined);
	}

	restart(): void {
		this.autoOpenedTabs.clear();
		this.resetTo(0);
		this.play();
	}

	seek(i: number): void {
		this.pause();
		this.resetTo(Math.max(0, Math.min(i, this.total)));
	}

	skipToEnd(): void {
		this.seek(this.total);
	}

	cycleSpeed(): void {
		this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
		replayControl.speed = this.speed;
		this.emit("change", undefined);
	}
}

export const replayDriver = new ReplayDriver();
