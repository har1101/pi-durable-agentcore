import { createHash } from "node:crypto";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import {
  defineTool,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { EventLog } from "./event-log.js";

declare const idempotencyKeyBrand: unique symbol;
/** 64 hex chars. Derived from a hashed session id and the tool task id. */
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

/**
 * The tool task id is minted once per tool use and kept across retries,
 * replays, and resume, unlike a provider's tool call id, which providers may
 * reuse. Hashing keeps the raw session id out of downstream systems.
 */
export function toolIdempotencyKey(
  sessionId: string,
  taskId: TaskId,
): IdempotencyKey {
  const session = createHash("sha256").update(sessionId).digest("hex");
  return createHash("sha256")
    .update(`pi-durable-agentcore/tool/v1\0${session}\0${String(taskId)}`)
    .digest("hex") as IdempotencyKey;
}

/** Per-session dependencies every tool shares. */
export interface ToolScope {
  readonly sessionId: string;
  readonly events: EventLog;
}

export interface KeyedCall {
  readonly key: IdempotencyKey;
  readonly api: ToolExecutionApi;
}

type KeyedToolDefinition<P extends TSchema> = Omit<
  ToolRegistration<P>,
  "execute"
> & {
  execute(
    args: Static<P>,
    call: KeyedCall,
    context: Context,
  ): Promise<ToolExecutionResult>;
};

/**
 * A tool whose every execution attempt gets the call's idempotency key and is
 * recorded as a `tool_attempt` event (and a TOOL_ATTEMPT stdout line).
 */
export function defineKeyedTool<P extends TSchema>(
  scope: ToolScope,
  definition: KeyedToolDefinition<P>,
): ToolRegistration<P> {
  return defineTool({
    ...definition,
    execute: async (args, api, context) => {
      const key = toolIdempotencyKey(scope.sessionId, api.taskId);
      const attempt = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        tool: definition.name,
        callId: api.callId,
        taskId: api.taskId,
        idempotencyKey: key,
        sessionId: scope.sessionId,
        ...("label" in (args as object)
          ? { label: (args as { label: unknown }).label }
          : {}),
      };
      process.stdout.write(`TOOL_ATTEMPT ${JSON.stringify(attempt)}\n`);
      await scope.events.record("tool_attempt", attempt);
      return definition.execute(args, { key, api }, context);
    },
  });
}

export function sleep(ms: number, context: Context): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const signal = context.abortSignal;
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function durableWaitTool(scope: ToolScope, delayMs: number) {
  return defineKeyedTool(scope, {
    name: "durable_wait",
    description: "Wait briefly so process-crash recovery can be demonstrated.",
    parameters: Type.Object({ label: Type.String() }),
    replay: "safe",
    execute: async ({ label }, _call, context) => {
      await scope.events.record("tool_call_started", {
        name: "durable_wait",
        label,
        delayMs,
      });
      await sleep(delayMs, context);
      await scope.events.record("tool_call_completed", {
        name: "durable_wait",
        label,
      });
      return {
        output: [{ type: "text", text: `waited ${delayMs}ms for ${label}` }],
      };
    },
  });
}
