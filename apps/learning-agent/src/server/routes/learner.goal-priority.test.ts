import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfile, mutateProfile } from "../../memory/learner/profile-store.js";
import type { LearningGoal } from "../../memory/learner/types.js";
import type { RuntimePaths } from "../../runtime.js";
import { handleLearnerRoutes } from "./learner.js";

/**
 * E4.9i-P2-6-R1 (F01) — the goal PATCH must not refresh `manual.priority` for a
 * request that did not carry a priority.
 *
 * The rule under test lives in the route (`server/routes/learner.ts`): a field
 * becomes human-owned only when the request body *contains* it. That makes the
 * client's job explicit — omitting `priority` is the only way to leave its
 * ownership stamp alone — so this file pins the server half of the contract.
 * The client half (which fields the editor sends) is covered by
 * `web/src/react/profile/GoalPriority.test.tsx`.
 *
 * These tests run the real handler against a real learner store on a temp
 * directory: the stamp is read back from the persisted profile, not from the
 * response alone.
 */

const roots: string[] = [];

async function makePaths(): Promise<{ paths: RuntimePaths; dataDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "inno-learner-goal-http-"));
	roots.push(root);
	const dataDir = join(root, "data");
	const paths: RuntimePaths = {
		codeDir: root,
		configDir: join(root, "config"),
		configPath: join(root, "config", "config.json"),
		dataDir,
		learnerDataDir: join(dataDir, "learner"),
		sessionDir: join(dataDir, "sessions"),
		l2DataDir: join(dataDir, "l2"),
		l3DataDir: join(dataDir, "l3"),
		skillsDir: join(root, "skills"),
		workspaceDir: join(root, "workspace"),
		webDistDir: join(root, "web-dist"),
	};
	await mkdir(paths.learnerDataDir, { recursive: true });
	await mkdir(paths.sessionDir, { recursive: true });
	return { paths, dataDir };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Captured {
	status: number;
	body: unknown;
}

async function call(paths: RuntimePaths, method: string, url: string, body?: unknown): Promise<Captured> {
	let status = 0;
	let payload: unknown;
	const res: Record<string, unknown> = {
		destroyed: false,
		writableEnded: false,
		writeHead: (code: number) => { status = code; return res; },
		end: (value?: string) => {
			res.writableEnded = true;
			payload = value ? JSON.parse(value) : undefined;
			return res;
		},
	};
	const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]) as IncomingMessage;
	req.headers = {};
	const handled = await handleLearnerRoutes(
		req,
		res as unknown as ServerResponse,
		method,
		url,
		{ paths },
	);
	expect(handled, `${method} ${url} must be handled by the learner domain`).toBe(true);
	return { status, body: payload };
}

/** Seed one goal with a known priority and a known ownership stamp. */
async function seedGoal(paths: RuntimePaths, goal: Partial<LearningGoal> = {}): Promise<LearningGoal> {
	const seeded: LearningGoal = {
		goal_id: "goal_seed01",
		title: "读完 CET4 阅读真题",
		type: "skill",
		status: "active",
		priority: 0.5,
		success_criteria: ["能读懂 90% 的段落"],
		source: "user_declared",
		updated_at: "2026-11-01T00:00:00.000Z",
		manual: { priority: { at_seq: 0, edit: 7 } },
		...goal,
	};
	await mutateProfile(paths.learnerDataDir, (profile) => {
		profile.goals = [seeded];
		// `nextManualStamp` derives its `edit` from this counter, so seeding it
		// above the stored stamp makes "a new stamp was issued" observable.
		profile.manual_edit_seq = 20;
		return true;
	});
	return seeded;
}

async function storedGoal(paths: RuntimePaths, goalId: string): Promise<LearningGoal> {
	const profile = await loadProfile(paths.learnerDataDir);
	const goal = profile.goals.find((g) => g.goal_id === goalId);
	if (!goal) throw new Error(`goal ${goalId} disappeared`);
	return goal;
}

