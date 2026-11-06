import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	MAGPIE_LOCAL_CLIENT_ID,
	MagpieError,
	fetchMagpieCatalog,
	magpieModelBaseUrl,
	normalizeMagpieGatewayUrl,
	parseMagpieModelList,
	probeMagpieGateway,
} from "./magpie.js";

/**
 * E3.1 gateway contract. The fake server speaks Magpie's documented shape so
 * the parser, identity check and error mapping are exercised over real HTTP.
 */

let server: Server;
let baseUrl = "";
let handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
let lastAuthorization = "";

beforeAll(async () => {
	server = createServer((req, res) => {
		lastAuthorization = String(req.headers.authorization ?? "");
		handler(req, res);
	});
	await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
	const address = server.address() as { port: number };
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((yes) => server.close(() => yes()));
});

beforeEach(() => {
	lastAuthorization = "";
	handler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ name: "magpie", version: "0.1.2626" }));
	};
});

function jsonHandler(routes: Record<string, () => unknown>): void {
	handler = (req, res) => {
		const route = routes[req.url ?? ""];
		if (!route) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(route()));
	};
}

describe("normalizeMagpieGatewayUrl", () => {
	it("accepts loopback, LAN and the /v1 base while returning the root", async () => {
		expect(await normalizeMagpieGatewayUrl("http://127.0.0.1:3425")).toBe("http://127.0.0.1:3425");
		expect(await normalizeMagpieGatewayUrl("http://127.0.0.1:3425/v1/")).toBe("http://127.0.0.1:3425");
		expect(await normalizeMagpieGatewayUrl("http://localhost:3425/v1")).toBe("http://localhost:3425");
		expect(await normalizeMagpieGatewayUrl("http://192.168.1.20:3425")).toBe("http://192.168.1.20:3425");
		// A bare host uses Magpie's documented default port.
		expect(await normalizeMagpieGatewayUrl("http://127.0.0.1")).toBe("http://127.0.0.1:3425");
	});

	it("refuses public, link-local, non-http and credential-bearing addresses", async () => {
		await expect(normalizeMagpieGatewayUrl("http://8.8.8.8:3425")).rejects.toMatchObject({ code: "unsafe_url" });
		await expect(normalizeMagpieGatewayUrl("http://169.254.169.254/latest")).rejects.toMatchObject({ code: "invalid_url" });
		await expect(normalizeMagpieGatewayUrl("http://169.254.169.254:3425")).rejects.toMatchObject({ code: "unsafe_url" });
		await expect(normalizeMagpieGatewayUrl("ftp://127.0.0.1:3425")).rejects.toMatchObject({ code: "invalid_url" });
		await expect(normalizeMagpieGatewayUrl("http://user:pass@127.0.0.1:3425")).rejects.toMatchObject({ code: "invalid_url" });
		await expect(normalizeMagpieGatewayUrl("http://127.0.0.1:3425/proxy")).rejects.toMatchObject({ code: "invalid_url" });
		await expect(normalizeMagpieGatewayUrl("   ")).rejects.toBeInstanceOf(MagpieError);
	});
});

describe("probeMagpieGateway", () => {
	it("accepts only name=magpie, not just HTTP 200", async () => {
		const result = await probeMagpieGateway({ gatewayUrl: baseUrl });
		expect(result).toEqual({ gateway: { name: "magpie", version: "0.1.2626" }, gatewayUrl: baseUrl });
	});

	it("rejects a different service on the same port", async () => {
		handler = (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ name: "other-gateway" }));
		};
		await expect(probeMagpieGateway({ gatewayUrl: baseUrl })).rejects.toMatchObject({ code: "not_magpie" });
	});

	it("maps 401/403, 404, 429, 5xx and redirects to explicit errors", async () => {
		for (const [status, code] of [[401, "unauthorized"], [403, "unauthorized"], [404, "not_found"], [429, "rate_limited"], [503, "upstream_error"]] as const) {
			handler = (_req, res) => { res.writeHead(status); res.end("no"); };
			await expect(probeMagpieGateway({ gatewayUrl: baseUrl })).rejects.toMatchObject({ code });
		}
		handler = (_req, res) => { res.writeHead(302, { Location: "http://127.0.0.1:1/" }); res.end(); };
		await expect(probeMagpieGateway({ gatewayUrl: baseUrl })).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("uses the local client id when no gateway key is given", async () => {
		await probeMagpieGateway({ gatewayUrl: baseUrl });
		expect(lastAuthorization).toBe(`Bearer ${MAGPIE_LOCAL_CLIENT_ID}`);
	});

	it("sends a supplied gateway key unchanged", async () => {
		await probeMagpieGateway({ gatewayUrl: baseUrl, gatewayKey: "gw-secret" });
		expect(lastAuthorization).toBe("Bearer gw-secret");
	});

	it("reports an unreachable gateway without leaking internals", async () => {
		await expect(probeMagpieGateway({ gatewayUrl: "http://127.0.0.1:1", timeoutMs: 800 }))
			.rejects.toMatchObject({ code: "unreachable", status: 502 });
	});
});

