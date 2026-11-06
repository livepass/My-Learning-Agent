import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig, type InnoConfig } from "../../config.js";
import type { RuntimePaths } from "../../runtime.js";
import { handleSettingsRoutes } from "./settings.js";

vi.mock("../../agent/pi-runner.js", () => ({
	getSessionIfInitialized: () => null,
	refreshConfiguredProviders: vi.fn(),
	switchModel: vi.fn(),
	getAvailableModels: vi.fn(() => []),
	syncConfig: vi.fn(),
}));

/**
 * E3.1 route contract: the Magpie probe runs server-side, saving reuses the
 * ordinary provider endpoint, and a failed gateway never disturbs the direct
 * API provider that is already configured.
 */

let gateway: Server;
let gatewayUrl = "";
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let lastAuth = "";

beforeAll(async () => {
	gateway = createServer((req, res) => {
		lastAuth = String(req.headers.authorization ?? "");
		handler(req, res);
	});
	await new Promise<void>((yes) => gateway.listen(0, "127.0.0.1", yes));
	gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});

afterAll(async () => {
	gateway.closeAllConnections();
	await new Promise<void>((yes) => gateway.close(() => yes()));
});

beforeEach(() => {
	lastAuth = "";
	handler = (req, res) => {
		if (req.url === "/api/hello") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ name: "magpie", version: "0.1.2626" }));
			return;
		}
		if (req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: [
					{ id: "bailian/qwen3.8-flash", display_name: "Qwen", owned_by: "bailian", context_window: 131_072 },
					{ id: "routing/study", display_name: "Study route" },
				],
			}));
			return;
		}
		res.writeHead(404);
		res.end();
	};
});

let dir: string;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

function responseFixture() {
	let status = 0;
	let body = "";
	const res = {
		destroyed: false,
		writableEnded: false,
		writeHead: (code: number) => { status = code; },
		end: (chunk: string) => { body = chunk; },
	} as unknown as ServerResponse;
	return { res, get status() { return status; }, get body() { return body ? JSON.parse(body) : null; } };
}

function request(body: unknown): IncomingMessage {
	const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
	req.headers = {};
	return req;
}

async function setup(): Promise<{ ctx: Parameters<typeof handleSettingsRoutes>[4]; path: string; getConfig: () => InnoConfig }> {
	dir = await mkdtemp(join(tmpdir(), "e31-settings-"));
	const configPath = join(dir, "config.json");
	const initial: InnoConfig = {
		defaultProvider: "deepseek",
		defaultModel: "deepseek-chat",
		providers: {
			deepseek: {
				baseUrl: "https://api.deepseek.com/v1",
				apiKey: "sk-direct",
				api: "openai-completions",
				models: [{ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 8_192 }],
			},
		},
	};
	saveConfig(configPath, initial);
	let config = loadConfig(configPath);
	const ctx = {
		paths: { configPath } as RuntimePaths,
		getConfig: () => config,
		setConfig: (next: InnoConfig) => { config = next; },
	} as Parameters<typeof handleSettingsRoutes>[4];
	return { ctx, path: configPath, getConfig: () => config };
}

async function call(
	ctx: Parameters<typeof handleSettingsRoutes>[4],
	method: string,
	url: string,
	body: unknown,
) {
	const fixture = responseFixture();
	const handled = await handleSettingsRoutes(request(body), fixture.res, method, url, ctx);
	return { handled, status: fixture.status, body: fixture.body };
}

