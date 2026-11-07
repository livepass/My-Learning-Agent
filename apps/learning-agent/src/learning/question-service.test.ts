import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetaStore } from "../shared/session-meta-store.js";
import { LearningRecordStore } from "./record-store.js";
import { generateAndCommitQuestion, type QuestionServiceDeps } from "./question-service.js";
import { evaluateAttempt, finalizeAttempt, saveAnswer, type AnswerServiceDeps } from "./answer-service.js";
import { loadEvents } from "../memory/learner/profile-store.js";
import { parseQuestionRequest, type QuestionGenerationRequest } from "./question-request.js";
import type { ModelCompletion, ModelCompletionOutcome } from "../shared/model-completion.js";
import type { L2SearchResult } from "../memory/l2/l2-search.js";
import { closeL2Memory, getL2Memory } from "../memory/l2/l2-memory.js";
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

	it("refuses a designation owned by another course", async () => {
		await seedL2();
		const result = await generateAndCommitQuestion(
			deps({ allowedSourceIds: ["src_other"] }),
			"s1.jsonl",
			request({ designated: { by: "source_id", value: "src_closure" } }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("designated_out_of_scope");
		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(0);
	});

	it("pushes the course scope into the search rather than filtering its results", async () => {
		const hit = await seedL2();
		const scopes: (readonly string[] | undefined)[] = [];
		const result = await generateAndCommitQuestion(
			deps({
				l2Enabled: true,
				allowedSourceIds: ["src_closure"],
				search: async (_query, options) => {
					scopes.push(options?.sourceIds);
					return [hit];
				},
			}),
			"s1.jsonl",
			request(),
		);
		expect(result.ok).toBe(true);
		// The scope reached the retrieval function itself: candidates are limited
		// before ranking, not removed from a global result list afterwards.
		expect(scopes).toEqual([["src_closure"]]);
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

describe("L2 read safety", () => {
	it("never reads a page that escapes the L2 directory", async () => {
		// A secret file outside the L2 dir must not be reachable, even if a stale
		// or tampered manifest entry names a traversing path to it.
		const secret = join(dir, "secret.md");
		await writeFile(secret, "这是目录外的机密内容，绝不能发送给模型。", "utf-8");

		const l2 = join(dir, "l2");
		await mkdir(join(l2, "wiki", "concepts"), { recursive: true });
		// The manifest names a traversing page path.
		await writeFile(join(l2, "manifest.jsonl"), JSON.stringify({
			id: "src_escape", title: "越界", sourceType: "markdown",
			rawPath: "raw/secret.md", wikiPages: ["../secret.md"], tags: [],
			contentHash: "bbbbbbbbbbbbbbbb", status: "indexed",
			source: { origin: "user_upload", identity: "secret.md" },
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		}) + "\n", "utf-8");

		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			designated: { by: "source_id", value: "src_escape" },
		}));
		// The page cannot be resolved inside the L2 dir, so the source is
		// reported unavailable — and the secret is never adopted.
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("designated_unavailable");
		const raw = await rawRecord();
		expect(raw).not.toContain("目录外的机密内容");
	});

	it("reports a symlink escape as unavailable, not a readable source", async () => {
		const l2 = join(dir, "l2");
		await mkdir(join(l2, "wiki", "concepts"), { recursive: true });
		const secret = join(dir, "outside.txt");
		await writeFile(secret, "符号链接越界的内容", "utf-8");
		// A symlink planted inside the wiki dir pointing outside the L2 dir.
		await mkdir(join(l2, "wiki", "evil"), { recursive: true });
		try {
			await symlink(secret, join(l2, "wiki", "evil", "escape.md"));
		} catch {
			// Symlink creation may be restricted on this platform; the containment
			// check is the thing under test, and a failure to plant the link only
			// means this particular assertion cannot run.
			return;
		}
		await writeFile(join(l2, "manifest.jsonl"), JSON.stringify({
			id: "src_link", title: "链接", sourceType: "markdown",
			rawPath: "raw/outside.txt", wikiPages: ["wiki/evil/escape.md"], tags: [],
			contentHash: "cccccccccccccccc", status: "indexed",
			source: { origin: "user_upload", identity: "outside.txt" },
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		}) + "\n", "utf-8");

		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			designated: { by: "source_id", value: "src_link" },
		}));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("designated_unavailable");
		expect(await rawRecord()).not.toContain("符号链接越界的内容");
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

describe("model identity binding", () => {
	it("persists the identity of the model that actually served the reply", async () => {
		// The runtime-reported identity (currentModel) differs from the one the
		// completion actually ran on: the stored question must record the latter,
		// so a model switch mid-request never rewrites a historical question.
		const servedBy: LearningModelIdentity = {
			provider_id: "served-provider",
			model_id: "served-model",
			model_version: null,
			version_source: "unavailable",
		};
		const current: LearningModelIdentity = {
			provider_id: "current-provider",
			model_id: "current-model",
			model_version: null,
			version_source: "unavailable",
		};
		const result = await generateAndCommitQuestion(deps({
			currentModel: () => current,
			complete: async () => ({ status: "ok", text: JSON.stringify(validReply), model: servedBy }),
		}), "s1.jsonl", request());
		if (!result.ok) throw new Error(`expected success, got ${result.error}`);

		const knowledge = result.question.knowledge;
		expect(knowledge?.model).toEqual(servedBy);
		expect(knowledge?.model).not.toEqual(current);
		// Persisted to disk with the same identity.
		const record = JSON.parse(await rawRecord());
		expect(record.questions[0].knowledge.model).toEqual(servedBy);
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

/**
 * Real L2 store end-to-end: actual wiki pages, manifest and the SQLite index,
 * not the injected candidate mock. This is what proves the singleton reuse and
 * the index-empty / index-unavailable distinction survive the real store.
 */
describe("real L2 retrieval through the singleton", () => {
	// A real page needs `source_ids` frontmatter so the indexer can attribute it
	// to exactly one manifest entry (the same rule retrieval enforces).
	const realPage = (sourceId: string) => `---
title: 闭包
type: concept
status: draft
source_ids: ["${sourceId}"]
---

闭包捕获的是变量本身，而不是变量在创建时的值。
`;

	it("indexes a real page and grounds the question on it", async () => {
		const l2 = join(dir, "l2");
		await mkdir(join(l2, "wiki", "concepts"), { recursive: true });
		await writeFile(join(l2, "manifest.jsonl"), JSON.stringify({
			id: "src_real", title: "闭包笔记", sourceType: "markdown",
			rawPath: "raw/closures.md", wikiPages: ["wiki/concepts/闭包.md"], tags: [],
			contentHash: "dddddddddddddddd", status: "indexed",
			source: { origin: "user_upload", identity: "闭包笔记.md" },
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		}) + "\n", "utf-8");
		await writeFile(join(l2, "wiki", "concepts", "闭包.md"), realPage("src_real"), "utf-8");

		const memory = getL2Memory(l2);
		try {
			// The same singleton the HTTP server would share.
			expect(getL2Memory(l2)).toBe(memory);
			await memory.backfill();

			// The real SQLite index returns the page for the concept query.
			const hits = await memory.search("闭包 变量", 5);
			expect(hits).not.toBeNull();
			expect(hits!.length).toBeGreaterThan(0);

			const result = await generateAndCommitQuestion(
				deps({ l2Enabled: true, search: async (q) => memory.search(q, 5) }),
				"s1.jsonl",
				request(),
			);
			if (!result.ok) throw new Error(`expected success, got ${result.error}`);
			expect(result.knowledge).toBe("l2_document");
			const knowledge = result.question.knowledge;
			expect(knowledge?.kind).toBe("l2_document");
			if (knowledge?.kind !== "l2_document") return;
			expect(knowledge.source_id).toBe("src_real");
		} finally {
			closeL2Memory(l2);
		}
	});

	it("reports a genuinely empty index as empty, not unavailable", async () => {
		const l2 = join(dir, "l2");
		await mkdir(join(l2, "wiki", "concepts"), { recursive: true });
		// No pages at all: backfill finds nothing to index.
		const memory = getL2Memory(l2);
		try {
			await memory.backfill();

			// An empty index searches to an empty result, which is a normal "no
			// matches" — the opposite of an unavailable index.
			expect(await memory.search("anything", 5)).toEqual([]);

			const result = await generateAndCommitQuestion(
				deps({ l2Enabled: true, search: async (q) => memory.search(q, 5) }),
				"s1.jsonl",
				request(),
			);
			// Empty retrieval falls back to model knowledge (fallback is on), never
			// reported as a broken index.
			if (!result.ok) throw new Error(`expected success, got ${result.error}`);
			expect(result.knowledge).toBe("model_knowledge");
		} finally {
			closeL2Memory(l2);
		}
	});

	it("does not conflate an un-synced index with an empty one", async () => {
		const l2 = join(dir, "l2");
		await mkdir(join(l2, "wiki", "concepts"), { recursive: true });
		await writeFile(join(l2, "manifest.jsonl"), JSON.stringify({
			id: "src_sync", title: "同步笔记", sourceType: "markdown",
			rawPath: "raw/sync.md", wikiPages: ["wiki/concepts/sync.md"], tags: [],
			contentHash: "eeeeeeeeeeeeeeee", status: "indexed",
			source: { origin: "user_upload", identity: "sync.md" },
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		}) + "\n", "utf-8");
		await writeFile(join(l2, "wiki", "concepts", "sync.md"), realPage("src_sync"), "utf-8");

		const memory = getL2Memory(l2);
		try {
			// Do NOT backfill up front: the page is on disk but the index is stale.
			// A search that assumed "index already synced" would return [] and
			// misread a populated wiki as empty. The server wrapper must backfill
			// first — mirror that here.
			const searchWithSync = async (q: string) => {
				await memory.backfill();
				return memory.search(q, 5);
			};

			const result = await generateAndCommitQuestion(
				deps({ l2Enabled: true, search: searchWithSync }),
				"s1.jsonl",
				request(),
			);
			if (!result.ok) throw new Error(`expected success, got ${result.error}`);
			// The freshly-synced index grounds the question on the real page.
			expect(result.knowledge).toBe("l2_document");
		} finally {
			closeL2Memory(l2);
		}
	});
});

describe("C4 continuation after a completed question", () => {
	const assessmentReply = {
		result: "correct",
		feedback: "准确。",
		criteria: [{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" }],
	};
	const answerDeps = (overrides: Partial<AnswerServiceDeps> = {}): AnswerServiceDeps => ({
		learningRecordStore: store,
		learnerDataDir: join(dir, "learner"),
		complete: async () => ({ status: "ok" as const, text: JSON.stringify(assessmentReply), model: MODEL }),
		processRunId: "process-1",
		maxEvaluationAttempts: 3,
		sessionExists: () => sessionAlive,
		now: () => new Date("2026-11-02T00:00:00.000Z"),
		...overrides,
	});

	/** Generate A, answer it, score it and record the evidence: checkpoint → feedback. */
	async function setupFeedback(): Promise<{ revision: number; questionId: string }> {
		const first = await generateAndCommitQuestion(deps(), "s1.jsonl", request());
		if (!first.ok) throw new Error(`generation A failed: ${first.message}`);
		const saved = await saveAnswer(answerDeps(), "s1.jsonl", {
			attempt_id: "a1",
			question_id: first.question.question_id,
			question_version: first.question.question_version,
			expected_revision: first.record.checkpoint.revision,
			answer: "闭包捕获变量绑定。",
		});
		if (!saved.ok) throw new Error(`save failed: ${saved.message}`);
		const evaluated = await evaluateAttempt(answerDeps(), "s1.jsonl", "a1", saved.record.checkpoint.revision);
		if (!evaluated.ok) throw new Error(`evaluate failed: ${evaluated.message}`);
		const finalized = await finalizeAttempt(answerDeps(), "s1.jsonl", "a1", evaluated.record.checkpoint.revision);
		if (!finalized.ok) throw new Error(`finalize failed: ${finalized.message}`);
		return { revision: finalized.checkpoint.revision, questionId: first.question.question_id };
	}

	it("generates the next question bound to the completed attempt and keeps history intact", async () => {
		const { revision } = await setupFeedback();
		const before = (await store.get("s1.jsonl"))!;
		const eventsBefore = await loadEvents(join(dir, "learner"));

		const second = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			request_id: "req_b", expected_revision: revision, after_attempt_id: "a1",
			concept: "Python 闭包",
		}));

		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.created).toBe(true);
		expect(second.record.questions).toHaveLength(2);
		expect(second.record.questions[0].question_id).toBe(before.questions[0].question_id);
		expect(second.question.question_id).not.toBe(before.questions[0].question_id);
		expect(second.record.checkpoint).toMatchObject({
			revision: revision + 1, step: "awaiting_answer",
			question: { question_id: second.question.question_id, question_version: "1" },
			last_completed_attempt_id: "a1",
		});
		expect(second.record.attempts).toEqual(before.attempts);
		expect(second.record.questions[0]).toEqual(before.questions[0]);
		expect(second.question.generation).toMatchObject({ after_attempt_id: "a1" });
		// Generation alone never writes learning evidence.
		expect(eventsBefore).toHaveLength(1);
	});

	it("refuses to continue without naming the completed attempt, before spending a model call", async () => {
		const { revision } = await setupFeedback();
		const complete = vi.fn<ModelCompletion>(async () => ({ status: "ok", text: JSON.stringify(validReply), model: MODEL }));
		const before = await rawRecord();

		const result = await generateAndCommitQuestion(deps({ complete }), "s1.jsonl", request({
			request_id: "req_b", expected_revision: revision,
		}));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(409);
		expect(result.error).toBe("learning_state_invalid");
		expect(complete).not.toHaveBeenCalled();
		expect(await rawRecord()).toBe(before);
	});

	it("refuses an attempt that is not the checkpoint's last completed one", async () => {
		const { revision } = await setupFeedback();
		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			request_id: "req_b", expected_revision: revision, after_attempt_id: "a_other",
		}));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(409);
		expect(result.message).toContain("不一致");
	});

	it("leaves the feedback checkpoint untouched when the continuation model call fails", async () => {
		const { revision } = await setupFeedback();
		const before = await rawRecord();
		const result = await generateAndCommitQuestion(deps({
			complete: async () => ({ status: "timeout" }),
		}), "s1.jsonl", request({ request_id: "req_b", expected_revision: revision, after_attempt_id: "a1" }));

		expect(result.ok).toBe(false);
		expect(await rawRecord()).toBe(before);
		const record = (await store.get("s1.jsonl"))!;
		expect(record.checkpoint).toMatchObject({ revision, step: "feedback", question: { question_id: record.questions[0].question_id } });
	});

	it("saves one question when the same continuation request runs twice at once", async () => {
		const { revision } = await setupFeedback();
		const payload = request({
			request_id: "req_b", expected_revision: revision, after_attempt_id: "a1",
		});

		const [a, b] = await Promise.all([
			generateAndCommitQuestion(deps(), "s1.jsonl", payload),
			generateAndCommitQuestion(deps(), "s1.jsonl", payload),
		]);

		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
		expect(a.question.question_id).toBe(b.question.question_id);
		const record = (await store.get("s1.jsonl"))!;
		expect(record.questions).toHaveLength(2);
		expect(record.checkpoint.revision).toBe(revision + 1);
	});

	it("rejects the same request id used with a different after_attempt_id", async () => {
		const { revision } = await setupFeedback();
		const first = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			request_id: "req_b", expected_revision: revision, after_attempt_id: "a1",
		}));
		expect(first.ok).toBe(true);

		const conflicting = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			request_id: "req_b", expected_revision: revision, after_attempt_id: "a_other",
		}));
		expect(conflicting.ok).toBe(false);
		if (conflicting.ok) return;
		expect(conflicting.status).toBe(409);
		expect(conflicting.error).toBe("request_conflict");
		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(2);
	});

	it("returns the current checkpoint when an older generation request is replayed", async () => {
		const { revision } = await setupFeedback();
		const second = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			request_id: "req_b", expected_revision: revision, after_attempt_id: "a1",
		}));
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		// The first request is replayed after B exists. Its question comes back, but
		// the record (and therefore the checkpoint) is the current one.
		const replay = await generateAndCommitQuestion(deps(), "s1.jsonl", request());
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.created).toBe(false);
		expect(replay.question.question_id).toBe(second.record.questions[0].question_id);
		expect(replay.record.checkpoint.question).toEqual({
			question_id: second.question.question_id,
			question_version: second.question.question_version,
		});
		expect(replay.record.checkpoint.step).toBe("awaiting_answer");
	});

	it("refuses while an answer is still pending, even with a valid attempt id", async () => {
		const first = await generateAndCommitQuestion(deps(), "s1.jsonl", request());
		if (!first.ok) throw new Error("generation failed");
		const saved = await saveAnswer(answerDeps(), "s1.jsonl", {
			attempt_id: "a1", question_id: first.question.question_id,
			question_version: first.question.question_version,
			expected_revision: first.record.checkpoint.revision, answer: "答案",
		});
		if (!saved.ok) throw new Error("save failed");

		const result = await generateAndCommitQuestion(deps(), "s1.jsonl", request({
			request_id: "req_b", expected_revision: saved.record.checkpoint.revision, after_attempt_id: "a1",
		}));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(409);
		expect(result.message).toContain("尚未完成");
		expect((await store.get("s1.jsonl"))!.questions).toHaveLength(1);
	});
});

