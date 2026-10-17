import { createHash, timingSafeEqual } from "node:crypto";
import { isApprovalId } from "./suspensions.js";

/** The `/invocations` body, parsed once at the HTTP boundary. */
export type Command =
  | { readonly action: "invoke"; readonly prompt: string; readonly requestId?: string }
  | {
      readonly action: "decide";
      readonly approvalId: string;
      readonly decision: "approve" | "reject";
      readonly approverToken?: string;
    }
  /** Sent by the resumer; it can only advance what durable state already allows. */
  | { readonly action: "resume" };

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export function parseCommand(body: Record<string, unknown>): Parsed<Command> {
  const action = body.action ?? "invoke";
  if (action === "invoke") {
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      return { ok: false, message: "prompt must be a non-empty string" };
    }
    if (body.requestId !== undefined && typeof body.requestId !== "string") {
      return { ok: false, message: "requestId must be a string" };
    }
    return {
      ok: true,
      value: {
        action,
        prompt: body.prompt,
        ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
      },
    };
  }
  if (action === "decide") {
    if (!isApprovalId(body.approvalId)) {
      return { ok: false, message: "approvalId must look like apr_<32 hex>" };
    }
    // Only these exact strings count; "yes", true, or "APPROVE" never approve.
    if (body.decision !== "approve" && body.decision !== "reject") {
      return { ok: false, message: 'decision must be exactly "approve" or "reject"' };
    }
    if (body.approverToken !== undefined && typeof body.approverToken !== "string") {
      return { ok: false, message: "approverToken must be a string" };
    }
    return {
      ok: true,
      value: {
        action,
        approvalId: body.approvalId,
        decision: body.decision,
        ...(typeof body.approverToken === "string" ? { approverToken: body.approverToken } : {}),
      },
    };
  }
  if (action === "resume") return { ok: true, value: { action } };
  return { ok: false, message: "action must be invoke, decide, or resume" };
}

/**
 * Approvers hold a token the requester never sees; it travels in the decide
 * payload, which InvokeAgentRuntime passes through without runtime header
 * configuration. The runtime stores only its SHA-256, and an unset digest
 * refuses every decision.
 */
export function approverAuthorized(
  token: string | undefined,
  expectedSha256: string | undefined = process.env.APPROVER_TOKEN_SHA256,
): boolean {
  if (token === undefined || token === "") return false;
  if (expectedSha256 === undefined || !/^[0-9a-f]{64}$/i.test(expectedSha256)) return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(expectedSha256, "hex"));
}
