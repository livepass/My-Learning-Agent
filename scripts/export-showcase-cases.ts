/**
 * Export recorded PI sessions into static showcase cases for apps/showcase.
 *
 * Thin CLI wrapper around apps/learning-agent/src/showcase/case-exporter.ts —
 * the same core powers the product's one-click export
 * (POST /api/sessions/:id/showcase-export).
 *
 * Usage:
 *   npx tsx scripts/export-showcase-cases.ts [--sessions-dir <dir>] [--out <dir>] [--only <id,id>]
 *   npx tsx scripts/export-showcase-cases.ts --list
 *   npx tsx scripts/export-showcase-cases.ts --session <file-or-substring> \
 *     [--id my-case] [--title 标题] [--title-en Title] [--description ...] \
 *     [--tags a,b] [--max-user-turns N] [--workspace-name x] [--exclude p1,p2]
 *
 * Defaults: --sessions-dir runtime/data/sessions --out apps/showcase/public/cases
 *
 * `--list` prints every recorded session (time, workspace, turns, first user
 * message) so you can pick one; `--session` exports it without editing the
 * CASES registry below. Both `--only` and `--session` UPSERT into index.json
 * instead of replacing it, so partial runs don't clobber other cases.
 *
 * IMPORTANT: exported cases are meant to be published. Always review the
 * output JSON before committing — the sanitizer rewrites paths and common
 * secret shapes, but message CONTENT is preserved verbatim.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildPathRewrites,
	deriveCaseId,
	exportShowcaseCase,
	textFromContent,
	upsertShowcaseIndex,
	type CaseSpec,
	type ShowcaseCaseIndexEntry,
} from "../apps/learning-agent/src/showcase/case-exporter.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// --- Case registry -----------------------------------------------------------
// One entry per published case. `maxUserTurns` optionally trims the tail of a
// long session so the replay stays digestible.

const CASES: CaseSpec[] = [
	{
		id: "trig-handout",
		sessionFile: "2026-06-05T14-39-09-564Z_019e9839-40fc-7e36-9742-655ab4a46828.jsonl",
		title: "生成一份三角函数讲义",
		titleEn: "Generating a trigonometry handout",
		description: "学习者说明自己的薄弱点后，agent 先理论后练习，生成讲义并记录学习事件到 L1 画像。",
		tags: ["L1 学习者画像", "讲义生成", "个性化教学"],
		maxUserTurns: 8,
	},
	{
		id: "l2-wiki-autoresearch",
		sessionFile: "2026-06-11T07-50-22-966Z_019eb5a9-29f6-7611-b5ba-fcbbdfcf07aa.jsonl",
		title: "什么是 AutoResearch？（结合知识库）",
		titleEn: "Explaining AutoResearch with the L2 wiki",
		description: "agent 检索 L2 wiki 与 L3 历史会话，结合本地论文讲解概念，并把新内容归档回知识库。",
		tags: ["L2 Wiki", "L3 跨会话回忆", "文档解析"],
	},
	{
		id: "paper-explain",
		sessionFile: "2026-07-05T13-54-49-451Z_019f328f-71eb-7cd2-8ee3-d64dcfd8db13.jsonl",
		title: "目录下这篇论文讲了什么",
		titleEn: "Walking through a paper in the workspace",
		description: "agent 解析工作区里的 PDF 论文，给出结构化解读。",
		tags: ["文档解析", "论文解读"],
		excludePaths: ["截屏2026-06-30 19.28.13.png"],
	},
	{
		id: "gaokao-geometry",
		sessionFile: "2026-06-14T15-55-58-389Z_019ec6d8-d035-7664-bf81-8c5e8a90cd0d.jsonl",
		title: "高考数学立体几何题讲解",
		titleEn: "Gaokao solid-geometry tutoring",
		description: "查找高考立体几何真题，通过互动提问确认需求后逐题讲解，并记录掌握情况。",
		tags: ["互动提问", "题目讲解", "L1 学习者画像"],
	},
	{
		id: "problem-explain",
		sessionFile: "2026-06-14T16-23-09-514Z_019ec6f1-b3ca-7e37-a596-ffa9eeb3fa6d.jsonl",
		title: "讲解一道数学题",
		titleEn: "Explaining a math problem",
		description: "读取工作区中的题目文件，逐步讲解解题思路。",
		tags: ["题目讲解"],
	},
];

/** `--list`: one line per recorded session so you can pick one to export. */
function listSessions(sessionsDir: string): void {
	const files = readdirSync(sessionsDir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();
	for (const file of files) {
		let started = "";
		let cwd = "";
		let userTurns = 0;
		let toolCalls = 0;
		let firstUser = "";
		for (const line of readFileSync(join(sessionsDir, file), "utf-8").split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "session" && !cwd) {
				cwd = String(entry.cwd ?? "");
				started = String(entry.timestamp ?? "").slice(0, 16).replace("T", " ");
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message as Record<string, unknown> | undefined;
			if (msg?.role === "user") {
				const text = textFromContent(msg.content);
				if (text) {
					userTurns++;
					if (!firstUser) firstUser = text.replace(/\s+/g, " ").slice(0, 60);
				}
			} else if (msg?.role === "assistant" && Array.isArray(msg.content)) {
				toolCalls += (msg.content as Array<Record<string, unknown>>).filter((c) => c?.type === "toolCall").length;
			}
		}
		console.log(
			`${file}\n  ${started}  ${cwd ? basename(cwd) : "?"}  ${userTurns} user turns, ${toolCalls} tool calls\n  ${firstUser}`,
		);
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const flag = (name: string, fallback: string): string => {
		const idx = args.indexOf(`--${name}`);
		return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
	};
	const sessionsDir = resolve(flag("sessions-dir", join(repoRoot, "runtime/data/sessions")));
	const dataDir = resolve(flag("data-dir", join(repoRoot, "runtime/data")));
	const outDir = resolve(flag("out", join(repoRoot, "apps/showcase/public/cases")));
	const only = flag("only", "").split(",").map((s) => s.trim()).filter(Boolean);

	if (args.includes("--list")) {
		listSessions(sessionsDir);
		return;
	}

	// Ad-hoc export without editing CASES:
	//   --session <file-or-substring> [--id x] [--title x] [--title-en x]
	//   [--description x] [--tags a,b] [--max-user-turns N]
	//   [--workspace-name x] [--exclude path1,path2]
	let specs: CaseSpec[] = CASES;
	const sessionFlag = flag("session", "");
	if (sessionFlag) {
		const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
		const matches = files.filter((f) => f.includes(sessionFlag));
		if (matches.length === 0) {
			console.error(`[error] no session file matches "${sessionFlag}" in ${sessionsDir} (try --list)`);
			process.exit(1);
		}
		if (matches.length > 1) {
			console.error(`[error] "${sessionFlag}" matches ${matches.length} sessions, be more specific:\n  ${matches.join("\n  ")}`);
			process.exit(1);
		}
		const sessionFile = matches[0];
		specs = [{
			id: flag("id", "") || deriveCaseId(sessionFile),
			sessionFile,
			title: flag("title", ""), // falls back to the first user message
			titleEn: flag("title-en", ""),
			description: flag("description", ""),
			tags: flag("tags", "").split(",").map((s) => s.trim()).filter(Boolean),
			maxUserTurns: Number(flag("max-user-turns", "0")) || undefined,
			workspaceName: flag("workspace-name", "") || undefined,
			excludePaths: flag("exclude", "").split(",").map((s) => s.trim()).filter(Boolean),
		}];
	}

	const rewrites = buildPathRewrites({
		workspaceContainers: [join(repoRoot, "workspace")],
		repoRoots: [repoRoot],
	});

	const exported: ShowcaseCaseIndexEntry[] = [];
	for (const spec of specs) {
		if (only.length > 0 && !only.includes(spec.id)) continue;
		const entry = exportShowcaseCase(spec, { sessionsDir, dataDir, outDir }, rewrites);
		if (!entry) {
			console.warn(`[skip] ${spec.id}: session file not found: ${join(sessionsDir, spec.sessionFile)}`);
			continue;
		}
		exported.push(entry);
		console.log(`[ok] ${spec.id}: ${entry.messageCount} messages -> ${spec.id}.json`);
	}
	upsertShowcaseIndex(outDir, exported);
	console.log(`[done] ${exported.length} case(s) exported to ${outDir}`);
	console.log("REMINDER: review the exported JSON for sensitive content before publishing.");
}

main();
