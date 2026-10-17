import { createHash } from "node:crypto";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `tk1_` + 64 hex. One per tool task: stable across retries, replays and resume; never contains the session id. */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Keyed by the pi-durable task id, which Storage mints once per tool task, not by the provider call id, which a
 * provider may reuse (the scripted model restarts `durable-wait-1` in every process).
 */
export function toolKey(sessionId: string, taskId: number): IdempotencyKey {
  return `tk1_${digest(["pi-durable-agentcore/tool/v1", sessionId, taskId])}` as IdempotencyKey;
}
