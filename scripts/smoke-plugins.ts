/**
 * Smoke harness: runs createInnoExtension against a stub ExtensionAPI and
 * prints registered tools/commands. Verifies jiti loading of rpiv-todo and
 * pi-web-access, and that no duplicate tool names are registered.
 *
 * Usage: npx tsx scripts/smoke-plugins.ts
 */
import { createInnoExtension } from "../apps/learning-agent/src/agent/inno-extension.js";
import { loadConfig } from "../apps/learning-agent/src/config.js";
import { resolveRuntimePaths, applyRuntimeEnvironment } from "../apps/learning-agent/src/runtime.js";

const paths = resolveRuntimePaths({ home: "./runtime", workspace: "./workspace" });
applyRuntimeEnvironment(paths);
const config = loadConfig(paths.configPath);
const holder = { current: config };

const tools: string[] = [];
const commands: string[] = [];
const events: string[] = [];

const stubPi = {
	registerTool: (t: { name: string }) => { tools.push(t.name); },
	registerCommand: (name: string) => { commands.push(name); },
	registerProvider: () => {},
	registerShortcut: () => {},
	registerFlag: () => {},
	registerMessageRenderer: () => {},
	registerMarkdownTransformer: () => {},
	registerEntryRenderer: () => {},
	on: (event: string) => { events.push(event); },
	getFlag: () => undefined,
};

const factory = createInnoExtension(holder, paths);
await factory(stubPi as never);

const dupes = tools.filter((n, i) => tools.indexOf(n) !== i);
console.log("TOOLS (%d): %s", tools.length, tools.join(", "));
console.log("COMMANDS (%d): %s", commands.length, commands.join(", "));
console.log("EVENTS:", [...new Set(events)].join(", "));
if (dupes.length) {
	console.error("DUPLICATE TOOLS:", dupes.join(", "));
	process.exit(1);
}
for (const expected of ["todo", "fetch_content", "get_search_content", "web_search", "web_research", "source_check", "ask_user_question"]) {
	if (!tools.includes(expected)) {
		console.error("MISSING TOOL:", expected);
		process.exit(1);
	}
}
console.log("OK: no duplicate tool names; expected plugin tools present (coexistence: web_search + web_research)");
process.exit(0);