describe("PATCH /api/learner/profile/goals/:goalId — priority ownership", () => {
	it("a title-only PATCH leaves manual.priority and the stored priority untouched", async () => {
		const { paths } = await makePaths();
		await seedGoal(paths);

		const patched = await call(paths, "PATCH", "/api/learner/profile/goals/goal_seed01", {
			title: "改过的标题",
		});
		expect(patched.status).toBe(200);

		const goal = await storedGoal(paths, "goal_seed01");
		expect(goal.title).toBe("改过的标题");
		expect(goal.priority).toBe(0.5);
		// The exact stamp seeded above: an untouched field keeps its owner.
		expect(goal.manual?.priority).toEqual({ at_seq: 0, edit: 7 });
		expect(goal.manual?.title).toBeDefined();
	});

	it("a status-only PATCH leaves manual.priority untouched", async () => {
		const { paths } = await makePaths();
		await seedGoal(paths);

		const patched = await call(paths, "PATCH", "/api/learner/profile/goals/goal_seed01", {
			status: "paused",
		});
		expect(patched.status).toBe(200);

		const goal = await storedGoal(paths, "goal_seed01");
		expect(goal.status).toBe("paused");
		expect(goal.manual?.priority).toEqual({ at_seq: 0, edit: 7 });
		expect(goal.manual?.status).toBeDefined();
	});

	it("an explicit priority PATCH does refresh manual.priority and stores the value", async () => {
		const { paths } = await makePaths();
		await seedGoal(paths);

		const patched = await call(paths, "PATCH", "/api/learner/profile/goals/goal_seed01", {
			priority: 0.4,
		});
		expect(patched.status).toBe(200);

		const goal = await storedGoal(paths, "goal_seed01");
		expect(goal.priority).toBe(0.4);
		// `nextManualStamp` bumps `manual_edit_seq`; the seeded 7 cannot survive.
		expect(goal.manual?.priority?.edit).toBeGreaterThan(7);
	});

	it("an anomalous stored priority survives a title-only PATCH", async () => {
		// The client-side bug this pairs with: the editor used to re-send the raw
		// value, which refreshed the stamp. Omitting the field must keep 3 as 3.
		const { paths } = await makePaths();
		await seedGoal(paths, { priority: 3 });

		await call(paths, "PATCH", "/api/learner/profile/goals/goal_seed01", { title: "改过的标题" });

		const goal = await storedGoal(paths, "goal_seed01");
		expect(goal.priority).toBe(3);
		expect(goal.manual?.priority).toEqual({ at_seq: 0, edit: 7 });
	});

	it("a negative stored priority survives a status-only PATCH", async () => {
		const { paths } = await makePaths();
		await seedGoal(paths, { priority: -0.2 });

		await call(paths, "PATCH", "/api/learner/profile/goals/goal_seed01", { status: "completed" });

		const goal = await storedGoal(paths, "goal_seed01");
		expect(goal.priority).toBe(-0.2);
		expect(goal.manual?.priority).toEqual({ at_seq: 0, edit: 7 });
	});

	it("an endpoint value chosen explicitly is stored and re-stamped", async () => {
		for (const chosen of [0, 1]) {
			const { paths } = await makePaths();
			await seedGoal(paths, { priority: 3 });

			const patched = await call(paths, "PATCH", "/api/learner/profile/goals/goal_seed01", {
				priority: chosen,
			});
			expect(patched.status, String(chosen)).toBe(200);

			const goal = await storedGoal(paths, "goal_seed01");
			expect(goal.priority, String(chosen)).toBe(chosen);
			expect(goal.manual?.priority?.edit, String(chosen)).toBeGreaterThan(7);
		}
	});

	it("a goal with no priority field at all is not given one by a title-only PATCH", async () => {
		const { paths } = await makePaths();
		await seedGoal(paths, { priority: undefined as unknown as number });

		await call(paths, "PATCH", "/api/learner/profile/goals/goal_seed01", { title: "改过的标题" });

		const goal = await storedGoal(paths, "goal_seed01");
		expect(goal.priority).toBeUndefined();
		expect(goal.manual?.priority).toEqual({ at_seq: 0, edit: 7 });
	});
});
