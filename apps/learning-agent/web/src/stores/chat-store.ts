import { EventEmitter } from "./event-emitter.js";
import { streamChat, abortChat, getChatStatus, streamSessionEvents, submitChatQuestion, submitChatPermission, formatQuestionnaireAsPrompt } from "../api/chat.js";
import { getSession } from "../api/sessions.js";
import type { InlineImage } from "../api/chat.js";
import type { ChatAttachments, ChatMessage, ChatStreamEvent, ChatToolRecord, ChatTraceStep, PendingPermission, PendingQuestion, PermissionDecisionKind, QuestionnaireResult, StreamEventEnvelope, StreamSnapshot } from "../types/chat.js";
import { sessionsStore } from "./sessions-store.js";
import { applyChatTraceEvent, finalizeTraceSteps, traceStepsFromEvents, traceTerminalState } from "../utils/chat-trace.js";

function hasAttachmentFiles(attachments?: ChatAttachments): boolean {
	return Boolean(attachments && (attachments.bindings.some((binding) => binding.files.length > 0) || attachments.loose.length > 0));
}

/**
 * The user message "regenerate" would re-send for a cold-loaded session.
 * Only the most recent user turn qualifies, and only when the history alone
 * can replay it: channel/scheduler turns, image uploads and file-attachment
 * turns all carry context that is lost on reload, so they stay non-retryable.
 */
function lastRetryableUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		if (message.channel && message.channel !== "web") return undefined;
		if (message.images?.length) return undefined;
		if (hasAttachmentFiles(message.attachments)) return undefined;
		if (!message.content.trim()) return undefined;
		return message;
	}
	return undefined;
}