describe("E4.1a course provenance", () => {
	const assessmentReply = {
		result: "correct",
		feedback: "准确。",
		criteria: [{ criterion_id: "c1", judgment: "met", explanation: "提到变量绑定" }],
	};
	const answerDeps = (): AnswerServiceDeps => ({
		learningRecordStore: store,
		learnerDataDir: join(dir, "learner"),
		complete: async () => ({ status: "ok" as const, text: JSON.stringify(assessmentReply), model: MODEL }),
		processRunId: "process-1",
		maxEvaluationAttempts: 3,
		sessionExists: () => sessionAlive,
		now: () => new Date("2026-11-02T00:00:00.000Z"),
	});

	it("freezes the course on the question, the evidence event and the L1 state", async () => {
		const generated = await generateAndCommitQuestion(
			deps({ courseId: "course_python" }),
			"s1.jsonl",
			request({ concept: "函数" }),
		);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		// Private provenance: frozen at generation, never re-derived at finalize.
		expect(generated.question.generation?.course_id).toBe("course_python");

		const saved = await saveAnswer(answerDeps(), "s1.jsonl", {
			attempt_id: "a1",
			question_id: generated.question.question_id,
			question_version: generated.question.question_version,
			expected_revision: generated.record.checkpoint.revision,
			answer: "函数把输入映射为输出。",
		});
		if (!saved.ok) throw new Error(saved.message);
		const evaluated = await evaluateAttempt(answerDeps(), "s1.jsonl", "a1", saved.record.checkpoint.revision);
		if (!evaluated.ok) throw new Error(evaluated.message);
		const finalized = await finalizeAttempt(answerDeps(), "s1.jsonl", "a1", evaluated.record.checkpoint.revision);
		expect(finalized.ok).toBe(true);

		const events = await loadEvents(join(dir, "learner"));
		expect(events.at(-1)?.evidence?.course_id).toBe("course_python");
		expect(events.at(-1)?.context.concept_ids).toEqual([generated.question.concept_id]);

		const profile = JSON.parse(await readFile(join(dir, "learner", "profile.json"), "utf-8")) as {
			knowledge_states: { concept_id: string; course_id?: string }[];
		};
		expect(profile.knowledge_states).toHaveLength(1);
		expect(profile.knowledge_states[0]).toMatchObject({
			concept_id: generated.question.concept_id,
			course_id: "course_python",
		});
	});

	it("keeps a question generated without a course unclassified", async () => {
		const generated = await generateAndCommitQuestion(deps(), "s1.jsonl", request({ concept: "极限" }));
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		expect(generated.question.generation?.course_id).toBeUndefined();

		const saved = await saveAnswer(answerDeps(), "s1.jsonl", {
			attempt_id: "a2",
			question_id: generated.question.question_id,
			question_version: generated.question.question_version,
			expected_revision: generated.record.checkpoint.revision,
			answer: "极限描述无限趋近。",
		});
		if (!saved.ok) throw new Error(saved.message);
		const evaluated = await evaluateAttempt(answerDeps(), "s1.jsonl", "a2", saved.record.checkpoint.revision);
		if (!evaluated.ok) throw new Error(evaluated.message);
		const finalized = await finalizeAttempt(answerDeps(), "s1.jsonl", "a2", evaluated.record.checkpoint.revision);
		expect(finalized.ok).toBe(true);

		const events = await loadEvents(join(dir, "learner"));
		expect(events.at(-1)?.evidence?.course_id).toBeUndefined();
	});
});
