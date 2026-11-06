import { lookup as dnsLookup } from "node:dns/promises";
import { logger } from "../logger.js";
import { MAGPIE_LOCAL_CLIENT_ID } from "../shared/magpie.js";

/**
 * Magpie local-gateway integration (E3.1).
 *
 * The learning agent never signs in to ZCode/Trae/Codex. Magpie owns those
 * accounts and presents one local catalog; we only read the gateway's public
 * contract (`GET /api/hello`, `GET /v1/models`) and save its models as one
 * ordinary provider entry, so direct API providers keep working unchanged.
 *
 * Safety: these endpoints take a user-supplied URL and fetch it server-side.
 * Only loopback / LAN destinations are accepted and redirects are refused, so
 * the settings endpoint cannot be used as a general-purpose request proxy.
 */

export {
	MAGPIE_PROVIDER_ID,
	MAGPIE_DEFAULT_GATEWAY_URL,
	MAGPIE_LOCAL_CLIENT_ID,
	magpieModelBaseUrl,
} from "../shared/magpie.js";

const HEALTH_TIMEOUT_MS = 4_000;
const MODELS_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_PORT = "3425";

export type MagpieErrorCode =
	| "invalid_url"
	| "unsafe_url"
	| "unreachable"
	| "not_magpie"
	| "unauthorized"
	| "not_found"
	| "rate_limited"
	| "upstream_error"
	| "invalid_response";

export class MagpieError extends Error {
	constructor(
		public readonly code: MagpieErrorCode,
		message: string,
		public readonly status: 400 | 502,
	) {
		super(message);
		this.name = "MagpieError";
	}
}

export interface MagpieHealth {
	name: string;
	version?: string;
}

export interface MagpieModelMetadata {
	/** Exact id from the gateway: `provider/model` or a routing-group name. */
	id: string;
	displayName: string;
	ownedBy?: string;
	/** Only present when the gateway actually reported it. */
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: Array<"text" | "image">;
	/** Which fields came from the gateway rather than a conservative default. */
	confirmed: {
		contextWindow: boolean;
		maxTokens: boolean;
		reasoning: boolean;
		input: boolean;
	};
}

export interface MagpieCatalog {
	gateway: MagpieHealth;
	/** The normalized gateway root (no trailing slash, no /v1). */
	gatewayUrl: string;
	models: MagpieModelMetadata[];
	warnings: string[];
}

export interface MagpieRequestInput {
	gatewayUrl: string;
	/** Empty → MAGPIE_LOCAL_CLIENT_ID (same-machine local call). */
	gatewayKey?: string;
	/** Test seam; production uses the documented timeouts. */
	timeoutMs?: number;
}

function isIpLiteral(hostname: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	// Loopback, RFC1918, CGNAT. Link-local (169.254/16) and everything else is
	// refused: the cloud metadata endpoint is the classic SSRF target.
	return a === 127
		|| a === 10
		|| (a === 192 && b === 168)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 100 && b >= 64 && b <= 127);
}

function isPrivateAddress(address: string): boolean {
	const normalized = address.trim().toLowerCase().split("%")[0];
	if (normalized.includes(".")) {
		// IPv4, or an IPv4-mapped IPv6 literal such as ::ffff:127.0.0.1.
		const tail = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
		return isPrivateIpv4(tail);
	}
	if (normalized === "::1") return true;
	// Unique local addresses fc00::/7. Link-local fe80::/10 stays blocked.
	return /^f[cd][0-9a-f]{2}:/.test(normalized) || normalized.startsWith("fd");
}

/**
 * Validate and normalize a gateway root. Accepts `http://127.0.0.1:3425` and
 * the OpenAI base `http://127.0.0.1:3425/v1`, and returns the root. Only
 * loopback / private destinations are allowed.
 */