function createClientRequestId(): string {
	try {
		if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	} catch {
		// randomUUID is unavailable in some non-secure or embedded browser contexts.
	}

	const bytes = new Uint8Array(16);
	try {
		if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
		else throw new Error("Web Crypto unavailable");
	} catch {
		for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Flush interval for streaming text/thinking updates. 40ms (~25fps) is the
// floor for motion to read as continuous rather than stepped; rendering cost
// per flush is bounded by the block-split in StreamingBubbles (only the
// incomplete tail re-parses), so a faster cadence is affordable.
const STREAM_CHANGE_INTERVAL_MS = 40;

interface ChatStoreEvents {
	change: void;
}

interface ActiveStreamOwner {
	sessionId: string;
	clientRequestId: string;
	turnId: string | null;
	generation: number;
	controller: AbortController;
	lastAppliedEventId: number;
	cancellationRequested: boolean;
	terminalEvent?: TerminalChatStreamEvent;
	phase: "submitting" | "streaming" | "cancelling" | "reconnecting" | "reloading_history";
}

type TerminalChatStreamEvent = Extract<ChatStreamEvent, { type: "done" | "error" | "aborted" }>;

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

/** A stream with no events for this long after a page resume is presumed dead. */
const STREAM_STALE_AFTER_RESUME_MS = 10_000;

export class ChatStoreImpl extends EventEmitter<ChatStoreEvents> {
	messages: ChatMessage[] = [];
	isSending = false;
	/** Terminal outcome of the last send, used by the edit flow to keep a
	 *  replaced turn's draft when the branch landed but the resend failed. */
	lastSendOutcome: "completed" | "error" | "aborted" | null = null;
	/** Set while fetching persisted history for a session. */
	isLoadingHistory = false;
	streamingText = "";
	streamingThinking = "";
	/** Ordered logical process rows for the in-flight PI turn. */
	streamingTrace: ChatTraceStep[] = [];
	streamingStartedAt: string | null = null;
	streamingFinishedAt: string | null = null;
	streamingActivity = "";
	streamingActivityDetail = "";
	/** Backend/model error for the in-flight turn, surfaced in the UI (collapsible). */
	streamingError = "";
	/** Active tool calls in progress */
	activeTools: ChatToolRecord[] = [];
	completedTools: ChatToolRecord[] = [];
	/** Last user prompt sent, kept so users can Retry. */
	lastUserPrompt: string | null = null;
	/** Images from the last send, kept so users can Retry. */
	lastImages: InlineImage[] | undefined = undefined;
	/** Pending question from agent's ask_user_question tool */
	pendingQuestion: PendingQuestion | null = null;
	/** Question IDs the user has already answered. Suppresses stale replays
	 *  (backend may re-push a question event before the answer POST lands) and
	 *  guards restored cards against reappearing from a stale cache. */
	private answeredQuestionIds = new Set<string>();
	/** Pending permission ask from pi-permission-system's gate (web approval card). */
	pendingPermission: PendingPermission | null = null;
	/** Permission request IDs the user already decided. Suppresses stale replays. */
	private answeredPermissionIds = new Set<string>();
	/** Tool calls swapped to a completed questionnaire card before the answer
	 *  POST returned. tool_end removes the id; a submit failure may only roll
	 *  the card back while the id is still here — once tool_end landed, the
	 *  server already consumed the answer and restoring the editable card
	 *  would resurrect a resolved question. */
	private optimisticQuestionToolIds = new Set<string>();
	canReconnect = false;
	private streamChangeTimer: ReturnType<typeof setTimeout> | null = null;
	private activeOwner: ActiveStreamOwner | null = null;
	private ownerGeneration = 0;
	private currentSessionContext: string | null = null;
	/** Last time any stream envelope was applied; a stale value after a page
	 *  resume means the in-flight stream likely died while suspended. */
	private lastStreamActivityAt = 0;
	private retryInputBySession = new Map<string, { prompt: string; images?: InlineImage[]; attachments?: ChatAttachments }>();

	async send(prompt: string, images?: InlineImage[], sessionIdOverride?: string | null, attachments?: ChatAttachments): Promise<void> {
		if ((!prompt.trim() && !images?.length && !hasAttachmentFiles(attachments)) || this.isSending) return;
		const targetSessionId = sessionIdOverride === undefined
			? sessionsStore.currentSessionId
			: sessionIdOverride;
		if (!targetSessionId || this.isSending) return;

		this.lastSendOutcome = null;
		this.currentSessionContext = targetSessionId;
		this.retryInputBySession.set(targetSessionId, { prompt, images, attachments });
		this.lastUserPrompt = prompt;
		this.lastImages = images;
		this.messages = [...this.messages, {
			role: "user",
			content: prompt,
			timestamp: Date.now(),
			images: images?.map(({ data, mimeType }) => ({
				previewUrl: `data:${mimeType};base64,${data}`,
				mimeType,
			})),
			attachments,
			transient: true,
			complete: false,
		}];
		this.resetTransientStreamState();
		this.streamingStartedAt = new Date().toISOString();
		this.isSending = true;
		this.setStreamingActivity("正在分析请求");
		const controller = new AbortController();
		const owner: ActiveStreamOwner = {
			sessionId: targetSessionId,
			clientRequestId: createClientRequestId(),
			turnId: null,
			generation: ++this.ownerGeneration,
			controller,
			lastAppliedEventId: 0,
			cancellationRequested: false,
			phase: "submitting",
		};
		this.activeOwner = owner;
		this.lastStreamActivityAt = Date.now();
		this.emit("change", undefined);

		try {
			for await (const envelope of streamChat(prompt, targetSessionId, owner.clientRequestId, controller.signal, images, attachments)) {
				await this._handleStreamEnvelope(owner, envelope);
			}
			if (this.owns(owner) && !owner.terminalEvent) {
				await this.reconnectOwner(owner, new Error("实时连接提前结束"));
			}
		} catch (err) {
			if (!this.owns(owner) || owner.controller.signal.aborted || owner.terminalEvent) return;
			const bound = await this.bindOwnerFromStatus(owner);
			if (!this.owns(owner)) return;
			if (!bound) {
				const message = err instanceof Error ? err.message : "提交请求失败";
				this.lastSendOutcome = "error";
				this.materializeTransientTurn(owner, message);
				this.finalizeOwner(owner);
				return;
			}
			await this.reconnectOwner(owner, err);
		}
	}

	/**
	 * Abort the in-flight stream. Called when user clicks the stop button —
	 * the only path that actually stops the backend task.
	 */
	cancel(): void {
		const owner = this.activeOwner;
		if (!owner) return;
		owner.cancellationRequested = true;
		owner.phase = "cancelling";
		this.canReconnect = false;
		this.setStreamingActivity("正在取消");
		this.emit("change", undefined);
		void this.cancelOwnedTurn(owner);
	}

	/**
	 * Detach from the current stream without stopping the backend task.
	 * Used when the user navigates to a different session.
	 */
	detach(): void {
		this.activeOwner?.controller.abort();
		this.activeOwner = null;
		this.ownerGeneration++;
		this.isSending = false;
		this.canReconnect = false;
		this.currentSessionContext = null;
		this.lastUserPrompt = null;
		this.lastImages = undefined;
		this.resetTransientStreamState();
		this.emit("change", undefined);
	}

	private async cancelOwnedTurn(owner: ActiveStreamOwner): Promise<void> {
		try {
			if (!owner.turnId) await this.bindOwnerFromStatus(owner);
			if (!this.owns(owner)) return;
			if (!owner.turnId) throw new Error("尚未确认服务端任务，请重试停止操作");
			await abortChat(owner.sessionId, owner.turnId);
			if (!this.owns(owner)) return;
			this.setStreamingActivity("正在等待任务停止");
			this.emit("change", undefined);
		} catch (err) {
			if (this.owns(owner)) {
				this.canReconnect = true;
				this.streamingError = err instanceof Error ? err.message : "无法停止该任务";
				this.emit("change", undefined);
			}
		}
	}

	/**
	 * Reconnect to an in-progress session's backend event stream.
	 * Replays history and continues receiving live events.
	 */
	async resumeStream(sessionId: string, snapshot?: StreamSnapshot): Promise<void> {
		if (this.isSending) return;
		const stream = snapshot ?? (await getChatStatus(sessionId)).stream;
		if (!stream || !["queued", "running"].includes(stream.status)) return;
		if (!Number.isInteger(stream.baselineMessageCount) || stream.baselineMessageCount < 0) {
			this.streamingError = "该任务缺少恢复基线，无法安全恢复实时内容";
			this.emit("change", undefined);
			return;
		}
		this.currentSessionContext = sessionId;
		this.resetTransientStreamState();
		this.streamingStartedAt = stream.startedAt ?? stream.createdAt;
		this.isSending = true;
		this.streamingActivity = "正在恢复生成";
		const controller = new AbortController();
		const owner: ActiveStreamOwner = {
			sessionId,
			clientRequestId: stream.clientRequestId,
			turnId: stream.turnId,
			generation: ++this.ownerGeneration,
			controller,
			lastAppliedEventId: 0,
			cancellationRequested: stream.cancelRequested,
			phase: "reconnecting",
		};
		this.activeOwner = owner;
		this.messages = [
			...this.messages.slice(0, stream.baselineMessageCount),
			{
				role: "user",
				content: stream.inputSnapshot.prompt,
				timestamp: Date.parse(stream.inputSnapshot.submittedAt) || Date.now(),
				images: stream.inputSnapshot.images
					.filter((image) => image.previewUrl)
					.map((image) => ({ previewUrl: image.previewUrl!, mimeType: image.mimeType })),
				attachments: stream.inputSnapshot.attachments,
				turnId: stream.turnId,
				transient: true,
				complete: false,
			},
		];
		this.emit("change", undefined);

		try {
			for await (const envelope of streamSessionEvents(sessionId, stream.turnId, 0, controller.signal)) {
				await this._handleStreamEnvelope(owner, envelope);
			}
			if (this.owns(owner) && !owner.terminalEvent) {
				await this.reconnectOwner(owner, new Error("恢复连接提前结束"));
			}
		} catch (err) {
			if (this.owns(owner) && !controller.signal.aborted && !owner.terminalEvent) {
				await this.reconnectOwner(owner, err);
			}
		}
	}

	/** Re-send the last user prompt. No-op while a send is in flight. */
	async retry(): Promise<void> {
		if (this.isSending || !this.currentSessionContext) return;
		const input = this.retryInputBySession.get(this.currentSessionContext);
		if (!input) return;
		await this.send(input.prompt, input.images, undefined, input.attachments);
	}

	/** Retry a failed event reconnect or final-history confirmation. */
	async reconnect(): Promise<void> {
		const owner = this.activeOwner;
		if (!owner || !this.canReconnect) return;
		this.canReconnect = false;
		this.streamingError = "";
		if (owner.terminalEvent) {
			await this.handleTerminal(owner, owner.terminalEvent);
		} else {
			await this.reconnectOwner(owner, new Error("用户请求重新连接"));
		}
	}

	/**
	 * Re-arm stream recovery when a backgrounded page returns to the foreground.
	 * Mobile browsers suspend timers and kill in-flight fetch streams while
	 * hidden, and the short reconnect backoff is usually exhausted before the OS
	 * wakes the network stack — leaving recovery to a manual tap. On resume we
	 * either retry an already-failed recovery, or proactively restart a stream
	 * that has gone stale. Event application is idempotent (eventId dedupe in
	 * _handleStreamEnvelope), so racing a still-alive stream cannot double-apply.
	 */
	async handleAppResume(): Promise<void> {
		const owner = this.activeOwner;
		if (!owner) return;
		if (this.canReconnect) {
			await this.reconnect();
			return;
		}
		if (owner.terminalEvent) return;
		if (Date.now() - this.lastStreamActivityAt < STREAM_STALE_AFTER_RESUME_MS) return;
		await this.reconnectOwner(owner, new Error("页面回到前台，主动恢复连接"));
	}

	private owns(owner: ActiveStreamOwner): boolean {
		return this.activeOwner === owner && this.activeOwner.generation === owner.generation;
	}

	private async bindOwnerFromStatus(owner: ActiveStreamOwner): Promise<boolean> {
		for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
			if (!this.owns(owner)) return false;
			try {
				const status = await getChatStatus(owner.sessionId);
				if (status.stream?.clientRequestId === owner.clientRequestId) {
					owner.turnId = status.stream.turnId;
					return true;
				}
			} catch {
				// A just-submitted request may not be visible yet; retry below.
			}
			if (attempt < RECONNECT_DELAYS_MS.length - 1) await delay(RECONNECT_DELAYS_MS[attempt]);
		}
		return false;
	}

	private async reconnectOwner(owner: ActiveStreamOwner, cause: unknown): Promise<void> {
		if (!this.owns(owner) || owner.terminalEvent) return;
		owner.phase = "reconnecting";
		this.setStreamingActivity("连接中断，正在重连");
		this.emit("change", undefined);
		let lastError = cause;
		for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
			if (!this.owns(owner) || owner.terminalEvent) return;
			if (attempt > 0) await delay(RECONNECT_DELAYS_MS[attempt - 1]);
			try {
				if (!owner.turnId && !(await this.bindOwnerFromStatus(owner))) continue;
				if (!owner.turnId || !this.owns(owner)) return;
				const status = await getChatStatus(owner.sessionId);
				if (!status.stream || status.stream.turnId !== owner.turnId || status.stream.clientRequestId !== owner.clientRequestId) {
					throw new Error("服务端任务状态已不可用");
				}
				const reconnectController = new AbortController();
				owner.controller = reconnectController;
				for await (const envelope of streamSessionEvents(owner.sessionId, owner.turnId, owner.lastAppliedEventId, reconnectController.signal)) {
					await this._handleStreamEnvelope(owner, envelope);
				}
				if (!this.owns(owner) || owner.terminalEvent) return;
				lastError = new Error("重连后事件流提前结束");
			} catch (error) {
				if (!this.owns(owner) || owner.controller.signal.aborted) return;
				lastError = error;
			}
		}
		this.failRecovery(owner, lastError, "实时连接恢复失败，请重新连接");
	}

	private async _handleStreamEnvelope(owner: ActiveStreamOwner, envelope: StreamEventEnvelope): Promise<void> {
		if (!this.owns(owner) || envelope.sessionId !== owner.sessionId || envelope.clientRequestId !== owner.clientRequestId) return;
		this.lastStreamActivityAt = Date.now();
		if (owner.turnId === null) owner.turnId = envelope.turnId;
		if (owner.turnId !== envelope.turnId || envelope.eventId <= owner.lastAppliedEventId) return;
		owner.lastAppliedEventId = envelope.eventId;
		if (envelope.event.type === "stream_state" && envelope.event.status === "running") owner.phase = "streaming";
		this._handleStreamEvent(envelope.event, owner, envelope.occurredAt);
		if (!["done", "error", "aborted"].includes(envelope.event.type)) return;
		await this.handleTerminal(owner, envelope.event as TerminalChatStreamEvent);
	}

	private async handleTerminal(owner: ActiveStreamOwner, terminal: TerminalChatStreamEvent): Promise<void> {
		if (!this.owns(owner)) return;
		this.lastSendOutcome = terminal.type === "done"
			? (terminal.persisted ? "completed" : "error")
			: terminal.type === "aborted" ? "aborted" : "error";
		owner.terminalEvent = terminal;
		owner.phase = "reloading_history";
		if (!terminal.persisted) {
			const message = terminal.type === "error" ? terminal.message : terminal.message ?? "最终记录尚未确认";
			this.materializeTransientTurn(owner, message);
			this.finalizeOwner(owner);
			return;
		}
		const loaded = await this.reloadCanonicalHistory(owner, terminal.finalMessageCount, terminal.finalSessionRevision);
		if (loaded) this.finalizeOwner(owner);
		else this.failRecovery(owner, new Error("最终记录尚未确认"), "最终记录尚未确认，请重新加载");
	}

	private async reloadCanonicalHistory(owner: ActiveStreamOwner, finalMessageCount?: number, finalRevision?: string): Promise<boolean> {
		for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
			try {
				const session = await getSession(owner.sessionId);
				if (!this.owns(owner)) return false;
				const countMatches = finalMessageCount !== undefined && session.messageCount >= finalMessageCount;
				const revisionMatches = Boolean(finalRevision) && session.sessionRevision === finalRevision;
				if (countMatches || revisionMatches) {
					const history = this.withTraceMessages(session.messages);
					// Showcase replay and older servers do not return the new sidecar
					// fields. Keep the just-rendered live trace attached to the newest
					// canonical assistant message so the timeline does not disappear at
					// the done -> history swap boundary.
					let assistantIndex = -1;
					for (let index = history.length - 1; index >= 0; index -= 1) {
						if (history[index]?.role === "assistant") {
							assistantIndex = index;
							break;
						}
					}
					const canonicalTrace = assistantIndex >= 0 ? history[assistantIndex] : undefined;
					const hasCanonicalTrace = Boolean(
						canonicalTrace?.traceEvents?.length
						|| canonicalTrace?.trace?.some((step) => step.kind !== "skill"),
					);
					if (this.streamingTrace.length && !hasCanonicalTrace) {
						if (assistantIndex >= 0) {
							history[assistantIndex] = {
								...history[assistantIndex]!,
								trace: finalizeTraceSteps(this.streamingTrace),
								traceStartedAt: this.streamingStartedAt ?? undefined,
								traceFinishedAt: this.streamingFinishedAt ?? new Date().toISOString(),
							};
						}
					}
					this.messages = history.map((message) => ({ ...message, complete: true, transient: false }));
					this.emit("change", undefined);
					return true;
				}
			} catch {
				// The JSONL write may not be visible to this request yet.
			}
			if (attempt < RECONNECT_DELAYS_MS.length - 1) await delay(RECONNECT_DELAYS_MS[attempt]);
		}
		return false;
	}

	private withTraceMessages(messages: ChatMessage[]): ChatMessage[] {
		return messages.map((message) => {
			if (message.role !== "assistant" || message.trace || !message.traceEvents?.length) return message;
			const terminalState = traceTerminalState(message.traceEvents, message.stopReason, message.error);
			const traceSteps = traceStepsFromEvents(message.traceEvents);
			return {
				...message,
				trace: terminalState?.status === "unknown" ? traceSteps : finalizeTraceSteps(traceSteps),
			};
		});
	}

	private materializeTransientTurn(owner: ActiveStreamOwner, error: string): void {
		if (!this.owns(owner)) return;
		this.messages = [...this.messages, {
			role: "assistant",
			content: this.streamingText,
			timestamp: Date.now(),
			thinking: this.streamingThinking || undefined,
			tools: this.completedTools.length ? this.completedTools : undefined,
			trace: this.streamingTrace.length ? finalizeTraceSteps(this.streamingTrace) : undefined,
			traceStartedAt: this.streamingStartedAt ?? undefined,
			traceFinishedAt: this.streamingFinishedAt ?? new Date().toISOString(),
			error,
			turnId: owner.turnId ?? undefined,
			transient: true,
			complete: false,
		}];
	}

	private failRecovery(owner: ActiveStreamOwner, error: unknown, prefix: string): void {
		if (!this.owns(owner)) return;
		this.lastSendOutcome = "error";
		this.canReconnect = true;
		const detail = error instanceof Error ? error.message : String(error);
		this.streamingError = detail && detail !== prefix ? `${prefix}：${detail}` : prefix;
		this.emit("change", undefined);
	}

	private finalizeOwner(owner: ActiveStreamOwner): void {
		if (!this.owns(owner)) return;
		this.flushStreamChange();
		this.activeOwner = null;
		this.isSending = false;
		this.canReconnect = false;
		this.resetTransientStreamState();
		this.emit("change", undefined);
		void sessionsStore.refreshUntilTopic(owner.sessionId);
	}

	private _handleStreamEvent(event: ChatStreamEvent, owner: ActiveStreamOwner, occurredAt?: string) {
		this.streamingTrace = applyChatTraceEvent(this.streamingTrace, event, occurredAt);
		if (event.type === "stream_state" && event.status === "running" && occurredAt) {
			this.streamingStartedAt = occurredAt;
		}
		if (["done", "error", "aborted"].includes(event.type)) {
			this.streamingFinishedAt = occurredAt ?? new Date().toISOString();
		}
		switch (event.type) {
			case "stream_state":
				this.setStreamingActivity(event.status === "queued" ? "等待执行" : "正在分析请求");
				this.emit("change", undefined);
				break;
			case "text_delta":
				this.streamingText += event.delta;
				this.setStreamingActivity("正在组织回复");
				this.scheduleStreamChange();
				break;
			case "thinking_delta":
				this.streamingThinking += event.delta;
				this.scheduleStreamChange();
				break;
			case "tool_call_start":
			case "tool_call_delta":
			case "tool_call_end":
				// The trace row is created from the assistant's tool-call events,
				// before the tool has finished generating its arguments or emitted
				// the question event. Publish the start immediately so the row stays
				// above the question card for the whole interaction.
				if (event.type === "tool_call_delta") this.scheduleStreamChange();
				else this.flushStreamChange();
				break;
			case "tool_start":
				this.flushStreamChange();
					this.activeTools = [...this.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId), {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
					// Questionnaire options sit one level deeper than the generic tool
					// payload compactor keeps. Preserve this small, bounded payload so
					// the completed card can render every option immediately.
					args: event.toolName === "ask_user_question" ? event.args : compactToolPayload(event.args),
					contentOffset: this.streamingText.length,
				}];
					this.emit("change", undefined);
					break;
			case "tool_update": {
				const existingTool = this.activeTools.find((tool) => tool.toolCallId === event.toolCallId);
				const updatedTool: ChatToolRecord = {
					...(existingTool ?? {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: undefined,
						contentOffset: this.streamingText.length,
					}),
					toolName: event.toolName || existingTool?.toolName || "tool",
					...(event.args !== undefined
						? { args: event.toolName === "ask_user_question" ? event.args : compactToolPayload(event.args) }
						: {}),
					...(event.partialResult !== undefined ? { partialResult: compactToolPayload(event.partialResult) } : {}),
				};
				this.activeTools = [
					...this.activeTools.filter((tool) => tool.toolCallId !== event.toolCallId),
					updatedTool,
				];
				this.scheduleStreamChange();
				break;
			}
			case "tool_end":
				this.flushStreamChange();
				this.optimisticQuestionToolIds.delete(event.toolCallId);
				const existingTool = this.completedTools.find((tool) => tool.toolCallId === event.toolCallId)
					?? this.activeTools.find((tool) => tool.toolCallId === event.toolCallId);
				this.completedTools = [
					...this.completedTools.filter((tool) => tool.toolCallId !== event.toolCallId),
					{
						...(existingTool ?? {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: undefined,
						}),
						result: event.toolName === "ask_user_question" ? event.result : compactToolPayload(event.result),
						isError: event.isError,
					},
				];
				this.activeTools = this.activeTools.filter(
					(t) => t.toolCallId !== event.toolCallId,
				);
				this.emit("change", undefined);
				break;
			case "error":
				this.flushStreamChange();
				// Keep the error separate from the reply text so the UI can render
				// it as a distinct, collapsible block rather than inline markdown.
				this.streamingError = this.streamingError
					? `${this.streamingError}\n${event.message}`
					: event.message;
				this.emit("change", undefined);
				break;
			case "question":
				// Skip replays of questions the user already answered (the backend
				// may still hold the pending question briefly after the answer POST).
				if (this.answeredQuestionIds.has(event.questionId)) break;
				this.flushStreamChange();
				this.pendingQuestion = {
					questionId: event.questionId,
					params: event.params,
					sessionId: owner.sessionId,
					turnId: owner.turnId ?? undefined,
				};
				this.emit("change", undefined);
				break;
			case "question_resolved":
				if (this.pendingQuestion?.questionId === event.questionId) this.pendingQuestion = null;
				this.emit("change", undefined);
				break;
			case "permission_request":
				// Skip replays of asks the user already decided (the backend may
				// re-push the event briefly after the decision POST lands).
				if (this.answeredPermissionIds.has(event.requestId)) break;
				this.flushStreamChange();
				this.pendingPermission = {
					requestId: event.requestId,
					source: event.source ?? "tool_call",
					surface: event.surface ?? null,
					value: event.value ?? null,
					toolName: event.toolName ?? null,
					command: event.command ?? null,
					path: event.path ?? null,
					agentName: event.agentName ?? null,
					forwardedFrom: event.forwardedFrom ?? null,
					preview: event.preview ?? null,
					sessionId: owner.sessionId,
					turnId: owner.turnId ?? undefined,
				};
				this.emit("change", undefined);
				break;
			case "permission_resolved":
				if (this.pendingPermission?.requestId === event.requestId) this.pendingPermission = null;
				this.emit("change", undefined);
				break;
			case "done":
				this.flushStreamChange();
				// Final message set with full content
				if (event.fullText) {
					this.streamingText = event.fullText;
				}
				this.emit("change", undefined);
				break;
			case "aborted":
				this.streamingError = event.message ?? "Stopped by user";
				this.emit("change", undefined);
				break;
			default:
				// Trace-only events (system_event, skill_loaded, skill_invoked,
				// text/thinking boundaries) still mutate streamingTrace via
				// applyChatTraceEvent above — publish so the UI renders them even
				// when no other event follows (e.g. auto_retry_start during a
				// long provider stall).
				this.scheduleStreamChange();
				break;
		}
	}

	private scheduleStreamChange(): void {
		if (this.streamChangeTimer) return;
		this.streamChangeTimer = setTimeout(() => this.flushStreamChange(), STREAM_CHANGE_INTERVAL_MS);
	}

	private flushStreamChange(): void {
		if (this.streamChangeTimer) {
			clearTimeout(this.streamChangeTimer);
			this.streamChangeTimer = null;
		}
		this.emit("change", undefined);
	}

	private resetStreamTimers(): void {
		if (this.streamChangeTimer) clearTimeout(this.streamChangeTimer);
		this.streamChangeTimer = null;
	}

	private resetTransientStreamState(): void {
		this.resetStreamTimers();
		this.streamingText = "";
		this.streamingThinking = "";
		this.streamingTrace = [];
		this.streamingStartedAt = null;
		this.streamingFinishedAt = null;
		this.streamingActivity = "";
		this.streamingActivityDetail = "";
		this.streamingError = "";
		this.activeTools = [];
		this.completedTools = [];
		this.optimisticQuestionToolIds.clear();
		this.pendingQuestion = null;
		this.pendingPermission = null;
	}

	private setStreamingActivity(label: string, detail = ""): void {
		if (this.streamingActivity === label && this.streamingActivityDetail === detail) return;
		this.streamingActivity = label;
		this.streamingActivityDetail = detail;
		this.scheduleStreamChange();
	}

	async submitQuestionResponse(questionId: string, result: QuestionnaireResult): Promise<void> {
		const pending = this.pendingQuestion;
		if (pending?.questionId !== questionId) return;
		// Live cards take the scope from the active stream owner; restored cards
		// (persisted across a restart) carry their own stale scope — the backend
		// detects the dead turn and asks us to resend the answer as a new turn.
		const sessionId = this.activeOwner?.sessionId ?? pending.sessionId;
		const turnId = this.activeOwner?.turnId ?? pending.turnId;
		if (!sessionId || !turnId) return;
		this.answeredQuestionIds.add(questionId);
		const activeQuestionTool = this.activeTools.find((tool) => tool.toolName === "ask_user_question");
		const optimisticToolCallId = !result.cancelled ? activeQuestionTool?.toolCallId : undefined;
		// Swap the editable card for a complete read-only card immediately. The
		// eventual tool_end event reuses this record and replaces only its result,
		// so subsequent streamed text grows below it without changing the card.
		this.pendingQuestion = null;
		if (activeQuestionTool && !result.cancelled) {
			this.optimisticQuestionToolIds.add(activeQuestionTool.toolCallId);
			this.activeTools = this.activeTools.filter((tool) => tool.toolCallId !== activeQuestionTool.toolCallId);
			this.completedTools = [
				...this.completedTools.filter((tool) => tool.toolCallId !== activeQuestionTool.toolCallId),
				{
					...activeQuestionTool,
					args: pending.params,
					result,
					isError: false,
				},
			];
		}
		this.emit("change", undefined);
		try {
			const response = await submitChatQuestion(sessionId, turnId, questionId, result);
			if (response.expired) {
				// The original turn is gone: consume the card and resubmit the
				// answer as a normal user prompt so the agent resumes from the
				// session history.
				this.pendingQuestion = null;
				this.emit("change", undefined);
				await this.send(formatQuestionnaireAsPrompt(result));
			}
		} catch (err) {
			if (!this.activeOwner || this.owns(this.activeOwner)) {
				// Roll back only while the optimistic card is still ours. If
				// tool_end already arrived, the server consumed the answer
				// despite the failed POST — keep the completed card and only
				// surface the error instead of resurrecting the question.
				if (optimisticToolCallId && this.optimisticQuestionToolIds.has(optimisticToolCallId)) {
					this.optimisticQuestionToolIds.delete(optimisticToolCallId);
					this.completedTools = this.completedTools.filter((tool) => tool.toolCallId !== optimisticToolCallId);
					if (activeQuestionTool) this.activeTools = [...this.activeTools, activeQuestionTool];
					this.pendingQuestion = pending;
					this.answeredQuestionIds.delete(questionId);
				}
				this.streamingError = err instanceof Error ? err.message : "提交回答失败";
				this.emit("change", undefined);
			}
		}
	}

	async dismissQuestion(questionId: string): Promise<void> {
		await this.submitQuestionResponse(questionId, { answers: [], cancelled: true });
	}

	async submitPermissionResponse(requestId: string, decision: PermissionDecisionKind, reason?: string): Promise<void> {
		const pending = this.pendingPermission;
		if (pending?.requestId !== requestId) return;
		// Live cards take the scope from the active stream owner; job-stream
		// cards carry their own run scope on the pending record.
		const sessionId = this.activeOwner?.sessionId ?? pending.sessionId;
		const turnId = this.activeOwner?.turnId ?? pending.turnId;
		if (!sessionId || !turnId) return;
		this.answeredPermissionIds.add(requestId);
		this.pendingPermission = null;
		this.emit("change", undefined);
		try {
			await submitChatPermission(sessionId, turnId, requestId, decision, reason);
		} catch (err) {
			if (!this.activeOwner || this.owns(this.activeOwner)) {
				this.pendingPermission = pending;
				this.answeredPermissionIds.delete(requestId);
				this.streamingError = err instanceof Error ? err.message : "提交审批失败";
				this.emit("change", undefined);
			}
		}
	}

	clear() {
		this.detach();
		this.lastSendOutcome = null;
		this.messages = [];
		this.answeredQuestionIds.clear();
		this.answeredPermissionIds.clear();
		this.optimisticQuestionToolIds.clear();
		this.emit("change", undefined);
	}

	loadHistory(messages: ChatMessage[], sessionId?: string) {
		this.isLoadingHistory = false;
		this.messages = this.withTraceMessages(messages);
		this.isSending = false;
		this.lastSendOutcome = null;
		this.canReconnect = false;
		this.currentSessionContext = sessionId ?? null;
		const retryInput = sessionId ? this.retryInputBySession.get(sessionId) : undefined;
		if (retryInput) {
			this.lastUserPrompt = retryInput.prompt;
			this.lastImages = retryInput.images;
		} else {
			// A cold-loaded session has no in-memory retry input, so without this
			// fallback the regenerate button vanished after every page reload.
			const lastUserMessage = lastRetryableUserMessage(this.messages);
			this.lastUserPrompt = lastUserMessage?.content ?? null;
			this.lastImages = undefined;
			if (sessionId && lastUserMessage) {
				this.retryInputBySession.set(sessionId, { prompt: lastUserMessage.content });
			}
		}
		this.resetTransientStreamState();
		this.emit("change", undefined);
	}

	/**
	 * Mirror a server-side session branch in the visible conversation.
	 * The edited user message and every response after it belong to the
	 * abandoned branch and must disappear before the replacement is sent.
	 */
	branchBefore(entryId: string): boolean {
		const index = this.messages.findIndex((message) => message.entryId === entryId);
		if (index < 0 || this.messages[index]?.role !== "user") return false;

		this.messages = this.messages.slice(0, index);
		let priorUserMessage: ChatMessage | undefined;
		for (let cursor = this.messages.length - 1; cursor >= 0; cursor--) {
			if (this.messages[cursor]?.role === "user") {
				priorUserMessage = this.messages[cursor];
				break;
			}
		}
		this.lastUserPrompt = priorUserMessage?.content ?? null;
		this.lastImages = undefined;
		this.pendingQuestion = null;
		this.resetTransientStreamState();
		this.emit("change", undefined);
		return true;
	}

	showError(message: string): void {
		this.streamingError = message;
		this.emit("change", undefined);
	}

	setLoadingHistory(loading: boolean) {
		this.isLoadingHistory = loading;
		this.emit("change", undefined);
	}

	/** Restore a previously-shown question card after switching back to a
	 *  session (from the local per-session cache or the server-persisted
	 *  record). No-op if a newer question is already shown — the live stream
	 *  replay wins. Skips cards the user already answered. */
	restorePendingQuestion(question: PendingQuestion | null): void {
		if (this.pendingQuestion) return;
		if (!question || this.answeredQuestionIds.has(question.questionId)) return;
		this.pendingQuestion = question;
		this.emit("change", undefined);
	}
}

export const chatStore = new ChatStoreImpl();

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactToolPayload(value: unknown): unknown {
	return compactValue(value, new WeakSet<object>(), 0);
}

function compactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
	if (typeof value === "string") {
		if (value.length <= 1600) return value;
		return `${value.slice(0, 1600)}\n\n[已省略 ${value.length - 1600} 个字符]`;
	}
	if (value == null || typeof value !== "object") return value;
	if (seen.has(value)) return "[循环引用]";
	seen.add(value);
	if (depth >= 4) return "[内容层级较深，已折叠]";
	if (Array.isArray(value)) {
		const items = value.slice(0, 24).map((item) => compactValue(item, seen, depth + 1));
		if (value.length > 24) items.push(`[已省略 ${value.length - 24} 项]`);
		return items;
	}
	const record = value as Record<string, unknown>;
	const entries = Object.entries(record).slice(0, 32);
	const result: Record<string, unknown> = {};
	for (const [key, item] of entries) {
		result[key] = compactValue(item, seen, depth + 1);
	}
	const remaining = Object.keys(record).length - entries.length;
	if (remaining > 0) result.__truncated = `已省略 ${remaining} 个字段`;
	return result;
}
