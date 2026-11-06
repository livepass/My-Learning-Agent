import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeConfig, normalizeModelConfig, type InnoConfig } from "../config.js";
import { syncProvidersForSubagents } from "./provider-sync.js";

/**
 * E3.1: subagent child processes read PI's models.json. Magpie must appear
 * there as one ordinary provider, including its per-model protocol choice,
 * without dropping hand-added providers.
 */

let dir: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "e31-provider-sync-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	await mkdir(dir, { recursive: true });
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(dir, { recursive: true, force: true });
});

const config: InnoConfig = normalizeConfig({
	defaultProvider: "magpie",
	defaultModel: "bailian/qwen3.8-flash",
	providers: {
		deepseek: {
			baseUrl: "https://api.deepseek.com/v1",
			apiKey: "sk-direct",
			models: [normalizeModelConfig({ id: "deepseek-chat", name: "DeepSeek" })],
		},
		magpie: {
			baseUrl: "http://127.0.0.1:3425/v1",
			apiKey: "magpie-my-learning-agent",
			api: "openai-completions",
			models: [
				normalizeModelConfig({ id: "bailian/qwen3.8-flash", name: "Qwen", contextWindow: 131_072 }),
				// Magpie serves Anthropic Messages at the gateway root, not /v1.
				normalizeModelConfig({ id: "routing/study", name: "Study", api: "anthropic-messages", baseUrl: "http://127.0.0.1:3425" }),
			],
		},
	},
});

describe("syncProvidersForSubagents", () => {
	it("writes Magpie and the direct provider, keeping per-model protocols", async () => {
		await writeFile(join(dir, "models.json"), JSON.stringify({
			providers: {
				manual: { baseUrl: "http://localhost:9/v1", apiKey: "manual", models: [{ id: "m" }] },
			},
		}));

		syncProvidersForSubagents(config);

		const models = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
		expect(models.providers.manual.models[0].id).toBe("m");
		expect(models.providers.deepseek.apiKey).toBe("sk-direct");
		expect(models.providers.magpie).toMatchObject({
			baseUrl: "http://127.0.0.1:3425/v1",
			apiKey: "magpie-my-learning-agent",
			api: "openai-completions",
		});
		expect(models.providers.magpie.models.map((model: { id: string }) => model.id))
			.toEqual(["bailian/qwen3.8-flash", "routing/study"]);
		expect(models.providers.magpie.models[1].api).toBe("anthropic-messages");
		expect(models.providers.magpie.models[1].baseUrl).toBe("http://127.0.0.1:3425");

		const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
		expect(settings).toMatchObject({ defaultProvider: "magpie", defaultModel: "bailian/qwen3.8-flash" });
	});

	it("does not invent api or baseUrl fields when the model uses the provider defaults", async () => {
		syncProvidersForSubagents(config);
		const models = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
		expect(models.providers.deepseek.models[0]).not.toHaveProperty("api");
		expect(models.providers.deepseek.models[0]).not.toHaveProperty("baseUrl");
		expect(models.providers.magpie.models[0]).not.toHaveProperty("api");
		expect(models.providers.magpie.models[0]).not.toHaveProperty("baseUrl");
	});
});
