import type { CaseDoc, CaseMessage, CaseStreamSegment } from "../cases.js";
import type { ChatStreamEvent, StreamEventEnvelope } from "@inno-web/types/chat.js";

/**
 * Synthesizes a live-like SSE turn stream from a recorded turn's ordered
 * stream segments. This is what makes the replay indistinguishable from a
 * real session: the product's chatStore consumes exactly the same
 * text_delta / thinking_delta / tool_call_delta / tool_start / tool_end /
 * workspace_change / done protocol as the live backend, so streaming text,
 * the "正在生成内容" file preview, tool chips and the final canonical-history
 * swap all run through the unmodified product code path.
 *
 * Pacing honors a shared ReplayControl (pause / speed) driven by the replay
 * transport: pausing stalls the producer mid-token, like a network stall.
 */

export interface ReplayControl {
	paused: boolean;
	speed: number;
}

/** Shared playback control — mutated by the replay driver, read per-wait. */
export const replayControl: ReplayControl = { paused: false, speed: 2 };

// --- pacing constants (1x speed) ---
const TICK_MS = 40; // cadence between delta chunks, mirrors the store's flush interval
const TEXT_CHUNK = 60; // chars per text_delta
const THINKING_CHUNK = 120; // chars per thinking_delta (thinking reads faster)
const ARGS_CHUNKS = 4; // tool_call_delta slices for file-writing tools
const SEGMENT_GAP_MIN = 150;
const SEGMENT_GAP_MAX = 2500;
const TOOL_RUN_MIN = 400;
const TOOL_RUN_MAX = 4000;
const QUESTION_WAIT_MS = 3000;
const QUEUED_WAIT_MS = 300;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait `ms` of *scaled* time; speed divides wall time, pause freezes it. */
async function wait(ms: number, isCancelled: () => boolean): Promise<void> {
	let remaining = ms;
	while (remaining > 0 && !isCancelled()) {
		if (replayControl.paused) {
			await sleep(100);
			continue;
		}
		const slice = Math.min(remaining, 100);
		await sleep(slice / replayControl.speed);
		remaining -= slice;
	}
}

function isFileWritingTool(toolName: string): boolean {
	return ["write", "edit", "patch", "apply_patch", "create_practice_lab"].includes(toolName.toLowerCase());
}

type ToolSegment = Extract<CaseStreamSegment, { kind: "tool" }>;

/** Ordered segments for a message, falling back to its aggregated fields. */
function segmentsOf(message: CaseMessage): CaseStreamSegment[] {
	if (message.stream?.length) return message.stream;
	const segments: CaseStreamSegment[] = [];
	if (message.thinking) segments.push({ kind: "thinking", text: message.thinking, at: message.timestamp });
	if (message.content) segments.push({ kind: "text", text: message.content, at: message.timestamp });
	for (const tool of message.tools ?? []) {
		segments.push({
			kind: "tool",
			toolCallId: tool.toolCallId,
			toolName: tool.toolName,
			args: tool.args,
			result: tool.result,
			isError: tool.isError,
			at: message.timestamp,
			endAt: message.timestamp,
		});
	}
	return segments;
}

export interface TurnStreamOptions {
	doc: CaseDoc;
	/** Index of the user message that opens the turn. */
	turnStart: number;
	/** Index one past the last assistant message of the turn. */
	turnEnd: number;
	sessionId: string;
	clientRequestId: string;
	/** Called after each tool_end is emitted (mock marks the tool revealed). */
	onToolEnd: (segment: ToolSegment) => void;
	/** Called right after the done envelope is enqueued (mock advances pointer). */
	onTurnDone: (turnEnd: number) => void;
	/** Workspace keyframe lookup so a file tool's completion can fire workspace_change. */
	fileChangeFor: (toolCallId: string) => { path: string; change: "created" | "modified" } | undefined;
}