export async function normalizeMagpieGatewayUrl(raw: string): Promise<string> {
	const trimmed = raw?.trim() ?? "";
	if (!trimmed) {
		throw new MagpieError("invalid_url", "请填写 Magpie 网关地址", 400);
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new MagpieError("invalid_url", "网关地址不是有效的 URL", 400);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new MagpieError("invalid_url", "网关地址必须以 http:// 或 https:// 开头", 400);
	}
	if (url.username || url.password) {
		throw new MagpieError("invalid_url", "网关地址不能包含用户名或密码", 400);
	}
	const path = url.pathname.replace(/\/+$/, "");
	if (path !== "" && path.toLowerCase() !== "/v1") {
		throw new MagpieError("invalid_url", "网关地址只填写协议、主机和端口（可带 /v1）", 400);
	}
	if (!url.port) url.port = DEFAULT_PORT;

	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!hostname) throw new MagpieError("invalid_url", "网关地址缺少主机", 400);

	let addresses: string[];
	if (isIpLiteral(hostname)) {
		if (!isPrivateAddress(hostname)) {
			throw new MagpieError("unsafe_url", "只允许连接本机或局域网的 Magpie 网关", 400);
		}
		addresses = [hostname];
	} else if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "host.docker.internal" || hostname === "gateway.docker.internal") {
		// Docker's host alias does not necessarily resolve on the host itself;
		// the request below fails naturally when it is absent.
		addresses = [];
	} else {
		try {
			const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
			addresses = resolved.map((entry) => entry.address);
		} catch {
			throw new MagpieError("unreachable", "无法解析网关地址，请检查主机名或网络", 400);
		}
		if (addresses.length === 0) {
			throw new MagpieError("unreachable", "无法解析网关地址，请检查主机名或网络", 400);
		}
		if (addresses.some((address) => !isPrivateAddress(address))) {
			throw new MagpieError("unsafe_url", "只允许连接本机或局域网的 Magpie 网关", 400);
		}
	}

	url.pathname = "";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function resolveGatewayKey(key: string | undefined): string {
	const trimmed = key?.trim() ?? "";
	return trimmed || MAGPIE_LOCAL_CLIENT_ID;
}

async function readBodyLimited(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				throw new MagpieError("invalid_response", "网关返回内容过大", 502);
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	return text + decoder.decode();
}

