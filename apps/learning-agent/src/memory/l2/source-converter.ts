import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, writeText, writeTextAsync } from "../../storage/file-store.js";
import type { RawSourceType } from "./types.js";
import { logger } from "../../logger.js";

function extractedRelativePath(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return ["extracted", `${slug}-${randomUUID().slice(0, 6)}.md`].join("/");
}

/** Async variant for request paths. Same naming and conversion as the sync owner. */
export async function convertToExtractedAsync(
	l2DataDir: string,
	title: string,
	content: string,
	sourceType: RawSourceType,
): Promise<string> {
	const markdown = convertContent(content, sourceType);
	// writeTextAsync creates the parent directory atomically.
	const relative = extractedRelativePath(title);
	await writeTextAsync(join(l2DataDir, relative), markdown);
	return relative;
}

/**
 * Convert raw content to extracted markdown and save to data/l2/extracted/.
 * Returns the relative path from l2DataDir.
 */
export function convertToExtracted(
	l2DataDir: string,
	title: string,
	content: string,
	sourceType: RawSourceType,
): string {
	const markdown = convertContent(content, sourceType);
	const dir = join(l2DataDir, "extracted");
	ensureDir(dir);
	const relative = extractedRelativePath(title);
	writeText(join(l2DataDir, relative), markdown);
	return relative;
}

function convertContent(content: string, sourceType: RawSourceType): string {
	switch (sourceType) {
		case "text":
		case "markdown":
			return content;
		case "conversation":
			return formatConversation(content);
		case "pdf":
		case "word":
		case "image":
			// 文本已由 LiteParse 在上游提取，此处直接透传
			return content;
	}
}

/**
 * Format a conversation snippet into readable markdown.
 * Supports JSON array [{role, content}] or plain text.
 */
function formatConversation(content: string): string {
	try {
		const messages = JSON.parse(content) as Array<{ role: string; content: string }>;
		if (Array.isArray(messages)) {
			const formatted = messages
				.filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
				.map((m) => `**${m.role}**: ${m.content}`)
				.join("\n\n");
			if (formatted) return formatted;
		}
	} catch (err) {
		logger.warn({ err }, "failed to parse conversation JSON, treating as plain text");
		// Not JSON, treat as plain text conversation
	}
	return content;
}
