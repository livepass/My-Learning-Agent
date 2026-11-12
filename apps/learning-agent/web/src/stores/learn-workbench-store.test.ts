import { beforeEach, describe, expect, it, vi } from "vitest";
import { coursesStore } from "./courses-store.js";
import { learnWorkbenchStore } from "./learn-workbench-store.js";
import { sessionsStore } from "./sessions-store.js";

vi.mock("../api/courses.js", async () => {
	const actual = await vi.importActual<typeof import("../api/courses.js")>("../api/courses.js");
	return { ...actual, startCourseLearning: vi.fn() };
});
vi.mock("../react/shell/navigation.js", async () => {
	const actual = await vi.importActual<typeof import("../react/shell/navigation.js")>("../react/shell/navigation.js");
	return {
		...actual,
		navigate: vi.fn(),
		courseFromLocation: () => "course_python",
	};
});

const { startCourseLearning } = await import("../api/courses.js");
const start = startCourseLearning as unknown as ReturnType<typeof vi.fn>;

function started(sessionId: string) {
	return {
		request_id: "req",
		session: { session_id: sessionId, active: true, created: true, resumed: false },
		course: { course_id: "course_python", title: "Python 编程", status: "in_progress" as const },
		task: null,
		goal_id: null,
		learning: { created: true, checkpoint: null },
		context_ready: true,
		warnings: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	coursesStore.reset();
	learnWorkbenchStore.reset();
	sessionsStore.currentSessionId = null;
	vi.spyOn(sessionsStore, "openSession").mockResolvedValue(undefined);
	vi.spyOn(sessionsStore, "refresh").mockResolvedValue(undefined);
});

describe("learn workbench store — deferred, idempotent creation", () => {
	it("reuses the same request id after a failure, so a retry cannot create a twin", async () => {
		learnWorkbenchStore.selectCourse("course_python", { history: "replace" });
		start.mockRejectedValueOnce(new Error("队列忙"));

		expect(await learnWorkbenchStore.ensureConversation()).toBeNull();
		expect(learnWorkbenchStore.error).toContain("队列忙");
		const firstRequest = start.mock.calls[0]?.[1]?.request_id;
		expect(firstRequest).toBeTruthy();

		start.mockResolvedValueOnce(started("s_new.jsonl"));
		expect(await learnWorkbenchStore.ensureConversation()).toBe("s_new.jsonl");

		// The retry is the same click, so it must carry the same idempotency key.
		expect(start.mock.calls[1]?.[1]?.request_id).toBe(firstRequest);
		expect(learnWorkbenchStore.error).toBeNull();
		expect(sessionsStore.openSession).toHaveBeenCalledWith("s_new.jsonl", { historyMode: "replace" });
	});

	it("starts a new request id for a deliberately new conversation", async () => {
		learnWorkbenchStore.selectCourse("course_python", { history: "replace" });
		start.mockResolvedValueOnce(started("s_one.jsonl"));
		await learnWorkbenchStore.ensureConversation();
		const first = start.mock.calls[0]?.[1]?.request_id;

		sessionsStore.currentSessionId = null;
		learnWorkbenchStore.beginConversation();
		start.mockResolvedValueOnce(started("s_two.jsonl"));
		await learnWorkbenchStore.ensureConversation();

		expect(start.mock.calls[1]?.[1]?.request_id).not.toBe(first);
	});

	it("refuses to create without a course and never calls the API", async () => {
		expect(await learnWorkbenchStore.ensureConversation()).toBeNull();
		expect(learnWorkbenchStore.error).toBe("请先选择课程。");
		expect(start).not.toHaveBeenCalled();
	});

	it("drops a creation that answers after the learner switched courses", async () => {
		learnWorkbenchStore.selectCourse("course_python", { history: "replace" });
		let resolve!: (value: unknown) => void;
		start.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));

		const pending = learnWorkbenchStore.ensureConversation();
		learnWorkbenchStore.selectCourse("course_math", { history: "replace" });
		resolve(started("s_late.jsonl"));

		expect(await pending).toBeNull();
		// The session belongs to Python; opening it under 高等数学 would be a
		// cross-course switch the learner never asked for.
		expect(sessionsStore.openSession).not.toHaveBeenCalled();
	});
});
