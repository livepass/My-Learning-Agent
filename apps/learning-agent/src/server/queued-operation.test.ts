import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueTaskCancelledError, SessionQueue } from "../agent/session-queue.js";
import { json } from "./http-helpers.js";
import { runQueuedHttpOperation } from "./queued-operation.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

function response() {
	return Object.assign(new EventEmitter(), {
		destroyed: false, writableFinished: false, writableEnded: false,
		writeHead: vi.fn(), end: vi.fn(),
	});
}

afterEach(() => vi.useRealTimers());

describe("HTTP queue waiting deadline", () => {
	it("returns 409 for work still queued at eight seconds and never starts it later", async () => {
		vi.useFakeTimers();
		const queue = new SessionQueue(), gate = deferred<void>(), res = response();
		const blocker = queue.enqueue(() => gate.promise);
		const task = vi.fn().mockResolvedValue("unused");
		const blocking = { sessionId: "busy.jsonl", turnId: "turn", questionPending: false };
		const result = runQueuedHttpOperation(res as unknown as ServerResponse, options => queue.enqueue(task, options), { getQueueBlocker: () => blocking });
		await vi.advanceTimersByTimeAsync(8_000);
		await expect(result).resolves.toBeNull();
		expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
		expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "session_busy", blocking });
		gate.resolve(undefined);
		await blocker;
		await queue.enqueue(async () => undefined);
		expect(task).not.toHaveBeenCalled();
		expect(res.listenerCount("close")).toBe(0);
	});

	it("clears the waiting deadline when work starts and waits beyond eight seconds for its result", async () => {
		vi.useFakeTimers();
		const queue = new SessionQueue(), gate = deferred<string>(), started = deferred<void>(), res = response();
		let resolved = false;
		const result = runQueuedHttpOperation(res as unknown as ServerResponse,
			options => queue.enqueue(() => { started.resolve(undefined); return gate.promise; }, options),
			{ getQueueBlocker: () => null }).then(value => { resolved = true; return value; });
		await started.promise;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(16_000);
		expect(resolved).toBe(false);
		expect(res.writeHead).not.toHaveBeenCalled();
		gate.resolve("actual-created-id");
		await expect(result).resolves.toBe("actual-created-id");
	});

	it("does not start expired work when a blocked event loop delayed the timeout callback", async () => {
		vi.useFakeTimers();
		const queue = new SessionQueue(), gate = deferred<void>(), res = response();
		const blocker = queue.enqueue(() => gate.promise), task = vi.fn().mockResolvedValue("unused");
		const result = runQueuedHttpOperation(res as unknown as ServerResponse, options => queue.enqueue(task, options), { getQueueBlocker: () => null });
		vi.setSystemTime(Date.now() + 9_000);
		gate.resolve(undefined);
		await blocker;
		await expect(result).resolves.toBeNull();
		expect(task).not.toHaveBeenCalled();
		expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
	});

	it("cancels work still waiting when the client disconnects without writing a response", async () => {
		const queue = new SessionQueue(), gate = deferred<void>(), res = response();
		const blocker = queue.enqueue(() => gate.promise), task = vi.fn().mockResolvedValue("unused");
		const result = runQueuedHttpOperation(res as unknown as ServerResponse, options => queue.enqueue(task, options), { getQueueBlocker: () => null });
		res.destroyed = true;
		res.emit("close");
		await expect(result).resolves.toBeNull();
		gate.resolve(undefined);
		await blocker;
		await queue.enqueue(async () => undefined);
		expect(task).not.toHaveBeenCalled();
		expect(res.writeHead).not.toHaveBeenCalled();
		expect(res.end).not.toHaveBeenCalled();
	});

	it("finishes started work after disconnect and returns its result for consistency cleanup", async () => {
		const queue = new SessionQueue(), gate = deferred<string>(), started = deferred<void>(), res = response();
		const result = runQueuedHttpOperation(res as unknown as ServerResponse,
			options => queue.enqueue(() => { started.resolve(undefined); return gate.promise; }, options), { getQueueBlocker: () => null });
		await started.promise;
		expect(res.listenerCount("close")).toBe(0);
		res.destroyed = true;
		res.emit("close");
		gate.resolve("created-id");
		await expect(result).resolves.toBe("created-id");
		json(res as unknown as ServerResponse, 201, { id: "created-id" });
		expect(res.writeHead).not.toHaveBeenCalled();
		expect(res.end).not.toHaveBeenCalled();
	});

	it("does not start an operation whose response was already closed", async () => {
		const queue = new SessionQueue(), res = response(), task = vi.fn().mockResolvedValue("unused");
		res.destroyed = true;
		await expect(runQueuedHttpOperation(res as unknown as ServerResponse, options => queue.enqueue(task, options), { getQueueBlocker: () => null })).resolves.toBeNull();
		expect(task).not.toHaveBeenCalled();
	});

	it("propagates execution errors without converting them into queue contention", async () => {
		const queue = new SessionQueue(), res = response(), failure = new Error("runtime initialization failed");
		await expect(runQueuedHttpOperation(res as unknown as ServerResponse,
			options => queue.enqueue(async () => { throw failure; }, options), { getQueueBlocker: () => null })).rejects.toBe(failure);
		expect(res.writeHead).not.toHaveBeenCalled();
		expect(res.listenerCount("close")).toBe(0);
	});

	it("does not relabel a cancellation error thrown by already running work as waiting contention", async () => {
		const queue = new SessionQueue(), res = response(), failure = new QueueTaskCancelledError("nested operation failed");
		await expect(runQueuedHttpOperation(res as unknown as ServerResponse,
			options => queue.enqueue(async () => { throw failure; }, options), { getQueueBlocker: () => null })).rejects.toBe(failure);
		expect(res.writeHead).not.toHaveBeenCalled();
	});
});
