import type { ServerResponse } from "node:http";
import { QueueTaskCancelledError, type QueueTaskOptions } from "../agent/session-queue.js";
import { json } from "./http-helpers.js";

export interface QueueBlocker {
	sessionId: string;
	turnId: string;
	questionPending: boolean;
}

/** Bound queue waiting; running operations retain ownership until they settle. */
export async function runQueuedHttpOperation<T>(
	res: ServerResponse,
	op: (options: QueueTaskOptions) => Promise<T>,
	options: { timeoutMs?: number; getQueueBlocker: () => QueueBlocker | null },
): Promise<T | null> {
	const aborter = new AbortController();
	let started = false;
	const timeoutMs = options.timeoutMs ?? 8_000;
	const deadline = Date.now() + timeoutMs;
	const onClose = () => { if (!res.writableFinished) aborter.abort(); };
	const timer = setTimeout(() => aborter.abort(), timeoutMs);
	const stopWaiting = () => {
		clearTimeout(timer);
		res.removeListener("close", onClose);
	};
	res.on("close", onClose);
	if (res.destroyed || res.writableEnded) aborter.abort();
	try {
		// Removing both cancellation sources at queue entry keeps slow SDK
		// initialization from being mistaken for an operation still waiting.
		return await op({ signal: aborter.signal, onStarted: () => {
			// A busy event loop can delay the abort timer past the next queue
			// microtask. Check the deadline before any runtime mutation begins.
			if (Date.now() >= deadline || res.destroyed || res.writableEnded) {
				aborter.abort();
				throw new QueueTaskCancelledError();
			}
			started = true;
			stopWaiting();
		} });
	} catch (error) {
		if (!started && error instanceof QueueTaskCancelledError) {
			json(res, 409, { error: "session_busy", blocking: options.getQueueBlocker() ?? undefined });
			return null;
		}
		throw error;
	} finally {
		stopWaiting();
	}
}
