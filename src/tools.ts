import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  ApprovalDoc,
  approvalIdFor,
  WaitsDoc,
  type ApprovalState,
} from "./approvals.js";
import type { EffectLedger } from "./effects.js";
import type { EventRecorder } from "./event-recorder.js";
import { toolIdempotencyKey } from "./idempotency.js";
import type { Parking } from "./parking.js";

export interface ToolDependencies {
  readonly sessionId: string;
  readonly recorder: EventRecorder;
  readonly effects: EffectLedger;
  readonly parking: Parking;
  /** `durable_wait` delay. */
  readonly delayMs: number;
  /** How long a human has to answer before the approval auto-rejects. */
  readonly approvalTimeoutMs: number;
  /** Timed waits up to this long sleep in-process; longer ones park the session. */
  readonly inlineWaitMaxMs: number;
  /** requestId of the input whose run is executing in `conversationId`, if any. */
  requestIdFor(conversationId: number, context: Context): Promise<string | null>;
}

const MAX_TIMER_MS = 2_147_483_647;

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("Tool invocation was aborted");
}

/** Sleep that rejects when the invocation is aborted (Harness close, abort). */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, Math.min(ms, MAX_TIMER_MS)),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function recordAttempt(
  deps: ToolDependencies,
  api: ToolExecutionApi,
  tool: string,
  idempotencyKey: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const attempt = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    tool,
    ...extra,
    // CloudWatch filtering in scripts/live-agentcore-crash-resume.sh keys on it.
    sessionId: deps.sessionId,
    taskId: api.taskId,
    callId: api.callId,
    idempotencyKey,
  };
  process.stdout.write(`TOOL_ATTEMPT ${JSON.stringify(attempt)}\n`);
  const { sessionId: _omitted, ...detail } = attempt;
  await deps.recorder.record("tool_attempt", detail);
}

