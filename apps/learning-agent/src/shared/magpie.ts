/**
 * Magpie gateway constants shared by the server and the web UI.
 *
 * Kept free of node-only imports so the browser bundle can use it: the
 * provider id and default URL must be identical on both sides, otherwise a
 * saved provider and the runtime registration drift apart.
 */

export const MAGPIE_PROVIDER_ID = "magpie";
export const MAGPIE_DEFAULT_GATEWAY_URL = "http://127.0.0.1:3425";
/** Local calls need no secret; this id is what Magpie counts the calls under. */
export const MAGPIE_LOCAL_CLIENT_ID = "magpie-my-learning-agent";

export type MagpieProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

/**
 * Base URL a model must use for a given protocol.
 *
 * The OpenAI SDKs append `/chat/completions` and `/responses` to the base
 * URL, and Magpie serves those under `/v1`. The Anthropic SDK appends
 * `/v1/messages`, and Magpie serves that at `<root>/v1/messages`, so an
 * Anthropic model needs the bare gateway root — a `/v1` base would produce
 * `<root>/v1/v1/messages` and 404.
 */
export function magpieModelBaseUrl(gatewayRoot: string, api: string): string {
	const root = gatewayRoot.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
	return api === "anthropic-messages" ? root : `${root}/v1`;
}
