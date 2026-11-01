import type { ChatMessage } from "@inno-web/types/chat.js";

export interface CaseMeta {
	id: string;
	title: string;
	titleEn: string;
	description: string;
	tags: string[];
	recordedAt: string;
	messageCount: number;
}

export interface WorkspaceInitFile {
	path: string;
	content?: string;
	asset?: string;
	size: number;
	updatedAt: string;
}

export interface WorkspaceKeyframe {
	atMessage: number;
	toolCallId: string;
	path: string;
	/** Inline text content. Absent for binary files, which carry `asset`. */
	content?: string;
	/** Static asset path (cases/<id>/assets/...) for binary files. */
	asset?: string;
	/** On-disk size; needed for asset keyframes (no content to measure). */
	size?: number;
	change: "created" | "modified";
}

export interface WikiKeyframe {
	atMessage: number;
	toolCallId: string;
	page: { path: string; title: string; content: string };
}

/**
 * One ordered piece of an assistant turn. The mock backend walks a turn's
 * segments to synthesize a live-like SSE stream (text/thinking deltas, tool
 * start/end); `at`/`endAt` are absolute ms from the session log and only
 * relative gaps matter (they get clamped for pacing).
 */
export type CaseStreamSegment =
	| { kind: "thinking"; text: string; at: number }
	| { kind: "text"; text: string; at: number }
	| {
			kind: "tool";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result?: unknown;
			isError?: boolean;
			at: number;
			endAt: number;
	  };

/** ChatMessage as exported by scripts/export-showcase-cases.ts. */
export type CaseMessage = ChatMessage & { stream?: CaseStreamSegment[] };

export interface CasePanels {
	workspace: {
		workspaceId: string;
		name: string;
		initial: WorkspaceInitFile[];
		keyframes: WorkspaceKeyframe[];
	} | null;
	wiki: { keyframes: WikiKeyframe[] };
	profile: {
		firstEventAt: number | null;
		events: Array<{ atMessage: number; toolCallId: string; summary: string }>;
		profile: unknown | null;
	};
}

export interface CaseDoc extends CaseMeta {
	messages: CaseMessage[];
	panels: CasePanels;
}

export async function fetchCaseIndex(): Promise<CaseMeta[]> {
	const res = await fetch(`${import.meta.env.BASE_URL}cases/index.json`);
	if (!res.ok) throw new Error(`Failed to load case index: ${res.status}`);
	const data = (await res.json()) as { cases: CaseMeta[] };
	return data.cases;
}

export async function fetchCase(id: string): Promise<CaseDoc> {
	const res = await fetch(`${import.meta.env.BASE_URL}cases/${encodeURIComponent(id)}.json`);
	if (!res.ok) throw new Error(`Failed to load case "${id}": ${res.status}`);
	return (await res.json()) as CaseDoc;
}