describe("model catalog", () => {
	it("keeps ids exactly, reads real metadata and skips non-chat entries", () => {
		const { models, warnings } = parseMagpieModelList({
			object: "list",
			data: [
				{
					id: "openai/gpt-5.1",
					display_name: "GPT-5.1",
					owned_by: "openai",
					reasoning: true,
					supported_reasoning_levels: [{ effort: "low" }],
					context_window: 400_000,
					max_output_tokens: 128_000,
					modalities: ["text", "image"],
				},
				{ id: "routing/smart", display_name: "Smart route" },
				{ id: "image/only", kind: "image" },
				{ id: "openai/gpt-5.1", display_name: "duplicate" },
				{ id: "" },
				null,
			],
		});
		expect(models.map((model) => model.id)).toEqual(["openai/gpt-5.1", "routing/smart"]);
		expect(models[0]).toMatchObject({
			displayName: "GPT-5.1",
			ownedBy: "openai",
			reasoning: true,
			contextWindow: 400_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			confirmed: { contextWindow: true, maxTokens: true, reasoning: true, input: true },
		});
		// Missing fields stay unknown; nothing is invented.
		expect(models[1].reasoning).toBeUndefined();
		expect(models[1].contextWindow).toBeUndefined();
		expect(models[1].confirmed).toEqual({ contextWindow: false, maxTokens: false, reasoning: false, input: false });
		expect(warnings.some((warning) => warning.includes("保守默认值"))).toBe(true);
	});

	it("accepts a bare array and the legacy {models} shape", () => {
		expect(parseMagpieModelList([{ id: "a/b" }]).models[0].id).toBe("a/b");
		expect(parseMagpieModelList({ models: [{ id: "c/d" }] }).models[0].id).toBe("c/d");
		// Magpie's current shape: modalities is an object, not an array.
		const objectModalities = parseMagpieModelList({ data: [{ id: "e/f", modalities: { input: ["text", "image"] } }] }).models[0];
		expect(objectModalities.input).toEqual(["text", "image"]);
		expect(objectModalities.confirmed.input).toBe(true);
	});

	it("returns an empty catalog with a warning instead of throwing", () => {
		const { models, warnings } = parseMagpieModelList({ data: [] });
		expect(models).toEqual([]);
		expect(warnings[0]).toContain("没有启用的聊天模型");
	});

	it("rejects a malformed list", () => {
		expect(() => parseMagpieModelList({ nope: true })).toThrow(MagpieError);
		expect(() => parseMagpieModelList("text")).toThrow(MagpieError);
	});

	it("fetches hello + models and preserves a routing-group id", async () => {
		jsonHandler({
			"/api/hello": () => ({ name: "magpie", version: "0.1.2626" }),
			"/v1/models": () => ({ data: [{ id: "routing/study", display_name: "Study", context_window: 128_000 }] }),
		});
		const catalog = await fetchMagpieCatalog({ gatewayUrl: `${baseUrl}/v1` });
		expect(catalog.gatewayUrl).toBe(baseUrl);
		expect(catalog.models[0].id).toBe("routing/study");
		expect(catalog.models[0].maxTokens).toBeUndefined();
	});

	it("fails the catalog if the hello identity is wrong, before parsing models", async () => {
		jsonHandler({
			"/api/hello": () => ({ name: "not-magpie" }),
			"/v1/models": () => ({ data: [{ id: "x/y" }] }),
		});
		await expect(fetchMagpieCatalog({ gatewayUrl: baseUrl })).rejects.toMatchObject({ code: "not_magpie" });
	});
});

describe("magpieModelBaseUrl", () => {
	it("gives OpenAI protocols the /v1 base and Anthropic the bare root", () => {
		// The Anthropic SDK appends /v1/messages; a /v1 base would become
		// /v1/v1/messages, which the gateway answers with 404.
		expect(magpieModelBaseUrl("http://127.0.0.1:3425", "anthropic-messages")).toBe("http://127.0.0.1:3425");
		expect(magpieModelBaseUrl("http://127.0.0.1:3425/v1", "anthropic-messages")).toBe("http://127.0.0.1:3425");
		expect(magpieModelBaseUrl("http://127.0.0.1:3425", "openai-completions")).toBe("http://127.0.0.1:3425/v1");
		expect(magpieModelBaseUrl("http://127.0.0.1:3425/", "openai-responses")).toBe("http://127.0.0.1:3425/v1");
	});
});
