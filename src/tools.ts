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
import type { EffectLedger } from "./effects.js";
import type { EventLog } from "./event-log.js";
import {
  approvalIdFor,
  Suspensions,
  type Approval,
  type SuspensionsState,
} from "./suspensions.js";

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
  readonly effects: EffectLedger;
  readonly now: () => number;
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

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Resolve once `select` finds a value in the committed suspensions document. */
export async function watchSuspensions<T>(
  observer: Pick<ToolExecutionApi, "watchDoc">,
  select: (state: SuspensionsState | undefined) => T | undefined,
  context: Context,
): Promise<T> {
  const watch = await observer.watchDoc(Suspensions, context);
  if (watch === undefined) throw new Error("app.suspensions document is missing");
  try {
    return await new Promise<T>((resolve, reject) => {
      const check = (state: Readonly<SuspensionsState> | null) => {
        const found = select(state ?? undefined);
        if (found !== undefined) resolve(found);
      };
      check(watch.value);
      watch.start(async (state) => check(state));
      void watch.closed.then((end) =>
        reject(new Error(`suspensions watch ended: ${end.reason}`)),
      );
      const signal = context.abortSignal;
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } finally {
    await watch.stop();
  }
}

/**
 * Parks the call until an approver decides. The pending approval is committed
 * before the wait, and the tool is replay-safe, so a new process reruns it,
 * finds the same approval (its id derives from the idempotency key), and
 * continues once it is decided. Only `approved` runs `execute`.
 */
export function approvalGatedTool<P extends TSchema>(
  scope: ToolScope,
  timeoutMs: number,
  definition: KeyedToolDefinition<P> & { summarize(args: Static<P>): string },
) {
  return defineKeyedTool(scope, {
    ...definition,
    replay: "safe",
    execute: async (args, call, context) => {
      const id = approvalIdFor(call.key);
      const created = await call.api.commit(async (tx) => {
        const state = await tx.doc(Suspensions);
        if (state.items[id] !== undefined) return undefined;
        const requestedAt = scope.now();
        const approval: Approval = {
          kind: "approval",
          id,
          tool: definition.name,
          summary: definition.summarize(args),
          requestedAt,
          deadline: requestedAt + timeoutMs,
          status: "pending",
        };
        state.items[id] = approval;
        return copy(approval);
      }, context);
      if (created !== undefined) {
        await scope.events.record("approval_requested", created);
      }
      const decided = await watchSuspensions(
        call.api,
        (state) => {
          const item = state?.items[id];
          return item?.kind === "approval" && item.status !== "pending"
            ? copy(item)
            : undefined;
        },
        context,
      );
      if (decided.status !== "approved") {
        return {
          output: [
            {
              type: "text",
              text: `Approval ${id} was rejected (${decided.status === "rejected" ? decided.decidedBy : "unknown"}); ${definition.name} did not run.`,
            },
          ],
          isError: true,
        };
      }
      return definition.execute(args, call, context);
    },
  });
}

export function approvedActionTool(scope: ToolScope, timeoutMs: number) {
  return approvalGatedTool(scope, timeoutMs, {
    name: "approved_action",
    description: "Perform an action that a human must approve first.",
    parameters: Type.Object({ action: Type.String() }),
    summarize: ({ action }) => `approved_action: ${action}`,
    execute: async ({ action }, call) => {
      const effect = await scope.effects.apply(call.key, { action });
      await scope.events.record("side_effect", {
        action,
        idempotencyKey: call.key,
        effect,
      });
      return {
        output: [{ type: "text", text: `Action ${action} applied (${effect}).` }],
      };
    },
  });
}
