import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerLearningExtension } from "./learning-extension.js";
import { resolveRuntimePaths, type RuntimePaths } from "../runtime.js";
import { resolveCapabilities } from "../shared/capabilities.js";
import { normalizeConfig, normalizeModelConfig } from "../config.js";
import { closeL2Memory } from "../memory/l2/l2-memory.js";
import { closeL3Memory } from "../memory/l3/l3-tools.js";
import { CourseStore } from "../courses/course-store.js";
import { createDefaultProfile, type LearnerProfile } from "../memory/learner/types.js";
import { LEARNING_TEACHING_PROMPT } from "./system-prompt.js";

/**
 * E4.4-R1 — the *registered extension*, not just the context builder.
 *
 * The bug this pins: `before_agent_start` injected the learner-wide context
 * pack into every turn, so a Python session could see 高数 mastery states,
 * misconceptions and review deadlines. These tests drive the real handler with
 * a real course store and a real profile file, and read the system prompt the
 * agent would actually receive.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let paths: RuntimePaths;
let tools: ToolDefinition[] = [];
let beforeAgentStart: ((event: { prompt: string }, ctx: unknown) => Promise<{ systemPrompt?: string }>) | undefined;

const sessionPath = (id: string) => join(paths.sessionDir, id);
const promptFor = async (sessionId: string | null, prompt = "讲讲装饰器"): Promise<string> => {
	const result = await beforeAgentStart!(
		{ prompt },
		{ sessionManager: { getSessionFile: () => (sessionId ? sessionPath(sessionId) : undefined) } },
	);
	return result.systemPrompt ?? "";
};

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "inno-learning-extension-"));
	paths = resolveRuntimePaths({
		home: root,
		configDir: join(root, "config"),
		dataDir: join(root, "data"),
		workspaceDir: join(root, "workspace"),
		skillsDir: join(root, "skills"),
	});
	await mkdir(paths.configDir, { recursive: true });
	await mkdir(paths.workspaceDir, { recursive: true });
	await mkdir(paths.learnerDataDir, { recursive: true });
	await mkdir(paths.sessionDir, { recursive: true });
	await mkdir(join(paths.dataDir, "courses"), { recursive: true });

	const store = new CourseStore({ dataDir: paths.dataDir });
	const python = await store.createCourse({ title: "Python 编程" });
	const math = await store.createCourse({ title: "高等数学" });
	await store.bindGoal(python.course_id, "goal_python");
	await store.bindGoal(math.course_id, "goal_math");
	await store.bindSession({ courseId: python.course_id, sessionId: "python_session.jsonl", origin: "free_question", taskId: null });
	await store.bindSession({ courseId: math.course_id, sessionId: "math_session.jsonl", origin: "free_question", taskId: null });

	// A binding whose course is not in the file: ownership cannot be read.
	const statePath = join(paths.dataDir, "courses", "state.json");
	const state = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf-8")) as {
		session_bindings: Array<Record<string, unknown>>;
	};
	state.session_bindings.push({
		binding_id: "binding_broken",
		course_id: "course_missing",
		session_id: "broken_session.jsonl",
		task_id: null,
		origin: "manual",
		created_at: "2026-11-01T00:00:00.000Z",
	});
	await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

	const profile: LearnerProfile = createDefaultProfile("default");
	profile.goals = [
		{ goal_id: "goal_python", title: "能独立写装饰器", type: "skill", priority: 1, status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-11-01T00:00:00.000Z" },
		{ goal_id: "goal_math", title: "掌握高等数学导数", type: "exam", priority: 1, status: "active", success_criteria: [], source: "user_declared", updated_at: "2026-11-01T00:00:00.000Z" },
	];
	profile.knowledge_states = [
		{
			concept_id: "concept_decorator", concept_name: "装饰器", domain: "python", course_id: python.course_id,
			mastery: 0.3, confidence: 0.6, stability: 0.2, state_label: "fragile",
			evidence_ids: ["ev_1"], diagnosis: "需要练习", next_actions: [],
		},
		{
			concept_id: "concept_derivative", concept_name: "导数", domain: "math", course_id: math.course_id,
			mastery: 0.2, confidence: 0.5, stability: 0.2, state_label: "learning",
			evidence_ids: ["ev_2"], diagnosis: "高数专属状态", next_actions: [],
		},
	];
	profile.misconceptions = [
		{
			misconception_id: "mis_math", concept_id: "concept_derivative", description: "以为导数等于平均变化率",
			status: "active", severity: 0.5, confidence: 0.6,
			first_seen_at: "2026-11-01T00:00:00.000Z", last_seen_at: "2026-11-01T00:00:00.000Z",
			evidence_ids: ["ev_2"], repair_strategy: "对比瞬时与平均",
		},
	];
	profile.preferences = {
		explanation_style: ["example_first"],
		practice_style: ["small_steps"],
		feedback_tone: ["direct"],
		avoid: [],
	};
	await writeFile(join(paths.learnerDataDir, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");

	const pi = {
		registerTool: (tool: ToolDefinition) => { tools.push(tool); },
		on: (event: string, handler: typeof beforeAgentStart) => {
			if (event === "before_agent_start") beforeAgentStart = handler;
		},
	} as unknown as ExtensionAPI;
	registerLearningExtension(pi, normalizeConfig({
		providers: { fixture: { baseUrl: "http://127.0.0.1:1", apiKey: "fixture", models: [normalizeModelConfig({ id: "dummy" })] } },
	}), paths, resolveCapabilities({} as never));
}, 60_000);

afterAll(async () => {
	closeL2Memory(paths.l2DataDir);
	closeL3Memory(paths.l3DataDir);
	if (root) await rm(root, { recursive: true, force: true });
});

describe("course-scoped learner context", () => {
	it("keeps another course's goals, states and misconceptions out of the Python prompt", async () => {
		const prompt = await promptFor("python_session.jsonl");
		// This course's own state and the shared preferences are present.
		expect(prompt).toContain("能独立写装饰器");
		expect(prompt).toContain("装饰器");
		expect(prompt).toContain("例子优先");
		// 高数 goals, states, misconceptions and review data are not.
		expect(prompt).not.toContain("掌握高等数学导数");
		expect(prompt).not.toContain("导数");
		expect(prompt).not.toContain("平均变化率");
		// The course section still comes from the trusted course context.
		expect(prompt).toContain("## 当前课程上下文");
	});

	it("keeps the learner-wide pack for a confirmed unclassified session", async () => {
		const prompt = await promptFor("legacy_session.jsonl");
		expect(prompt).toContain("## 学习者上下文");
		// Legacy behaviour is learner-wide: another course's state/misconception
		// is still visible here, which is why a bound session must not use it.
		expect(prompt).toContain("concept_derivative");
		expect(prompt).toContain("以为导数等于平均变化率");
		expect(prompt).not.toContain("## 当前课程上下文");
	});

	it("skips the learner-wide pack when the binding cannot be read", async () => {
		const prompt = await promptFor("broken_session.jsonl");
		expect(prompt).not.toContain("## 学习者上下文");
		// Neither course is presented as this session's memory.
		expect(prompt).not.toContain("掌握高等数学导数");
		expect(prompt).not.toContain("能独立写装饰器");
		expect(prompt).toContain(LEARNING_TEACHING_PROMPT.slice(0, 20));
	});

	it("skips the learner-wide pack when the session identity is missing", async () => {
		const prompt = await promptFor(null);
		expect(prompt).not.toContain("## 学习者上下文");
		expect(prompt).not.toContain("导数");
	});
});

describe("retrieval tools without a usable identity", () => {
	const l2Query = () => tools.find((tool) => tool.name === "l2_query");

	it("refuses L2 retrieval instead of falling back to global material", async () => {
		const tool = l2Query();
		expect(tool).toBeDefined();
		const result = await (tool!.execute as (...args: unknown[]) => Promise<{ details: Record<string, unknown>; content: Array<{ text: string }> }>)(
			"call-1", { query: "装饰器" }, undefined, undefined,
			{ sessionManager: { getSessionFile: () => undefined } },
		);
		expect(result.details.error).toBe("course_scope_unavailable");
		expect(result.content[0].text).toContain("不会回退到全局资料");
	});
});
