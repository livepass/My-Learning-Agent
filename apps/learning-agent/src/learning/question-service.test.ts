import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetaStore } from "../shared/session-meta-store.js";
import { LearningRecordStore } from "./record-store.js";
import { generateAndCommitQuestion, type QuestionServiceDeps } from "./question-service.js";
import { parseQuestionRequest, type QuestionGenerationRequest } from "./question-request.js";
import type { ModelCompletion, ModelCompletionOutcome } from "../shared/model-completion.js";
import type { L2SearchResult } from "../memory/l2/l2-search.js";
import type { LearningModelIdentity } from "../memory/learner/types.js";

const MODEL: LearningModelIdentity = {
	provider_id: "fixture",
	model_id: "dummy",
	model_version: null,
	version_source: "unavailable",
};

const validReply = {
	prompt: "请用自己的话解释闭包为什么会持有外层变量。",
	kind: "free_recall",
	reference_answer: "闭包捕获的是变量绑定，不是值的副本。",
	rubric: [{ criterion_id: "c1", description: "指出捕获的是变量", weight: 2 }],
	hints: ["先想想变量存在哪里"],
};

const PAGE = "---\ntitle: 闭包\nstatus: draft\n---\n\n闭包捕获的是变量本身，而不是变量在创建时的值。\n";

let dir: string;
let meta: SessionMetaStore;
let store: LearningRecordStore;
let sessionAlive: boolean;

function deps(overrides: Partial<QuestionServiceDeps> = {}): QuestionServiceDeps {
	return {
		learningRecordStore: store,
		l2DataDir: join(dir, "l2"),
		l2Enabled: false,
		search: null,
		complete: async () => ({ status: "ok", text: JSON.stringify(validReply), model: MODEL }),
		currentModel: () => MODEL,
		sessionExists: () => sessionAlive,
		now: () => new Date("2026-11-02T00:00:00.000Z"),
		...overrides,
	};
}

function request(overrides: Partial<Record<string, unknown>> = {}): QuestionGenerationRequest {
	return parseQuestionRequest({
		concept: "Python 闭包",
		request_id: "req_1",
		expected_revision: 1,
		allow_model_fallback: true,
		...overrides,
	});
}

async function rawRecord(sessionId = "s1.jsonl"): Promise<string> {
	return readFile(join(dir, "learning", `${sessionId}.json`), "utf-8");
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "inno-c1-"));
	sessionAlive = true;
	meta = new SessionMetaStore({ dataDir: dir });
	store = new LearningRecordStore({ dataDir: dir, metaStore: meta, now: () => new Date("2026-11-02T00:00:00.000Z") });
	await store.create("s1.jsonl");
});

afterEach(async () => {
	await store.close();
	await meta.close();
	await rm(dir, { recursive: true, force: true });
});

describe("model-knowledge generation", () => {
	it("saves a complete question and advances the checkpoint once", async () => {
		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request());
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.created).toBe(true);
		expect(result.question.prompt).toBe(validReply.prompt);
		expect(result.question.reference_answer).toBe(validReply.reference_answer);
		expect(result.question.rubric).toHaveLength(1);
		expect(result.question.knowledge?.kind).toBe("model_knowledge");
		expect(result.record.checkpoint.revision).toBe(2);
		expect(result.record.checkpoint.step).toBe("awaiting_answer");
		expect(result.record.attempts).toHaveLength(0);
	});

	it("exposes only the public question, never the answer material", async () => {
		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request());
		if (!result.ok) throw new Error("expected success");
		const serialised = JSON.stringify(result.publicQuestion);
		expect(serialised).not.toContain(validReply.reference_answer);
		expect(serialised).not.toContain("rubric");
		expect(serialised).not.toContain("hints");
		expect(serialised).not.toContain("knowledge");
		// The public projection is exactly the six documented fields.
		expect(Object.keys(result.publicQuestion).sort()).toEqual([
			"concept_id", "goal_id", "kind", "prompt", "question_id", "question_version",
		]);
		expect(result.publicQuestion.goal_id).toBeUndefined();
	});
});

