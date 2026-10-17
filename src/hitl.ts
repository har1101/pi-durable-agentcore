import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ControlStore } from "./control-store.js";
import type { EventLog } from "./event-log.js";
import { toolIdempotencyKey } from "./idempotency.js";

/**
 * A tool asks the runtime to park the run: the runtime arms the session's
 * wake-up item, closes the Harness (the tool task stays at its durable
 * `execute` checkpoint), releases the lease, and answers the invocation with a
 * pending result. A later approval, timer, or crash sweep reopens the session
 * (on any microVM) and Pi reruns only this replay-safe tool.
 */
export interface SuspensionRequest {
  readonly kind: "approval" | "timer";
  readonly dueAt: number;
  readonly toolName: string;
  readonly idempotencyKey: string;
  readonly approvalId?: string;
}

export interface ToolServices {
  readonly sessionId: string;
  readonly events: EventLog;
  readonly control: ControlStore | undefined;
  requestSuspension(request: SuspensionRequest): Promise<void>;
}

export function approvalTimeoutMs(): number {
  const value = Number(process.env.PI_APPROVAL_TIMEOUT_MS ?? 24 * 60 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 24 * 60 * 60 * 1000;
}

/** Key of the approver credential; unset means no decision is accepted. */
function approvalHmacKey(): string | undefined {
  const key = process.env.APPROVAL_HMAC_KEY;
  return key !== undefined && key.length >= 16 ? key : undefined;
}

/**
 * Approver token for one approval: HMAC-SHA256 under a key only the approver
 * service holds. The pending result carries the approval id only, so the
 * requester cannot mint the token for their own action.
 */
export function approverToken(
  key: string,
  sessionId: string,
  approvalId: string,
): string {
  return createHmac("sha256", key)
    .update(`pi-durable-agentcore/approval/v1\0${sessionId}\0${approvalId}`)
    .digest("hex");
}

export function verifyApproverToken(
  sessionId: string,
  approvalId: string,
  token: unknown,
): "ok" | "not_configured" | "invalid" {
  const key = approvalHmacKey();
  if (key === undefined) return "not_configured";
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return "invalid";
  const expected = Buffer.from(approverToken(key, sessionId, approvalId), "hex");
  return timingSafeEqual(expected, Buffer.from(token, "hex")) ? "ok" : "invalid";
}

/** Parks the tool until the Harness closes; never resolves on its own. */
async function suspend(
  services: ToolServices,
  request: SuspensionRequest,
  context: Context,
): Promise<never> {
  const signal = (context as { abortSignal?: AbortSignal }).abortSignal;
  if (signal === undefined) {
    throw new Error("Tool context has no abort signal; cannot suspend durably");
  }
  await services.requestSuspension(request);
  return new Promise<never>((_resolve, reject) => {
    const stop = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(`Suspended ${request.kind} for ${request.toolName}`),
      );
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

export async function recordToolAttempt(
  services: ToolServices,
  api: Pick<ToolExecutionApi, "taskId" | "callId">,
  tool: string,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const attempt = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    tool,
    callId: api.callId,
    taskId: api.taskId,
    idempotencyKey,
    ...extra,
  };
  // CloudWatch evidence for the live AgentCore test, which filters on sessionId.
  process.stdout.write(
    `TOOL_ATTEMPT ${JSON.stringify({ ...attempt, sessionId: services.sessionId })}\n`,
  );
  await services.events.record("tool_attempt", attempt);
}

export function keyFor(
  services: ToolServices,
  api: Pick<ToolExecutionApi, "conversationId" | "taskId">,
): string {
  return toolIdempotencyKey({
    sessionId: services.sessionId,
    conversationId: api.conversationId,
    taskId: api.taskId,
  });
}

function text(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}

/** A sensitive action that runs only after a human explicitly approves it. */
export function guardedActionTool(services: ToolServices) {
  return defineTool({
    name: "guarded_action",
    description:
      "Perform a sensitive action (for example a production change). A human must approve it first; the call pauses durably until they decide or the approval times out.",
    parameters: Type.Object({
      action: Type.String({ minLength: 1, maxLength: 500 }),
      target: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const idempotencyKey = keyFor(services, api);
      const control = services.control;
      if (control === undefined) {
        return {
          isError: true,
          ...text("guarded_action needs the DynamoDB backend for durable approvals"),
        };
      }
      // Already performed by an earlier attempt: report the stored result.
      const done = await control.getEffect(idempotencyKey);
      if (done !== undefined) {
        await recordToolAttempt(services, api, "guarded_action", idempotencyKey, {
          phase: "already_performed",
        });
        return text(done.result);
      }
      const now = Date.now();
      // Memos are first-writer-wins in Pi storage: a rerun sees the same values.
      const approvalId = await api.memo("approvalId", randomUUID(), context);
      const requestedAt = await api.memo("approvalRequestedAt", now, context);
      let approval = await control.ensureApproval({
        approvalId,
        status: "pending",
        toolName: "guarded_action",
        arguments: JSON.stringify(args),
        idempotencyKey,
        requestedAt,
        deadline: requestedAt + approvalTimeoutMs(),
      });
      if (approval.status === "pending" && Date.now() >= approval.deadline) {
        approval = (await control.expire(approvalId, Date.now())) ?? approval;
      }
      await recordToolAttempt(services, api, "guarded_action", idempotencyKey, {
        phase: "approval_check",
        approvalId,
        approvalStatus: approval.status,
      });
      if (approval.status === "pending") {
        return suspend(
          services,
          {
            kind: "approval",
            dueAt: approval.deadline,
            toolName: "guarded_action",
            idempotencyKey,
            approvalId,
          },
          context,
        );
      }
      if (approval.status !== "approved") {
        const by = approval.decidedBy === "timeout" ? "timeout" : "approver";
        await services.events.record("approval_rejected", { approvalId, by });
        return text(
          `REJECTED (${by}${approval.reason ? `: ${approval.reason}` : ""}); the action "${args.action}" was not performed.`,
        );
      }
      // The external side effect, keyed by the idempotency key so it happens once.
      const { record, firstWrite } = await control.recordEffect(
        idempotencyKey,
        `APPROVED and performed "${args.action}"${args.target ? ` on ${args.target}` : ""} (idempotency key ${idempotencyKey}).`,
      );
      if (firstWrite) {
        await services.events.record("effect_performed", {
          tool: "guarded_action",
          approvalId,
          idempotencyKey,
        });
      }
      return text(record.result);
    },
  });
}

const MAX_WAIT_SECONDS = 30 * 24 * 60 * 60;

/** Resume the run at a later time without holding a process or invocation. */
export function waitUntilTool(services: ToolServices) {
  return defineTool({
    name: "wait_until",
    description:
      "Pause the run durably for the given number of seconds, then continue. Use for timed follow-ups.",
    parameters: Type.Object({
      seconds: Type.Number({ minimum: 0, maximum: MAX_WAIT_SECONDS }),
    }),
    replay: "safe",
    execute: async ({ seconds }, api, context) => {
      const idempotencyKey = keyFor(services, api);
      const resumeAt = await api.memo(
        "resumeAt",
        Date.now() + Math.round(seconds * 1000),
        context,
      );
      const due = Date.now() >= resumeAt;
      await recordToolAttempt(services, api, "wait_until", idempotencyKey, {
        resumeAt: new Date(resumeAt).toISOString(),
        due,
      });
      if (!due) {
        if (services.control === undefined) {
          // No durable wake-up without DynamoDB: wait in process.
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.max(0, resumeAt - Date.now())),
          );
        } else {
          return suspend(
            services,
            { kind: "timer", dueAt: resumeAt, toolName: "wait_until", idempotencyKey },
            context,
          );
        }
      }
      return text(`Resumed at ${new Date().toISOString()} (scheduled ${new Date(resumeAt).toISOString()}).`);
    },
  });
}
