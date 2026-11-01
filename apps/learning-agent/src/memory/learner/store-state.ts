import { join } from "node:path";
import {
	listDirectory,
	readJsonStrict,
	statFile,
	writeJsonDurable,
} from "../../storage/file-store.js";

/**
 * Durable store lifecycle marker.
 *
 * `profile.json` cannot distinguish "this directory is new" from "the profile
 * was lost", and a silent rebuild in the second case would erase human-managed
 * fields that the ledger never recorded. The marker makes that distinction
 * explicit and gives the first-initialisation sequence a crash-safe state:
 *
 *   (new dir) -> write `initializing` -> first profile replace -> write `ready`
 *
 * Every interruption point is decidable from (marker, profile presence, other
 * store files), see `classifyStoreState`.
 */

export const STORE_STATE_FILE = "store-state.json";

export type ProfileStorePhase = "initializing" | "ready";

export interface RecoveryAudit {
	at: string;
	accepted_manual_loss: boolean;
	lost_fields: string[];
	reason: string;
}

export interface StoreStateFile {
	schema_version: 1;
	profile_state: ProfileStorePhase;
	created_at: string;
	ready_at?: string;
	projection_rule_version: number;
	recovery?: RecoveryAudit;
}

export type StoreClassification =
	| { kind: "new_directory" }
	| { kind: "first_initialization"; state: StoreStateFile }
	| { kind: "ready"; state: StoreStateFile }
	| { kind: "legacy_upgrade"; state: StoreStateFile }
	| { kind: "inconsistent"; reason: string }
	| { kind: "profile_missing"; state: StoreStateFile };

function statePath(dir: string): string {
	return join(dir, STORE_STATE_FILE);
}

export class StoreStateError extends Error {
	readonly code = "STORE_STATE_CORRUPT" as const;

	constructor(message: string) {
		super(message);
		this.name = "StoreStateError";
	}
}

export async function readStoreState(
	dir: string,
): Promise<{ found: false } | { found: true; value: StoreStateFile }> {
	const read = await readJsonStrict<StoreStateFile>(statePath(dir));
	if (!read.found) return { found: false };
	const value = read.value;
	if (
		!value
		|| value.schema_version !== 1
		|| (value.profile_state !== "initializing" && value.profile_state !== "ready")
		|| typeof value.created_at !== "string"
	) {
		throw new StoreStateError("store-state.json 结构不受支持");
	}
	return { found: true, value };
}

export async function writeStoreState(dir: string, state: StoreStateFile): Promise<void> {
	await writeJsonDurable(statePath(dir), state);
}

/**
 * True when the directory already contains learner history. Lock files, the
 * state marker itself and preserved torn-tail blobs are not history: they are
 * created by the owner before the first successful profile write.
 */
export async function hasStoreHistory(dir: string): Promise<boolean> {
	const files = await listDirectory(dir);
	for (const name of files) {
		if (name === STORE_STATE_FILE) continue;
		if (name.startsWith(".writer.lock")) continue;
		if (name === "profile.json" || name === "events.manifest.json" || name === "dedupe-index.json") {
			const info = await statFile(join(dir, name));
			if (info && info.size > 0) return true;
			continue;
		}
		if (/^events\..+\.(jsonl|archive)$/.test(name) || name === "events.jsonl") return true;
	}
	return false;
}

export async function profileExists(dir: string): Promise<boolean> {
	return !!(await statFile(join(dir, "profile.json")));
}

export function createStoreState(now = new Date()): StoreStateFile {
	return {
		schema_version: 1,
		profile_state: "initializing",
		created_at: now.toISOString(),
		projection_rule_version: 0,
	};
}

/**
 * Decide what the directory is, using the marker, the profile and any other
 * store files. "No marker" is never by itself proof of a new directory.
 */
export async function classifyStoreState(dir: string): Promise<StoreClassification> {
	const [stateRead, exists, history] = await Promise.all([
		readStoreState(dir),
		profileExists(dir),
		hasStoreHistory(dir),
	]);

	if (!stateRead.found) {
		if (exists) return { kind: "legacy_upgrade", state: createStoreState() };
		if (!history) return { kind: "new_directory" };
		return { kind: "inconsistent", reason: "存在学习历史文件，但缺少画像与状态标记" };
	}

	const state = stateRead.value;
	if (exists) {
		return state.profile_state === "ready"
			? { kind: "ready", state }
			: { kind: "first_initialization", state };
	}
	if (state.profile_state === "initializing") return { kind: "first_initialization", state };
	return { kind: "profile_missing", state };
}