describe("Magpie settings routes", () => {
	it("checks identity and models server-side, using the stored key when none is typed", async () => {
		const { ctx, path } = await setup();
		saveConfig(path, (() => {
			const current = loadConfig(path);
			current.providers.magpie = {
				baseUrl: `${gatewayUrl}/v1`, apiKey: "gw-secret", api: "openai-completions",
				models: [{ id: "bailian/qwen3.8-flash", name: "Qwen", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 8_192 }],
			};
			return current;
		})());
		ctx.setConfig(loadConfig(path));

		const health = await call(ctx, "POST", "/api/settings/magpie/health", { gatewayUrl });
		expect(health.status).toBe(200);
		expect(health.body).toMatchObject({ ok: true, gateway: { name: "magpie", version: "0.1.2626" } });
		expect(lastAuth).toBe("Bearer gw-secret");

		const models = await call(ctx, "POST", "/api/settings/magpie/models", { gatewayUrl });
		expect(models.status).toBe(200);
		expect(models.body.models.map((model: { id: string }) => model.id)).toEqual(["bailian/qwen3.8-flash", "routing/study"]);
		expect(models.body.models[1].confirmed.contextWindow).toBe(false);
	});

	it("maps a wrong service and an offline gateway to explicit errors", async () => {
		const { ctx } = await setup();
		handler = (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ name: "not-magpie" }));
		};
		const wrong = await call(ctx, "POST", "/api/settings/magpie/health", { gatewayUrl });
		expect(wrong.status).toBe(502);
		expect(wrong.body.code).toBe("not_magpie");

		const offline = await call(ctx, "POST", "/api/settings/magpie/health", { gatewayUrl: "http://127.0.0.1:1" });
		expect(offline.status).toBe(502);
		expect(offline.body.code).toBe("unreachable");
	});

	it("stores the documented local client id when a first save leaves the key blank", async () => {
		const { ctx, path } = await setup();
		const result = await call(ctx, "PUT", "/api/settings/providers", {
			providerId: "magpie",
			baseUrl: `${gatewayUrl}/v1`,
			apiKey: "",
			api: "openai-completions",
			preserveApiKey: true,
			models: [{ id: "bailian/qwen3.8-flash", name: "Qwen", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 8_192 }],
		});
		expect(result.status).toBe(200);
		// The runtime would otherwise fall back to its generic `local` key.
		expect(loadConfig(path).providers.magpie.apiKey).toBe("magpie-my-learning-agent");
	});

	it("saves Magpie beside the direct provider, masks the key and preserves it on re-save", async () => {
		const { ctx, path } = await setup();
		const first = await call(ctx, "PUT", "/api/settings/providers", {
			providerId: "magpie",
			baseUrl: `${gatewayUrl}/v1`,
			apiKey: "gw-secret",
			api: "openai-completions",
			models: [{ id: "bailian/qwen3.8-flash", name: "Qwen", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 8_192 }],
		});
		expect(first.status).toBe(200);
		expect(first.body.providers.magpie.apiKey).toMatch(/^\*\*\*\*/);
		expect(first.body.providers.deepseek.apiKey).toMatch(/^\*\*\*\*/);
		expect(loadConfig(path).providers.deepseek.apiKey).toBe("sk-direct");
		expect(loadConfig(path).providers.magpie.apiKey).toBe("gw-secret");

		const second = await call(ctx, "PUT", "/api/settings/providers", {
			providerId: "magpie",
			baseUrl: `${gatewayUrl}/v1`,
			apiKey: "",
			api: "openai-completions",
			preserveApiKey: true,
			models: [
				{ id: "bailian/qwen3.8-flash", name: "Qwen", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 8_192 },
				{ id: "routing/study", name: "Study", reasoning: true, api: "anthropic-messages", baseUrl: gatewayUrl, input: ["text"], contextWindow: 200_000, maxTokens: 16_384 },
			],
		});
		expect(second.status).toBe(200);
		const saved = loadConfig(path);
		expect(saved.providers.magpie.apiKey).toBe("gw-secret");
		expect(saved.providers.magpie.models.map((model) => model.id)).toEqual(["bailian/qwen3.8-flash", "routing/study"]);
		expect(saved.providers.magpie.models[1].api).toBe("anthropic-messages");
		// The per-model base URL survives the write: Anthropic needs the root.
		expect(saved.providers.magpie.models[1].baseUrl).toBe(gatewayUrl);
		// A model without an override inherits the provider base URL.
		expect(saved.providers.magpie.models[0].baseUrl).toBeUndefined();
		expect(saved.providers.deepseek.apiKey).toBe("sk-direct");
	});

	it("refuses a public Magpie URL and leaves the file untouched", async () => {
		const { ctx, path } = await setup();
		const before = await readFile(path, "utf8");
		const result = await call(ctx, "PUT", "/api/settings/providers", {
			providerId: "magpie",
			baseUrl: "http://8.8.8.8:3425/v1",
			apiKey: "x",
			api: "openai-completions",
			models: [{ id: "a/b", name: "A", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
		});
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("unsafe_url");
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("switches the default between direct API and Magpie and survives a reload", async () => {
		const { ctx, path } = await setup();
		await call(ctx, "PUT", "/api/settings/providers", {
			providerId: "magpie",
			baseUrl: `${gatewayUrl}/v1`,
			apiKey: "gw-secret",
			api: "openai-completions",
			models: [{ id: "bailian/qwen3.8-flash", name: "Qwen", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 8_192 }],
		});
		const switched = await call(ctx, "POST", "/api/settings/model", { provider: "magpie", model: "bailian/qwen3.8-flash" });
		expect(switched.status).toBe(200);
		expect(switched.body).toMatchObject({ defaultProvider: "magpie", defaultModel: "bailian/qwen3.8-flash" });

		const reloaded = loadConfig(path);
		expect(reloaded.defaultProvider).toBe("magpie");
		expect(reloaded.providers.deepseek.models[0].id).toBe("deepseek-chat");

		const back = await call(ctx, "POST", "/api/settings/model", { provider: "deepseek", model: "deepseek-chat" });
		expect(back.status).toBe(200);
		expect(loadConfig(path).defaultProvider).toBe("deepseek");
		expect(loadConfig(path).providers.magpie).toBeTruthy();
	});

	it("deletes a non-default Magpie model without touching the direct provider; the default needs a switch first", async () => {
		const { ctx, path } = await setup();
		await call(ctx, "PUT", "/api/settings/providers", {
			providerId: "magpie",
			baseUrl: `${gatewayUrl}/v1`,
			apiKey: "gw-secret",
			api: "openai-completions",
			models: [
				{ id: "a/one", name: "One", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
				{ id: "b/two", name: "Two", reasoning: false, api: "openai-responses", input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
			],
		});
		await call(ctx, "POST", "/api/settings/model", { provider: "magpie", model: "a/one" });

		const removeDefault = await call(ctx, "DELETE", "/api/settings/providers/magpie/models/a%2Fone", {});
		expect(removeDefault.status).toBe(400);

		const removed = await call(ctx, "DELETE", "/api/settings/providers/magpie/models/b%2Ftwo", {});
		expect(removed.status).toBe(200);
		const saved = loadConfig(path);
		expect(saved.providers.magpie.models.map((model) => model.id)).toEqual(["a/one"]);
		expect(saved.providers.deepseek.models[0].id).toBe("deepseek-chat");
	});

	it("a gateway failure does not modify the direct API configuration", async () => {
		const { ctx, path } = await setup();
		const before = await readFile(path, "utf8");
		handler = (_req, res) => { res.writeHead(503); res.end("down"); };
		const result = await call(ctx, "POST", "/api/settings/magpie/models", { gatewayUrl });
		expect(result.status).toBe(502);
		expect(await readFile(path, "utf8")).toBe(before);
		expect(loadConfig(path).providers.deepseek.apiKey).toBe("sk-direct");
	});
});

/**
 * E3.1 UI v2: the current-model status card may only claim "ready" after a
 * real completion through the active model. The route reports the side
 * channel's outcome verbatim and never touches the stored config.
 */
describe("current model verification", () => {
	it("reports the real outcome and leaves the config untouched", async () => {
		const { ctx, path } = await setup();
		const before = await readFile(path, "utf8");
		const verify = vi.fn(async () => ({ status: "ok" as const, text: "pong", model: { provider_id: "deepseek", model_id: "deepseek-chat", model_version: null, version_source: "unavailable" as const } }));
		ctx.verifyModel = verify;

		const result = await call(ctx, "POST", "/api/settings/model/verify", {});
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ status: "ok", defaultProvider: "deepseek", defaultModel: "deepseek-chat" });
		expect(verify).toHaveBeenCalledOnce();
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("reports not_ready rather than success when no runtime exists", async () => {
		const { ctx } = await setup();
		const result = await call(ctx, "POST", "/api/settings/model/verify", {});
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ status: "not_ready", reason: "agent_not_initialized" });
	});

	it("turns a runtime failure into an error outcome, never ok", async () => {
		const { ctx } = await setup();
		ctx.verifyModel = async () => { throw new Error("startup failed"); };
		const result = await call(ctx, "POST", "/api/settings/model/verify", {});
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ status: "error", message: "startup failed" });
	});
});