async function fetchGatewayJson(url: string, key: string, timeoutMs: number): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${resolveGatewayKey(key)}`,
				accept: "application/json",
			},
			// Never follow a redirect: it would escape the validated destination.
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		logger.warn({ url, err }, "magpie request failed");
		throw new MagpieError("unreachable", "无法连接 Magpie 网关，请确认它正在运行", 502);
	}

	if (response.status >= 300 && response.status < 400) {
		throw new MagpieError("invalid_response", "网关返回了重定向，已拒绝跟随", 502);
	}
	if (response.status === 401 || response.status === 403) {
		throw new MagpieError("unauthorized", "网关密钥无效或没有权限（401/403）", 502);
	}
	if (response.status === 404) {
		throw new MagpieError("not_found", "网关未提供该接口（404），请确认 Magpie 版本", 502);
	}
	if (response.status === 429) {
		throw new MagpieError("rate_limited", "网关请求过多（429），请稍后重试", 502);
	}
	if (response.status >= 500) {
		throw new MagpieError("upstream_error", `Magpie 网关内部错误（HTTP ${response.status}）`, 502);
	}
	if (!response.ok) {
		throw new MagpieError("upstream_error", `Magpie 网关返回错误（HTTP ${response.status}）`, 502);
	}

	const text = await readBodyLimited(response);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new MagpieError("invalid_response", "网关返回的不是有效 JSON", 502);
	}
}

function parseHealth(body: unknown): MagpieHealth {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new MagpieError("invalid_response", "网关健康检查返回格式不正确", 502);
	}
	const record = body as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name.trim() : "";
	if (name !== "magpie") {
		throw new MagpieError("not_magpie", `该地址不是 Magpie 网关（name=${name || "缺失"}）`, 502);
	}
	return {
		name,
		...(typeof record.version === "string" && record.version.trim() ? { version: record.version.trim() } : {}),
	};
}

/** Health check that validates `name === "magpie"`, not just HTTP 200. */
export async function probeMagpieGateway(input: MagpieRequestInput): Promise<{ gateway: MagpieHealth; gatewayUrl: string }> {
	const gatewayUrl = await normalizeMagpieGatewayUrl(input.gatewayUrl);
	const body = await fetchGatewayJson(`${gatewayUrl}/api/hello`, input.gatewayKey ?? "", input.timeoutMs ?? HEALTH_TIMEOUT_MS);
	return { gateway: parseHealth(body), gatewayUrl };
}

function positiveInteger(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function parseModelEntry(entry: unknown): MagpieModelMetadata | null {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
	const record = entry as Record<string, unknown>;
	if (typeof record.id !== "string" || !record.id.trim()) return null;
	// /v1/models defaults to chat models; skip anything explicitly non-chat.
	if (typeof record.kind === "string" && record.kind.trim() && record.kind.trim() !== "chat") return null;

	// Magpie currently returns `modalities: { input: ["text", "image"] }`;
	// older/compatible gateways return a plain array. Accept both, invent neither.
	const modalityList = Array.isArray(record.modalities)
		? record.modalities
		: record.modalities && typeof record.modalities === "object"
			&& Array.isArray((record.modalities as { input?: unknown }).input)
			? (record.modalities as { input: unknown[] }).input
			: undefined;
	const modalities = modalityList
		? modalityList.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
		: undefined;
	const levels = Array.isArray(record.supported_reasoning_levels)
		? record.supported_reasoning_levels
		: Array.isArray(record.reasoning_levels) ? record.reasoning_levels : undefined;
	const reasoning = typeof record.reasoning === "boolean"
		? record.reasoning
		: levels && levels.length > 0 ? true : undefined;
	const contextWindow = positiveInteger(record.context_window ?? record.context_length ?? record.contextWindow);
	const maxTokens = positiveInteger(record.max_output_tokens ?? record.maxTokens);
	const supportsImage = modalities?.some((value) => value === "image" || value === "vision");

	return {
		id: record.id.trim(),
		displayName: (typeof record.display_name === "string" && record.display_name.trim())
			|| (typeof record.name === "string" && record.name.trim())
			|| record.id.trim(),
		...(typeof record.owned_by === "string" && record.owned_by.trim() ? { ownedBy: record.owned_by.trim() } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(modalities ? { input: supportsImage ? ["text", "image"] : ["text"] } : {}),
		confirmed: {
			contextWindow: contextWindow !== undefined,
			maxTokens: maxTokens !== undefined,
			reasoning: reasoning !== undefined,
			input: modalities !== undefined,
		},
	};
}

/** Pure parser for the catalog response (exported for tests). */
export function parseMagpieModelList(body: unknown): { models: MagpieModelMetadata[]; warnings: string[] } {
	const raw = Array.isArray(body)
		? body
		: body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
			? (body as { data: unknown[] }).data
			: body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
				? (body as { models: unknown[] }).models
				: null;
	if (!raw) {
		throw new MagpieError("invalid_response", "网关返回的模型列表格式不正确", 502);
	}

	const seen = new Set<string>();
	const models: MagpieModelMetadata[] = [];
	for (const entry of raw) {
		const model = parseModelEntry(entry);
		// Duplicate ids would make the saved provider ambiguous; keep the first.
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}

	const warnings: string[] = [];
	if (models.length === 0) {
		warnings.push("网关当前没有启用的聊天模型，请在 Magpie 中启用后再刷新。");
	} else if (models.some((model) => !model.confirmed.contextWindow || !model.confirmed.maxTokens)) {
		warnings.push("部分模型未提供上下文或最大输出信息，保存时会使用保守默认值，且不会标记为已确认。");
	}
	return { models, warnings };
}

/** Full catalog: hello first (identity), then the model list. */
export async function fetchMagpieCatalog(input: MagpieRequestInput): Promise<MagpieCatalog> {
	const { gateway, gatewayUrl } = await probeMagpieGateway(input);
	const body = await fetchGatewayJson(`${gatewayUrl}/v1/models`, input.gatewayKey ?? "", input.timeoutMs ?? MODELS_TIMEOUT_MS);
	const { models, warnings } = parseMagpieModelList(body);
	return { gateway, gatewayUrl, models, warnings };
}

