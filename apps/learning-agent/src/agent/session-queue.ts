/** Cancellation applies to waiting for a slot, not to an operation already running. */
export interface QueueTaskOptions {
	signal?: AbortSignal;
	onStarted?: () => void;
}

export class QueueTaskCancelledError extends Error {
	constructor(message = "Queue task was cancelled before it started") {
		super(message);
		this.name = "QueueTaskCancelledError";
	}
}

/** The serial owner used by pi-runner for prompts and session replacements. */
export class SessionQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(task: () => Promise<T>, options?: QueueTaskOptions): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const signal = options?.signal;
			let settled = false;
			const cleanup = () => signal?.removeEventListener("abort", onAbort);
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new QueueTaskCancelledError());
			};
			if (signal?.aborted) {
				reject(new QueueTaskCancelledError());
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			const guarded = () => {
				if (signal?.aborted) throw new QueueTaskCancelledError();
				// Runtime replacement can take longer than the HTTP queue deadline.
				// Once it starts, a late abort must not report failure while the SDK
				// continues creating/switching the session in the background.
				cleanup();
				options?.onStarted?.();
				return task();
			};
			const running = this.tail.then(guarded, guarded);
			this.tail = running.then(() => undefined, () => undefined);
			running.then(
				value => { cleanup(); if (!settled) { settled = true; resolve(value); } },
				error => { cleanup(); if (!settled) { settled = true; reject(error); } },
			);
		});
	}
}
