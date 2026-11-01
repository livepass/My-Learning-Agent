import { describe, expect, it, vi } from "vitest";
import { QueueTaskCancelledError, SessionQueue } from "./session-queue.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

describe("session queue cancellation boundary", () => {
	it("rejects an already cancelled task without claiming a queue slot", async () => {
		const queue = new SessionQueue();
		const controller = new AbortController();
		controller.abort();
		const task = vi.fn().mockResolvedValue("unused"), onStarted = vi.fn();
		await expect(queue.enqueue(task, { signal: controller.signal, onStarted })).rejects.toBeInstanceOf(QueueTaskCancelledError);
		expect(task).not.toHaveBeenCalled();
		expect(onStarted).not.toHaveBeenCalled();
		await expect(queue.enqueue(async () => "next")).resolves.toBe("next");
	});

	it("eagerly cancels waiting work and never executes it after the blocker finishes", async () => {
		const queue = new SessionQueue(), gate = deferred<void>();
		const blocker = queue.enqueue(() => gate.promise);
		const controller = new AbortController();
		const task = vi.fn().mockResolvedValue("unused"), onStarted = vi.fn();
		const cancelled = queue.enqueue(task, { signal: controller.signal, onStarted });
		const rejected = expect(cancelled).rejects.toBeInstanceOf(QueueTaskCancelledError);
		controller.abort();
		await rejected;
		gate.resolve(undefined);
		await blocker;
		await expect(queue.enqueue(async () => "next")).resolves.toBe("next");
		expect(task).not.toHaveBeenCalled();
		expect(onStarted).not.toHaveBeenCalled();
	});

	it("returns the actual result when its signal aborts after execution starts", async () => {
		const queue = new SessionQueue(), gate = deferred<string>(), started = deferred<void>();
		const controller = new AbortController(), onStarted = vi.fn();
		const result = queue.enqueue(() => { started.resolve(undefined); return gate.promise; }, { signal: controller.signal, onStarted });
		await started.promise;
		controller.abort();
		gate.resolve("created-session");
		await expect(result).resolves.toBe("created-session");
		expect(onStarted).toHaveBeenCalledOnce();
		await expect(queue.enqueue(async () => "next")).resolves.toBe("next");
	});

	it("preserves an execution failure and lets subsequent queue work run", async () => {
		const queue = new SessionQueue(), gate = deferred<void>(), started = deferred<void>();
		const controller = new AbortController(), failure = new Error("SDK replacement failed");
		const result = queue.enqueue(() => { started.resolve(undefined); return gate.promise; }, { signal: controller.signal });
		const rejected = expect(result).rejects.toBe(failure);
		await started.promise;
		controller.abort();
		gate.reject(failure);
		await rejected;
		await expect(queue.enqueue(async () => "recovered")).resolves.toBe("recovered");
	});
});
