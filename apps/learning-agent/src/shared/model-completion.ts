import type { LearningModelIdentity } from "../memory/learner/types.js";

/**
 * Side-channel model call contract.
 *
 * A side channel is an independent request that is not part of the chat turn:
 * it never touches the conversation history, never switches the active session
 * and never enters the shared prompt queue. Title generation uses one today;
 * C1 question generation uses the same mechanism.
 *
 * The outcome is discriminated because "the model call did not produce usable
 * text" is not one condition: not being configured, timing out, failing and
 * returning nothing must stay distinguishable from a successful empty answer.
 */
export interface ModelCompletionRequest {
	prompt: string;
	maxTokens: number;
	timeoutMs: number;
	/** Already-aborted means give up without calling the provider. */
	signal?: AbortSignal;
}

export type ModelCompletionOutcome =
	/** Text was produced. `text` may be whitespace-only; callers must still check. */
	| { status: "ok"; text: string; model: LearningModelIdentity }
	/** No usable agent runtime yet: not configured, no model selected, or no credentials. */
	| { status: "not_ready"; reason: "agent_not_initialized" | "no_model" | "no_credentials" }
	| { status: "timeout" }
	| { status: "error"; message: string }
	/** The provider returned no text at all (empty or whitespace-only). */
	| { status: "empty" };

export type ModelCompletion = (request: ModelCompletionRequest) => Promise<ModelCompletionOutcome>;
