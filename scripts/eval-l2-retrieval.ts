import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openL2IndexStore, type L2PageDoc } from "../apps/learning-agent/src/memory/l2/l2-index-store.js";
import { searchL2 } from "../apps/learning-agent/src/memory/l2/l2-search.js";

interface EvalFixture {
	version: number;
	thresholds: {
		recallAt5: number;
		mrr: number;
		maxNoResultRate: number;
		progressiveDisclosureP95Chars: number;
		progressiveDisclosureMaxChars: number;
	};
	pages: Array<Pick<L2PageDoc, "path" | "title" | "type" | "tags" | "sourceIds" | "body">>;
	queries: Array<{ id: string; query: string; relevantPaths: string[] }>;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(scriptDir, "..", "apps", "inno-agent", "eval", "l2-retrieval-v1.json");

function percentile95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

async function main(): Promise<void> {
	const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as EvalFixture;
	const workDir = mkdtempSync(join(tmpdir(), "inno-l2-retrieval-eval-"));
	const store = await openL2IndexStore(workDir);
	if (!store) throw new Error("L2 retrieval evaluation requires Node.js >=22.5 with node:sqlite.");

	try {
		const docs: L2PageDoc[] = fixture.pages.map((page) => ({
			...page,
			contentHash: createHash("sha256").update(JSON.stringify(page)).digest("hex").slice(0, 16),
			mtimeMs: 0,
		}));
		store.upsertPages(docs);
		const bodyLength = new Map(docs.map((page) => [page.path, page.body.length]));

		let hits = 0;
		let reciprocalRank = 0;
		let noResults = 0;
		const selectedCharacters: number[] = [];
		const queryResults: Array<Record<string, unknown>> = [];
		for (const query of fixture.queries) {
			const results = await searchL2(store, query.query, { limit: 5 });
			const relevant = new Set(query.relevantPaths);
			const firstRank = results.findIndex((result) => relevant.has(result.path)) + 1;
			if (firstRank > 0) {
				hits += 1;
				reciprocalRank += 1 / firstRank;
			}
			if (results.length === 0) noResults += 1;
			const characters = results.reduce((sum, result) => sum + (bodyLength.get(result.path) ?? 0), 0);
			selectedCharacters.push(characters);
			queryResults.push({
				id: query.id,
				query: query.query,
				firstRelevantRank: firstRank || null,
				selectedCharacters: characters,
				hits: results.map((result) => ({ path: result.path, score: result.score, via: result.via })),
			});
		}

		const count = fixture.queries.length;
		const metrics = {
			recallAt5: hits / count,
			mrr: reciprocalRank / count,
			noResultRate: noResults / count,
			p95SelectedCharacters: percentile95(selectedCharacters),
			maxSelectedCharacters: Math.max(0, ...selectedCharacters),
		};
		const decisions = {
			embeddingRecommended:
				metrics.recallAt5 < fixture.thresholds.recallAt5 || metrics.mrr < fixture.thresholds.mrr,
			progressiveDisclosureRecommended:
				metrics.p95SelectedCharacters > fixture.thresholds.progressiveDisclosureP95Chars
				|| metrics.maxSelectedCharacters > fixture.thresholds.progressiveDisclosureMaxChars,
		};
		const passed = metrics.recallAt5 >= fixture.thresholds.recallAt5
			&& metrics.mrr >= fixture.thresholds.mrr
			&& metrics.noResultRate <= fixture.thresholds.maxNoResultRate;

		console.log(JSON.stringify({ fixtureVersion: fixture.version, pages: docs.length, queries: count, metrics, decisions, passed, queryResults }, null, 2));
		if (!passed) process.exitCode = 1;
	} finally {
		store.close();
		rmSync(workDir, { recursive: true, force: true });
	}
}

await main();
