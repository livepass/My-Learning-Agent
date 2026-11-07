import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDir, writeText } from "../../storage/file-store.js";
import { serializeFrontmatter } from "../l2/wiki-maintainer.js";
import { loadPrerequisiteEdges, loadPrerequisiteEdgesAsync } from "./prerequisite-store.js";

describe("L2 prerequisite store", () => {
	it("loads explicit teaching dependencies and ignores ordinary links", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-prerequisites-"));
		try {
			const conceptsDir = join(root, "wiki", "concepts");
			ensureDir(conceptsDir);
			const frontmatter = serializeFrontmatter({
				title: "斜面加速度",
				created: "2026-08-09",
				updated: "2026-08-09",
				type: "concept",
				tags: ["physics"],
				sources: [],
				source_ids: [],
				status: "reviewed",
				confidence: "high",
				concept_id: "physics.inclined_plane_acceleration",
				prerequisites: [{
					concept_id: "physics.force_decomposition",
					relation: "required",
					required_level: 0.7,
					importance: 0.95,
					source: "teacher",
					source_confidence: 1,
					rationale: "需要计算沿斜面方向的分力。",
				}],
			});
			writeText(join(conceptsDir, "inclined-plane.md"), `${frontmatter}\n正文链接到 [[摩擦力]]。`);

			const edges = loadPrerequisiteEdges(root, "physics.inclined_plane_acceleration");
			expect(edges).toHaveLength(1);
			expect(edges[0]).toMatchObject({
				prerequisite_concept_id: "physics.force_decomposition",
				required_level: 0.7,
				source: "teacher",
			});
			// The HTTP request path uses the async walker; it must produce the
			// same edges as the synchronous one.
			const asyncEdges = await loadPrerequisiteEdgesAsync(root, "physics.inclined_plane_acceleration");
			expect(asyncEdges).toEqual(edges);
			expect(await loadPrerequisiteEdgesAsync(join(root, "missing"), "x")).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("course-scoped prerequisite reads", () => {
	it("only returns concept pages whose sources belong to the course", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-prerequisites-scope-"));
		try {
			const conceptsDir = join(root, "wiki", "concepts");
			ensureDir(conceptsDir);
			const page = (title: string, sourceIds: string[], prerequisite: string) => serializeFrontmatter({
				title,
				created: "2026-08-09",
				updated: "2026-08-09",
				type: "concept",
				tags: [],
				sources: [],
				source_ids: sourceIds,
				status: "reviewed",
				confidence: "high",
				concept_id: "python.decorator",
				prerequisites: [{ concept_id: prerequisite, relation: "required", required_level: 0.7 }],
			});
			writeText(join(conceptsDir, "own.md"), `${page("装饰器", ["l2src_python"], "python.closure")}\n正文。`);
			writeText(join(conceptsDir, "other.md"), `${page("装饰器", ["l2src_math"], "math.limit")}\n正文。`);
			writeText(join(conceptsDir, "unattributed.md"), `${page("装饰器", [], "global.unknown")}\n正文。`);

			const scoped = await loadPrerequisiteEdgesAsync(root, "python.decorator", {
				allowedSourceIds: ["l2src_python"],
			});
			expect(scoped.map((edge) => edge.prerequisite_concept_id)).toEqual(["python.closure"]);
			const global = await loadPrerequisiteEdgesAsync(root, "python.decorator");
			expect(global.map((edge) => edge.prerequisite_concept_id).sort()).toEqual([
				"global.unknown",
				"math.limit",
				"python.closure",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
