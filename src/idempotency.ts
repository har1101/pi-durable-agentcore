import { createHash } from "node:crypto";

const KEY_DOMAIN = "pi-durable-agentcore/tool-idempotency/v1";

export interface ToolIdempotencyInput {
  /** Raw AgentCore runtime session id. Only its hash leaves this function. */
  readonly sessionId: string;
  /** Pi conversation that owns the tool task. */
  readonly conversationId: number | string;
  /**
   * Pi tool task id. Minted from durable storage when the call is admitted and
   * persisted with the task, so it is stable across retries, replays, resume
   * on another microVM, and unique per tool use even when a provider reuses a
   * tool call id.
   */
  readonly taskId: number | string;
}

/**
 * Idempotency key for one tool execution: `tk_` + 64 hex chars. Pass it to
 * downstream APIs (payment, deploy, ticketing) as their idempotency token.
 * The raw session id is never part of the key, only its domain-separated hash.
 */
export function toolIdempotencyKey(input: ToolIdempotencyInput): string {
  const digest = createHash("sha256")
    .update(
      [
        KEY_DOMAIN,
        input.sessionId,
        String(input.conversationId),
        String(input.taskId),
      ].join("\0"),
    )
    .digest("hex");
  return `tk_${digest}`;
}