describe("L2 knowledge grounding", () => {
	async function seedL2(options: { sourceIds?: string[] } = {}): Promise<L2SearchResult> {
		const l2 = join(dir, "l2");
		await mkdir(join(l2, "wiki", "concepts"), { recursive: true });
		await writeFile(join(l2, "manifest.jsonl"), JSON.stringify({
			id: "src_closure", title: "闭包笔记", sourceType: "markdown",
			rawPath: "raw/closures.md", wikiPages: ["wiki/concepts/闭包.md"], tags: [],
			contentHash: "aaaaaaaaaaaaaaaa", status: "indexed",
			source: { origin: "user_upload", identity: "闭包笔记.md" },
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		}) + "\n", "utf-8");
		await writeFile(join(l2, "wiki", "concepts", "闭包.md"), PAGE, "utf-8");
		return {
			path: "wiki/concepts/闭包.md", title: "闭包", type: "concept",
			sourceIds: options.sourceIds ?? ["src_closure"], score: 6.25, via: ["lexical"],
		};
	}

	it("prefers a document the user named and stores the excerpt", async () => {
		await seedL2();
		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			designated: { by: "source_id", value: "src_closure" },
		}));
		if (!result.ok) throw new Error(`expected success, got ${result.error}`);

		expect(result.knowledge).toBe("l2_document");
		const knowledge = result.question.knowledge;
		expect(knowledge?.kind).toBe("l2_document");
		if (knowledge?.kind !== "l2_document") return;
		expect(knowledge.source_id).toBe("src_closure");
		expect(knowledge.original_content_hash).toBe("aaaaaaaaaaaaaaaa");
		expect(knowledge.source_identity).toBe("闭包笔记.md");
		expect(knowledge.page_path).toBe("wiki/concepts/闭包.md");
		// The private excerpt is stored so a later page edit cannot rewrite history.
		expect(knowledge.snippet_text).toContain("闭包捕获的是变量本身");
		expect(knowledge.snippet_hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("uses retrieval when nothing is designated", async () => {
		const hit = await seedL2();
		const result = await generateAndCommitQuestion(
			deps({ l2Enabled: true, search: async () => [hit] }),
			"s1.jsonl",
			request(),
		);
		if (!result.ok) throw new Error(`expected success, got ${result.error}`);
		expect(result.knowledge).toBe("l2_document");
	});

	it("does not pretend a missing designation was used", async () => {
		await seedL2();
		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			designated: { by: "source_id", value: "src_missing" },
		}));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("designated_not_found");
		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(0);
	});

	it("reports broken retrieval instead of calling the knowledge base empty", async () => {
		const result = await generateAndCommitQuestion(
			deps({ l2Enabled: true, search: async () => null }),
			"s1.jsonl",
			request(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(503);
		expect(result.error).toBe("l2_unavailable");
		// A fault must not silently degrade to model knowledge.
		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(0);
	});

	it("falls back to model knowledge when retrieval is empty and fallback is allowed", async () => {
		const result = await generateAndCommitQuestion(
			deps({ l2Enabled: true, search: async () => [] }),
			"s1.jsonl",
			request(),
		);
		if (!result.ok) throw new Error(`expected success, got ${result.error}`);
		expect(result.knowledge).toBe("model_knowledge");
	});

	it("refuses to answer when nothing is available and fallback is off", async () => {
		const result = await generateAndCommitQuestion(
			deps({ l2Enabled: true, search: async () => [] }),
			"s1.jsonl",
			request({ allow_model_fallback: false }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("no_knowledge_source");
	});
});

describe("idempotency and concurrency", () => {
	it("replays a committed request without calling the model or writing again", async () => {
		const complete = vi.fn<ModelCompletion>(async () => ({ status: "ok", text: JSON.stringify(validReply), model: MODEL }));
		const first = await generateAndCommitQuestion(deps({ complete }), "s1.jsonl", request());
		if (!first.ok) throw new Error("expected success");
		const before = await rawRecord();

		// Same request id and same payload, but the revision is now stale.
		const retry = await generateAndCommitQuestion(deps({ complete }), "s1.jsonl", request());
		expect(retry.ok).toBe(true);
		if (!retry.ok) return;
		expect(retry.created).toBe(false);
		expect(retry.question.question_id).toBe(first.question.question_id);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(await rawRecord()).toBe(before);
	});

	it("rejects the same request id with a different payload", async () => {
		await generateAndCommitQuestion(deps(), "s1.jsonl", request());
		const conflicting = await generateAndCommitQuestion(deps(), "s1.jsonl", request({ concept: "Python 装饰器" }));
		expect(conflicting.ok).toBe(false);
		if (conflicting.ok) return;
		expect(conflicting.status).toBe(409);
		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(1);
	});

	it("rejects a stale revision before spending a model call", async () => {
		const complete = vi.fn<ModelCompletion>(async () => ({ status: "ok", text: JSON.stringify(validReply), model: MODEL }));
		const result = await generateAndCommitQuestion(deps({ complete }), "s1.jsonl", request({ expected_revision: 0 }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(409);
		expect(complete).not.toHaveBeenCalled();
	});

	it("produces exactly one question when two generations run at once", async () => {
		const results = await Promise.all([
			generateAndCommitQuestion(deps(), "s1.jsonl", request({ request_id: "req_a" })),
			generateAndCommitQuestion(deps(), "s1.jsonl", request({ request_id: "req_b" })),
		]);
		expect(results.filter((entry) => entry.ok)).toHaveLength(1);
		expect(results.filter((entry) => !entry.ok)).toHaveLength(1);
		const record = (await store.get("s1.jsonl"))!;
		expect(record.questions).toHaveLength(1);
		expect(record.checkpoint.revision).toBe(2);
	});
});

describe("failure and races leave the record untouched", () => {
	const cases: Array<[string, ModelCompletionOutcome]> = [
		["not ready", { status: "not_ready", reason: "no_credentials" }],
		["timeout", { status: "timeout" }],
		["provider error", { status: "error", message: "boom" }],
		["empty reply", { status: "empty" }],
	];

	for (const [label, outcome] of cases) {
		it(`writes nothing on ${label}`, async () => {
			const before = await rawRecord();
			const result = await generateAndCommitQuestion(deps({ complete: async () => outcome }), "s1.jsonl", request());
			expect(result.ok).toBe(false);
			expect(await rawRecord()).toBe(before);
			expect((await store.get("s1.jsonl"))!.checkpoint.revision).toBe(1);
		});
	}

	it("writes nothing when the reply fails validation", async () => {
		const before = await rawRecord();
		const result = await generateAndCommitQuestion(
			deps({ complete: async () => ({ status: "ok", text: JSON.stringify({ ...validReply, rubric: [] }), model: MODEL }) }),
			"s1.jsonl",
			request(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(422);
		expect(await rawRecord()).toBe(before);
	});

	it("refuses to commit when the session is deleted during generation", async () => {
		const gate = deferred<void>();
		const complete: ModelCompletion = async () => {
			await gate.promise;
			return { status: "ok", text: JSON.stringify(validReply), model: MODEL };
		};
		const pending = generateAndCommitQuestion(deps({ complete }), "s1.jsonl", request());
		await store.remove("s1.jsonl");
		sessionAlive = false;
		gate.resolve();

		const result = await pending;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
		// The deleted record is not resurrected.
		expect(await store.get("s1.jsonl")).toBeUndefined();
	});

	it("refuses to commit when the checkpoint is paused during generation", async () => {
		const gate = deferred<void>();
		const complete: ModelCompletion = async () => {
			await gate.promise;
			return { status: "ok", text: JSON.stringify(validReply), model: MODEL };
		};
		const pending = generateAndCommitQuestion(deps({ complete }), "s1.jsonl", request());
		await store.pause("s1.jsonl", 1);
		gate.resolve();

		const result = await pending;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(409);
		const record = (await store.get("s1.jsonl"))!;
		expect(record.questions).toHaveLength(0);
		expect(record.checkpoint.status).toBe("paused");
	});
});

describe("restart recovery", () => {
	it("reads the same question and knowledge after a fresh store instance", async () => {
		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request());
		if (!result.ok) throw new Error("expected success");
		await store.close();

		const restartedMeta = new SessionMetaStore({ dataDir: dir });
		const restarted = new LearningRecordStore({ dataDir: dir, metaStore: restartedMeta });
		try {
			const record = (await restarted.get("s1.jsonl"))!;
			expect(record.questions).toHaveLength(1);
			expect(record.questions[0].question_id).toBe(result.question.question_id);
			expect(record.questions[0].knowledge?.kind).toBe("model_knowledge");
			expect(record.checkpoint.step).toBe("awaiting_answer");
			expect(record.checkpoint.revision).toBe(2);

			// And the retry still resolves to the same question after a restart.
			const retry = await generateAndCommitQuestion(
				{ ...deps({ learningRecordStore: restarted }), l2DataDir: join(dir, "l2") },
				"s1.jsonl",
				request(),
			);
			expect(retry.ok).toBe(true);
			if (!retry.ok) return;
			expect(retry.created).toBe(false);
			expect(retry.question.question_id).toBe(result.question.question_id);
		} finally {
			await restarted.close();
			await restartedMeta.close();
			// Re-open so afterEach can close the original pair without failing.
			meta = new SessionMetaStore({ dataDir: dir });
			store = new LearningRecordStore({ dataDir: dir, metaStore: meta });
		}
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}