/** Resolves once the approval leaves `pending` or its deadline passes; rejects on abort. */
async function waitForApprovalChange(
  api: ToolExecutionApi,
  approvalId: string,
  deadline: number,
  context: Context,
): Promise<void> {
  const watch = await api.watchDoc(ApprovalDoc, approvalId, context);
  if (watch === undefined || watch.value?.status !== "pending") {
    await watch?.stop();
    return;
  }
  const signal = context.abortSignal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      onAbort = () => reject(abortError(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(resolve, Math.max(0, Math.min(deadline - Date.now(), MAX_TIMER_MS)));
      watch.start(async (value) => {
        if (value?.status !== "pending") resolve();
      });
      void watch.closed.then(() => resolve());
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    await watch.stop();
  }
}

/** Decide an overdue approval as `expired` (auto-reject); a no-op if it was decided meanwhile. */
async function expireApproval(
  api: ToolExecutionApi,
  current: ApprovalState,
  context: Context,
): Promise<void> {
  await api.commit(async (tx) => {
    const approval = await tx.doc(ApprovalDoc, current.approvalId, current);
    if (approval.status !== "pending" || Date.now() < approval.deadline) return;
    approval.status = "expired";
    approval.decidedAt = Date.now();
    approval.decidedBy = "timeout";
    approval.reason = "No decision before the approval deadline; auto-rejected.";
    const waits = await tx.doc(WaitsDoc);
    delete waits.waits[current.approvalId];
  }, context);
}

export function createPocExtension(deps: ToolDependencies): Extension {
  const durableWait = defineTool({
    name: "durable_wait",
    description: "Wait briefly so process-crash recovery can be demonstrated.",
    parameters: Type.Object({ label: Type.String() }),
    replay: "safe",
    execute: async ({ label }, api, context) => {
      const idempotencyKey = await toolIdempotencyKey(
        api,
        deps.sessionId,
        "durable_wait",
        context,
      );
      await recordAttempt(deps, api, "durable_wait", idempotencyKey, { label });
      await deps.recorder.record("tool_call_started", {
        name: "durable_wait",
        label,
        delayMs: deps.delayMs,
        idempotencyKey,
      });
      await sleep(deps.delayMs, context.abortSignal);
      await deps.recorder.record("tool_call_completed", {
        name: "durable_wait",
        label,
        idempotencyKey,
      });
      return {
        output: [
          { type: "text" as const, text: `waited ${deps.delayMs}ms for ${label}` },
        ],
      };
    },
  });

  const sensitiveAction = defineTool({
    name: "perform_sensitive_action",
    description:
      "Perform a sensitive, externally visible action. A human approver must approve it first; " +
      "the call waits (possibly for hours) until they approve, reject, or the approval times out.",
    parameters: Type.Object({
      action: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    replay: "safe",
    execute: async ({ action }, api, context) => {
      const idempotencyKey = await toolIdempotencyKey(
        api,
        deps.sessionId,
        "perform_sensitive_action",
        context,
      );
      await recordAttempt(deps, api, "perform_sensitive_action", idempotencyKey, {
        action,
      });
      const approvalId = approvalIdFor(idempotencyKey);
      const existing = await api.snapshot(ApprovalDoc, approvalId, context);
      if (existing === undefined) {
        const now = Date.now();
        const seed: ApprovalState = {
          approvalId,
          status: "pending",
          tool: "perform_sensitive_action",
          action,
          idempotencyKey,
          toolTaskId: api.taskId,
          requestId: await deps.requestIdFor(api.conversationId, context),
          requestedAt: now,
          deadline: now + deps.approvalTimeoutMs,
          decidedAt: null,
          decidedBy: null,
          reason: null,
        };
        await api.commit(async (tx) => {
          // Created only when absent: a rerun keeps the original deadline.
          const approval = await tx.doc(ApprovalDoc, approvalId, seed);
          if (approval.status !== "pending") return;
          const waits = await tx.doc(WaitsDoc);
          waits.waits[approvalId] = {
            kind: "approval",
            at: approval.deadline,
            taskId: api.taskId,
          };
        }, context);
        await deps.recorder.record("approval_requested", {
          approvalId,
          action,
          deadline: new Date(seed.deadline).toISOString(),
          idempotencyKey,
        });
      }

      let decided: ApprovalState;
      for (;;) {
        const current = await api.snapshot(ApprovalDoc, approvalId, context);
        if (current === undefined) {
          throw new Error(`Approval ${approvalId} disappeared`);
        }
        if (current.status !== "pending") {
          decided = current;
          break;
        }
        if (Date.now() >= current.deadline) {
          await expireApproval(api, current, context);
          continue;
        }
        deps.parking.park(api.taskId, {
          kind: "approval",
          id: approvalId,
          at: current.deadline,
        });
        try {
          await waitForApprovalChange(api, approvalId, current.deadline, context);
        } finally {
          deps.parking.unpark(api.taskId);
        }
      }

      if (decided.status !== "approved") {
        await deps.recorder.record("approval_denied", {
          approvalId,
          status: decided.status,
          decidedBy: decided.decidedBy,
          idempotencyKey,
        });
        const why =
          decided.status === "expired"
            ? "the approval deadline passed without a decision, so it was auto-rejected"
            : `the approver rejected it${decided.reason ? ` (${decided.reason})` : ""}`;
        return {
          output: [
            { type: "text" as const, text: `Not executed: ${action} was not performed because ${why}.` },
          ],
          details: { approvalId, status: decided.status, idempotencyKey },
        };
      }

      // The external effect carries the idempotency key, so a rerun after a
      // crash between the effect and this result does not apply it twice.
      const effect = await deps.effects.apply(idempotencyKey, action);
      process.stdout.write(
        `SIDE_EFFECT ${JSON.stringify({ action, idempotencyKey, applied: effect.applied, pid: process.pid })}\n`,
      );
      await deps.recorder.record("side_effect", {
        approvalId,
        action,
        idempotencyKey,
        applied: effect.applied,
        firstAppliedAt: effect.record.appliedAt,
      });
      return {
        output: [
          {
            type: "text" as const,
            text: `Approved by a human approver; executed ${action}.`,
          },
        ],
        details: { approvalId, status: decided.status, idempotencyKey },
      };
    },
  });

  const waitUntil = defineTool({
    name: "wait_until",
    description:
      "Pause the task for the given number of seconds, then continue. Long waits survive restarts " +
      "and are resumed automatically.",
    parameters: Type.Object({
      seconds: Type.Integer({ minimum: 0, maximum: 30 * 24 * 3600 }),
    }),
    replay: "safe",
    execute: async ({ seconds }, api, context) => {
      const idempotencyKey = await toolIdempotencyKey(
        api,
        deps.sessionId,
        "wait_until",
        context,
      );
      // First writer wins: a rerun waits for the original time, not a new one.
      const until = await api.memo<number>(
        "poc.waitUntil",
        Date.now() + seconds * 1000,
        context,
      );
      await recordAttempt(deps, api, "wait_until", idempotencyKey, {
        until: new Date(until).toISOString(),
      });
      const timerId = `tmr_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
      if (Date.now() < until) {
        await api.commit(async (tx) => {
          const waits = await tx.doc(WaitsDoc);
          waits.waits[timerId] ??= { kind: "timer", at: until, taskId: api.taskId };
        }, context);
        const parks = until - Date.now() > deps.inlineWaitMaxMs;
        if (parks) {
          deps.parking.park(api.taskId, { kind: "timer", id: timerId, at: until });
        }
        try {
          await sleep(until - Date.now(), context.abortSignal);
        } finally {
          if (parks) deps.parking.unpark(api.taskId);
        }
      }
      await api.commit(async (tx) => {
        const waits = await tx.doc(WaitsDoc);
        if (waits.waits[timerId] !== undefined) delete waits.waits[timerId];
      }, context);
      await deps.recorder.record("timer_fired", {
        timerId,
        until: new Date(until).toISOString(),
        lateMs: Date.now() - until,
        idempotencyKey,
      });
      return {
        output: [
          {
            type: "text" as const,
            text: `Waited until ${new Date(until).toISOString()}.`,
          },
        ],
      };
    },
  });

  return defineExtension({
    name: "poc-durable-tools",
    tools: [durableWait, sensitiveAction, waitUntil],
  });
}