export function createTurnStream(options: TurnStreamOptions): Response {
	const { doc, turnStart, turnEnd, sessionId, clientRequestId } = options;
	const encoder = new TextEncoder();
	let cancelled = false;
	const isCancelled = () => cancelled;

	const produce = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
		let eventId = 0;
		const turnId = `replay-turn-${turnStart}`;
		const emit = (event: ChatStreamEvent): void => {
			if (cancelled) return;
			const envelope: StreamEventEnvelope = {
				eventId: ++eventId,
				sessionId,
				turnId,
				clientRequestId,
				traceId: turnId,
				occurredAt: new Date().toISOString(),
				event,
			};
			try {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
			} catch {
				cancelled = true;
			}
		};

		emit({ type: "stream_state", status: "queued" });
		await wait(QUEUED_WAIT_MS, isCancelled);
		emit({ type: "stream_state", status: "running" });
		emit({ type: "system_event", eventType: "agent_start", phase: "start", summary: "开始工作" });
		emit({ type: "skill_loaded", count: 0, skills: [] });

		let prevAt = doc.messages[turnStart]?.timestamp ?? 0;
		for (let msgIdx = turnStart + 1; msgIdx < turnEnd && !cancelled; msgIdx++) {
			const message = doc.messages[msgIdx];
			for (const segment of segmentsOf(message)) {
				if (cancelled) return;
				await wait(clamp(segment.at - prevAt, SEGMENT_GAP_MIN, SEGMENT_GAP_MAX), isCancelled);
				prevAt = Math.max(prevAt, segment.at);

				if (segment.kind === "thinking") {
					emit({ type: "thinking_start" });
					for (let i = 0; i < segment.text.length && !cancelled; i += THINKING_CHUNK) {
						emit({ type: "thinking_delta", delta: segment.text.slice(i, i + THINKING_CHUNK) });
						await wait(TICK_MS, isCancelled);
					}
					emit({ type: "thinking_end" });
					continue;
				}
				if (segment.kind === "text") {
					emit({ type: "text_start" });
					for (let i = 0; i < segment.text.length && !cancelled; i += TEXT_CHUNK) {
						emit({ type: "text_delta", delta: segment.text.slice(i, i + TEXT_CHUNK) });
						await wait(TICK_MS, isCancelled);
					}
					emit({ type: "text_end" });
					continue;
				}

				// --- tool segment ---
				// Stream args into the file preview first (drives the live
				// "正在生成内容" workspace preview in the product UI).
				emit({ type: "tool_call_start", toolCallId: segment.toolCallId, toolName: segment.toolName });
				if (isFileWritingTool(segment.toolName)) {
					const argsText = JSON.stringify(segment.args ?? {});
					const slice = Math.max(1, Math.ceil(argsText.length / ARGS_CHUNKS));
					for (let i = 0; i < argsText.length && !cancelled; i += slice) {
						emit({
							type: "tool_call_delta",
							toolCallId: segment.toolCallId,
							toolName: segment.toolName,
							argsDelta: argsText.slice(i, i + slice),
						});
						await wait(TICK_MS * 2, isCancelled);
					}
				}
				emit({ type: "tool_call_end", toolCallId: segment.toolCallId, toolName: segment.toolName, args: segment.args });
				emit({ type: "tool_start", toolCallId: segment.toolCallId, toolName: segment.toolName, args: segment.args });

				let waited = 0;
				if (segment.toolName === "ask_user_question" && segment.args && typeof segment.args === "object") {
					// Pop the real question dialog, hold it briefly, auto-resolve —
					// the recorded tool result already carries the learner's answer.
					emit({ type: "question", questionId: segment.toolCallId, params: segment.args as { questions: never[] } });
					await wait(QUESTION_WAIT_MS, isCancelled);
					emit({ type: "question_resolved", questionId: segment.toolCallId });
					waited = QUESTION_WAIT_MS;
				}
				await wait(Math.max(TOOL_RUN_MIN, clamp(segment.endAt - segment.at, TOOL_RUN_MIN, TOOL_RUN_MAX) - waited), isCancelled);

				emit({
					type: "tool_end",
					toolCallId: segment.toolCallId,
					toolName: segment.toolName,
					result: segment.result ?? "",
					isError: Boolean(segment.isError),
				});
				options.onToolEnd(segment);
				if (!segment.isError) {
					const change = options.fileChangeFor(segment.toolCallId);
					if (change) {
						emit({
							type: "workspace_change",
							changes: [{ path: change.path, change: change.change }],
							toolCallId: segment.toolCallId,
							toolName: segment.toolName,
						});
					}
				}
				prevAt = Math.max(prevAt, segment.endAt);
			}
		}
		emit({ type: "system_event", eventType: "agent_end", phase: "end", summary: "结束工作", success: true });

		if (!cancelled) {
			const fullText = doc.messages
				.slice(turnStart + 1, turnEnd)
				.map((m) => m.content)
				.filter(Boolean)
				.join("\n");
			emit({
				type: "done",
				fullText,
				persisted: true,
				finalMessageCount: turnEnd,
				finalSessionRevision: revisionFor(turnEnd),
			});
			options.onTurnDone(turnEnd);
		}
		try {
			controller.close();
		} catch {
			// already closed by cancellation
		}
	};

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			void produce(controller);
		},
		cancel() {
			cancelled = true;
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
	});
}

/** Session revision for a canonical history prefix of `pointer` messages. */
export function revisionFor(pointer: number): string {
	return `showcase-r${pointer}`;
}
