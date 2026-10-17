import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";

export const TOOL_IDEMPOTENCY_KEY_PATTERN = /^idem_v1_[0-9a-f]{64}$/;
const MEMO_NAME = "poc.idempotencyKey";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Key of one tool use. Inputs:
 * - sha256(session id): scopes the key to the AgentCore session without
 *   exposing the raw id (the whole tuple is hashed again);
 * - conversation id and tool task id: Pi mints task ids from a session-global,
 *   never-reused sequence and persists them, so the id is stable across
 *   retries, replays and resume, and differs for every tool use, even when a
 *   provider reuses a tool call id;
 * - call id and tool name: for readability of the tuple only.
 */
export function deriveToolIdempotencyKey(input: {
  readonly sessionId: string;
  readonly conversationId: number;
  readonly taskId: number;
  readonly callId: string;
  readonly toolName: string;
}): string {
  const material = JSON.stringify([
    "pi-durable-agentcore/tool-idempotency/v1",
    sha256(input.sessionId),
    input.conversationId,
    input.taskId,
    input.callId,
    input.toolName,
  ]);
  return `idem_v1_${sha256(material)}`;
}

/**
 * The tool use's idempotency key, pinned in a task memo (first writer wins), so
 * a rerun after a crash or resume gets the identical key even if the
 * derivation changes in a later deploy.
 */
export async function toolIdempotencyKey(
  api: Pick<ToolExecutionApi, "memo" | "conversationId" | "taskId" | "callId">,
  sessionId: string,
  toolName: string,
  context: Context,
): Promise<string> {
  const derived = deriveToolIdempotencyKey({
    sessionId,
    conversationId: api.conversationId,
    taskId: api.taskId,
    callId: api.callId,
    toolName,
  });
  return api.memo<string>(MEMO_NAME, derived, context);
}
