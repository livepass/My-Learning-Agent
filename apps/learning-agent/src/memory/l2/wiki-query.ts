import { join } from "node:path";
import { readText, fileExists } from "../../storage/file-store.js";
import { readManifest, readManifestAsync } from "./manifest-store.js";
import { parseFrontmatter } from "./wiki-maintainer.js";
import type { ManifestEntry } from "./types.js";
import type { L2Memory } from "./l2-memory.js";
import type { L2SearchResult } from "./l2-search.js";

export interface WikiQueryScope {
	/** `undefined` = legacy unclassified session (global); `[]` = course with no material. */
	sourceIds?: readonly string[];
}

function scopedOverview(entries: readonly ManifestEntry[], sourceIds: readonly string[]): string {
	const allowed = new Set(sourceIds);
	const visible = entries.filter((entry) => allowed.has(entry.id));
	if (visible.length === 0) return "## 课程资料\n\n当前课程尚未关联任何资料。";
	const lines = visible.map((entry) =>
		`- ${entry.title}（${entry.status === "indexed" ? "已索引" : entry.status === "error" ? "处理失败" : "处理中"}${entry.passageCount ? `，${entry.passageCount} 段` : ""}）`,
	);
	return `## 课程资料\n\n${lines.join("\n")}`;
}

export interface WikiQueryHit {
	path: string;
	title: string;
	score: number | null;
	via: string[];
	sourceIds: string[];
}

export interface WikiQueryDetailedResult {
	text: string;
	mode: "indexed" | "substring";
	hits: WikiQueryHit[];
}

/**
 * Read the wiki index.
 */
export function readIndex(l2DataDir: string): string {
	const indexPath = join(l2DataDir, "wiki", "index.md");
	if (!fileExists(indexPath)) return "L2 Wiki 尚未初始化，暂无索引。";
	return readText(indexPath);
}

/**
 * Read a specific wiki page by relative path.
 */
export function readWikiPage(l2DataDir: string, relativePath: string): string | null {
	const absPath = join(l2DataDir, relativePath);
	if (!fileExists(absPath)) return null;
	return readText(absPath);
}

/**
 * Search manifest entries by keyword.
 * Searches title, tags, AND wiki page body content for full recall.
 */
export function searchEntries(l2DataDir: string, query: string): ManifestEntry[] {
	const entries = readManifest(l2DataDir);
	const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((entry) => {
		// Search title + tags first (fast path)
		const metaText = [entry.title, ...entry.tags].join(" ").toLowerCase();
		if (keywords.some((kw) => metaText.includes(kw))) return true;
		// Fall back to searching wiki page body content
		for (const wikiPath of entry.wikiPages) {
			const content = readWikiPage(l2DataDir, wikiPath);
			if (content && keywords.some((kw) => content.toLowerCase().includes(kw))) return true;
		}
		return false;
	});
}

/**
 * Query wiki: return index + matched page contents.
 */
export function queryWiki(l2DataDir: string, query: string): string {
	const index = readIndex(l2DataDir);
	const trimmed = (query ?? "").trim();

	// Empty query → just return the index overview.
	if (!trimmed) {
		return `## Wiki 索引\n\n${index}\n\n---\n\n提示：传入 query 参数（如「Python async」）可定位并返回相关页面内容。`;
	}

	const matches = searchEntries(l2DataDir, trimmed);

	if (matches.length === 0) {
		return `## Wiki 索引\n\n${index}\n\n---\n\n未找到与「${trimmed}」相关的内容。`;
	}

	const sections: string[] = [
		`## Wiki 索引\n\n${index}`,
		"---",
		`## 查询结果: "${trimmed}" (${matches.length} 条匹配)`,
		"",
	];

	for (const entry of matches.slice(0, 5)) {
		for (const wikiPath of entry.wikiPages) {
			const content = readWikiPage(l2DataDir, wikiPath);
			if (content) {
				sections.push(`### [[${entry.title}]]\n`);
				sections.push(content);
				sections.push("---\n");
			}
		}
	}

	return sections.join("\n");
}

