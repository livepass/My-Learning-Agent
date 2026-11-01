import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { initSession } from "./pi-runner.js";
import { normalizeConfig, normalizeModelConfig } from "../config.js";
import { resolveRuntimePaths } from "../runtime.js";
import { learningToolNames, resolveCapabilities } from "../shared/capabilities.js";
import { getL2Memory, closeL2Memory } from "../memory/l2/l2-memory.js";
import { getL3Memory, closeL3Memory } from "../memory/l3/l3-tools.js";

let root: string;
let session: Awaited<ReturnType<typeof initSession>>;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "inno-learning-policy-"));
	const paths = resolveRuntimePaths({ home: root, configDir: join(root, "config"), dataDir: join(root, "data"), workspaceDir: join(root, "workspace"), skillsDir: join(root, "skills") });
	await mkdir(paths.configDir, { recursive: true });
	await mkdir(paths.workspaceDir, { recursive: true });
	await mkdir(join(paths.configDir, "extensions"), { recursive: true });
	await writeFile(join(paths.workspaceDir, "SYSTEM.md"), "UNTRUSTED_SYSTEM_MARKER");
	await writeFile(join(paths.workspaceDir, "APPEND_SYSTEM.md"), "UNTRUSTED_APPEND_MARKER");
	await writeFile(join(paths.workspaceDir, "agent.md"), "UNTRUSTED_WORKSPACE_MARKER");
	await writeFile(join(paths.configDir, "extensions", "untrusted.ts"), `import { writeFileSync } from "node:fs"; export default () => writeFileSync(${JSON.stringify(join(root, "untrusted-executed"))}, "ran");`);
	await writeFile(join(paths.configDir, "settings.json"), JSON.stringify({ defaultTools: ["+bash", "+read", "+write", "+edit", "+codemode"] }));
	vi.stubEnv("PI_CODING_AGENT_DIR", paths.configDir);
	const config = normalizeConfig({ profile: "learning", providers: { fixture: { baseUrl: "http://localhost:1", apiKey: "fixture", models: [normalizeModelConfig({ id: "dummy" })] } }, mcp: { enabled: true }, subagents: { enabled: true }, plugins: { computerUse: { enabled: true }, codemode: { enabled: true }, officeEngine: { enabled: true } } });
	session = await initSession(config, paths);
}, 90_000);
afterAll(async () => {
	session?.dispose();
	if (root) {
		await getL2Memory(join(root, "data", "l2")).backfill();
		await getL3Memory(join(root, "data", "l3"), join(root, "data", "sessions")).backfill();
		closeL2Memory(join(root, "data", "l2"));
		closeL3Memory(join(root, "data", "l3"));
	}
	vi.unstubAllEnvs();
	if (root && dirname(root) === resolve(tmpdir()) && basename(root).startsWith("inno-learning-policy-")) await rm(root, { recursive: true, force: true });
});
it("uses the real SDK allowlist despite enabled legacy plugins and untrusted resources", async () => {
	const expected = learningToolNames(resolveCapabilities({ profile: "learning" } as Parameters<typeof resolveCapabilities>[0]));
	expect(session.getActiveToolNames().sort()).toEqual(expected.sort());
	for (const name of ["bash", "powershell", "read", "write", "edit", "record_learning_evidence", "mcp", "subagent", "codemode"]) expect(session.getActiveToolNames()).not.toContain(name);
	expect(session.systemPrompt).not.toContain("UNTRUSTED_");
	await expect(access(join(root, "untrusted-executed"))).rejects.toThrow();
});
