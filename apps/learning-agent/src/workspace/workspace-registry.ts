import { join, relative, resolve } from "node:path";
import { ensureDir, readJson, writeJson } from "../storage/file-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceMeta {
	id: string;
	name: string;
	relPath: string;       // relative to workspaceDir
	createdAt: string;
	updatedAt: string;
	isTemp: boolean;
}

interface RegistryFile {
	workspaces: WorkspaceMeta[];
}

type SessionWorkspaceMap = Record<string, string>;

export const DEFAULT_WORKSPACE_ID = "default";
export const TEMP_WORKSPACE_ID = "tmp";
const DEFAULT_WORKSPACE_REL_PATH = ".pub";
const TEMP_WORKSPACE_REL_PATH = ".tmp";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Minimal workspace registry for a single shared run directory.
 *
 * The learning product has no file browsing, no per-task or per-channel
 * workspace and no workspace management API, so the registry only keeps what
 * session cwd resolution needs: the shared temp workspace plus the
 * session → workspace binding. Workspaces are never created, renamed or
 * deleted at runtime; the legacy default entry is preserved when an older
 * install still has one so existing sessions keep resolving to their
 * original directory.
 */
export class WorkspaceRegistry {
	constructor(
		private readonly workspaceDir: string,
		private readonly dataDir: string,
	) {}

	private registryPath(): string {
		return join(this.dataDir, "workspaces", "registry.json");
	}

	private sessionMapPath(): string {
		return join(this.dataDir, "sessions", "workspaces.json");
	}

	private loadRegistry(): RegistryFile {
		return readJson<RegistryFile>(this.registryPath(), { workspaces: [] });
	}

	private saveRegistry(reg: RegistryFile): void {
		writeJson(this.registryPath(), reg);
	}

	private loadSessionMap(): SessionWorkspaceMap {
		return readJson<SessionWorkspaceMap>(this.sessionMapPath(), {});
	}

	private saveSessionMap(map: SessionWorkspaceMap): void {
		writeJson(this.sessionMapPath(), map);
	}

	/** Ensure the shared tmp workspace exists; preserve a legacy default if present. */
	ensureBootstrapped(): void {
		ensureDir(this.workspaceDir);
		ensureDir(join(this.workspaceDir, TEMP_WORKSPACE_REL_PATH));
		const reg = this.loadRegistry();
		let changed = false;

		// Only normalize a default workspace that a legacy install already has
		// bound to existing sessions; it is never recreated once removed.
		const def = reg.workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID);
		if (def) {
			ensureDir(join(this.workspaceDir, DEFAULT_WORKSPACE_REL_PATH));
			// Legacy installs labelled this the shared "公共空间"; it is now an
			// ordinary workspace with no special fallback role.
			if (def.name === "公共空间") { def.name = "默认工作区"; changed = true; }
			if (def.relPath !== DEFAULT_WORKSPACE_REL_PATH) {
				def.relPath = DEFAULT_WORKSPACE_REL_PATH;
				changed = true;
			}
		}

		if (!reg.workspaces.some((w) => w.id === TEMP_WORKSPACE_ID)) {
			const now = new Date().toISOString();
			reg.workspaces.push({
				id: TEMP_WORKSPACE_ID,
				name: "临时工作区",
				relPath: TEMP_WORKSPACE_REL_PATH,
				createdAt: now,
				updatedAt: now,
				isTemp: true,
			});
			changed = true;
		}

		if (changed) this.saveRegistry(reg);
	}

	private getWorkspace(id: string): WorkspaceMeta | null {
		return this.loadRegistry().workspaces.find((w) => w.id === id) ?? null;
	}

	/** Resolve a workspace id to its absolute directory. Returns null if invalid or escapes workspaceDir. */
	resolveWorkspaceDir(id: string | null | undefined): string | null {
		const ws = this.getWorkspace(id || TEMP_WORKSPACE_ID);
		if (!ws) return null;
		const resolved = resolve(this.workspaceDir, ws.relPath);
		const rel = relative(resolve(this.workspaceDir), resolved);
		if (rel.startsWith("..")) return null;
		return resolved;
	}

	// ---- Session ↔ Workspace mapping ----

	/** Unbound sessions fall back to the shared temp workspace. */
	getSessionWorkspaceId(sessionId: string): string {
		return this.loadSessionMap()[sessionId] ?? TEMP_WORKSPACE_ID;
	}

	bindSession(sessionId: string, workspaceId: string): boolean {
		if (!this.getWorkspace(workspaceId)) return false;
		const map = this.loadSessionMap();
		map[sessionId] = workspaceId;
		this.saveSessionMap(map);
		return true;
	}

	unbindSession(sessionId: string): void {
		const map = this.loadSessionMap();
		if (sessionId in map) {
			delete map[sessionId];
			this.saveSessionMap(map);
		}
	}
}