/**
 * Query wiki via indexed retrieval (BM25 + graph), falling back to
 * the substring {@link queryWiki} when the index store is unavailable.
 */
export async function queryWikiHybridDetailed(
	l2Memory: L2Memory,
	query: string,
	scope: WikiQueryScope = {},
): Promise<WikiQueryDetailedResult> {
	const l2DataDir = l2Memory.dataDir;
	const trimmed = (query ?? "").trim();
	const scoped = scope.sourceIds !== undefined;

	if (!trimmed) {
		// A course must never receive the global wiki index: it names sources the
		// course does not own. The scoped overview is built from its bindings.
		if (scoped) {
			const overview = scopedOverview(await readManifestAsync(l2DataDir), scope.sourceIds!);
			return {
				text: `${overview}\n\n---\n\n提示：传入 query 参数可检索本课程资料。`,
				mode: "indexed",
				hits: [],
			};
		}
		return {
			text: `## Wiki 索引\n\n${readIndex(l2DataDir)}\n\n---\n\n提示：传入 query 参数（如「Python async」）可定位并返回相关页面内容。`,
			mode: "indexed",
			hits: [],
		};
	}

	if (scope.sourceIds !== undefined && scope.sourceIds.length === 0) {
		return {
			text: "## 课程资料\n\n当前课程尚未关联任何资料，无法检索。请先在课程中上传或关联资料。",
			mode: "indexed",
			hits: [],
		};
	}

	const results = await l2Memory.search(
		trimmed,
		5,
		scope.sourceIds !== undefined ? { sourceIds: scope.sourceIds } : {},
	);
	if (results === null) {
		const matches = searchEntries(l2DataDir, trimmed)
			.filter((entry) => !scoped || scope.sourceIds!.includes(entry.id));
		return {
			text: scoped
				? `## 课程资料检索\n\n检索索引暂不可用，已退回按标题匹配。\n\n${matches.map((entry) => `- ${entry.title}`).join("\n") || "当前课程资料中没有找到相关内容。"}`
				: queryWiki(l2DataDir, query),
			mode: "substring",
			hits: matches.slice(0, 5).flatMap((entry) => entry.wikiPages.map((path) => ({
				path,
				title: entry.title,
				score: null,
				via: ["substring"],
				sourceIds: [entry.id],
			}))),
		};
	}
	if (results.length === 0) {
		return {
			text: scoped
				? `## 课程资料检索\n\n未在本课程资料中找到与「${trimmed}」相关的内容。`
				: `## Wiki 索引\n\n${readIndex(l2DataDir)}\n\n---\n\n未找到与「${trimmed}」相关的内容。`,
			mode: "indexed",
			hits: [],
		};
	}

	const sections: string[] = [
		scoped ? "## 课程资料检索" : `## Wiki 索引\n\n${readIndex(l2DataDir)}`,
		"---",
		`## 查询结果: "${trimmed}" (${results.length} 条匹配)`,
		"",
	];
	for (const r of results) {
		const content = readWikiPage(l2DataDir, r.path);
		if (content) {
			const passage = parseFrontmatter(content).frontmatter?.passage;
			const locator = passage
				? `\n位置：${[passage.heading_path, passage.page_start !== undefined
					? passage.page_end !== undefined && passage.page_end !== passage.page_start
						? `P${passage.page_start}–${passage.page_end}`
						: `P${passage.page_start}`
					: ""].filter(Boolean).join(" · ") || "未标注"}\n`
				: "";
			sections.push(`### [[${r.title}]]  \`${r.path}\`  (${r.via.join("+")})${locator}`);
			sections.push(content);
			sections.push("---\n");
		}
	}
	return {
		text: sections.join("\n"),
		mode: "indexed",
		hits: results.map((result: L2SearchResult) => ({
			path: result.path,
			title: result.title,
			score: result.score,
			via: result.via,
			sourceIds: result.sourceIds,
		})),
	};
}

export async function queryWikiHybrid(
	l2Memory: L2Memory,
	query: string,
	scope: WikiQueryScope = {},
): Promise<string> {
	return (await queryWikiHybridDetailed(l2Memory, query, scope)).text;
}
