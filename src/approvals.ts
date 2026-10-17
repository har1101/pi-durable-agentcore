import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalDecision = "approve" | "reject";

/** One human approval, a member of a Session-scoped document family keyed by approval id. */
export type ApprovalState = {
  approvalId: string;
  status: ApprovalStatus;
  tool: string;
  action: string;
  /** The gated tool use's idempotency key (already hashed; no raw session id). */
  idempotencyKey: string;
  toolTaskId: number;
  /** requestId of the input whose run asked for the approval, when known. */
  requestId: string | null;
  requestedAt: number;
  deadline: number;
  decidedAt: number | null;
  decidedBy: "approver" | "timeout" | null;
  reason: string | null;
};

export const ApprovalDoc = defineDocFamily<ApprovalState, ApprovalState>({
  kind: "poc.approval",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ ...seed }),
});

export type WaitKind = "approval" | "timer";

/**
 * Everything the session is parked on, with the time it must be looked at
 * again (approval deadline or timer). Changed in the same commits as the
 * approvals and timers themselves; the runtime derives the WAKE item from it.
 */
export type WaitsState = {
  waits: { [id: string]: { kind: WaitKind; at: number; taskId: number } };
};

export const WaitsDoc = defineDoc<WaitsState>({
  kind: "poc.waits",
  version: 1,
  scope: "session",
  initial: () => ({ waits: {} }),
});

export const APPROVAL_ID_PATTERN = /^apr_[0-9a-f]{32}$/;

/** Deterministic from the tool use's idempotency key, so a rerun finds the same approval. */
export function approvalIdFor(idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`pi-durable-agentcore/approval-id/v1:${idempotencyKey}`)
    .digest("hex");
  return `apr_${digest.slice(0, 32)}`;
}

function signedMessage(approvalId: string, decision: ApprovalDecision): string {
  return `pi-durable-agentcore/approval/v1:${approvalId}:${decision}`;
}

/**
 * Approver credential: HMAC-SHA256 over the approval id and the exact
 * decision, with a key only the approver side holds (`APPROVAL_SIGNING_KEY`).
 * The requester only ever receives the approval id, which cannot approve.
 */
export function signApproval(
  signingKey: string,
  approvalId: string,
  decision: ApprovalDecision,
): string {
  return createHmac("sha256", signingKey)
    .update(signedMessage(approvalId, decision))
    .digest("hex");
}

export function verifyApprovalSignature(
  signingKey: string,
  approvalId: string,
  decision: ApprovalDecision,
  signature: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signApproval(signingKey, approvalId, decision), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly signature: string;
  readonly reason?: string;
}

const APPROVAL_FIELDS = new Set(["type", "approvalId", "decision", "signature", "reason"]);

/**
 * Strict parse of an approval answer. Only the exact string "approve"
 * approves; "reject" rejects; anything else ("yes", "APPROVE", true, 1, a
 * missing field) is a validation error and changes nothing.
 */
export function parseApprovalRequest(
  input: Record<string, unknown>,
): { ok: true; value: ApprovalRequest } | { ok: false; message: string } {
  for (const key of Object.keys(input)) {
    if (!APPROVAL_FIELDS.has(key)) {
      return { ok: false, message: `unexpected field ${JSON.stringify(key)}` };
    }
  }
  const { approvalId, decision, signature, reason } = input;
  if (typeof approvalId !== "string" || !APPROVAL_ID_PATTERN.test(approvalId)) {
    return { ok: false, message: "approvalId must match apr_<32 hex>" };
  }
  if (decision !== "approve" && decision !== "reject") {
    return {
      ok: false,
      message: 'decision must be exactly "approve" or "reject"',
    };
  }
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, message: "signature must be 64 lowercase hex characters" };
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return { ok: false, message: "reason must be a string of at most 500 characters" };
  }
  return {
    ok: true,
    value: {
      approvalId,
      decision,
      signature,
      ...(typeof reason === "string" ? { reason } : {}),
    },
  };
}

/** What a requester sees of a pending approval: never a credential. */
export interface PendingApprovalView {
  readonly approvalId: string;
  readonly tool: string;
  readonly action: string;
  readonly requestedAt: string;
  readonly deadline: string;
}

export function pendingView(state: ApprovalState): PendingApprovalView {
  return {
    approvalId: state.approvalId,
    tool: state.tool,
    action: state.action,
    requestedAt: new Date(state.requestedAt).toISOString(),
    deadline: new Date(state.deadline).toISOString(),
  };
}
