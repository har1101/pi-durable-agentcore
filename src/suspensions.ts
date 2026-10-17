import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";

/**
 * Durable record of every point where a tool parked the run: a human approval
 * or a timer. It lives in Pi's own commit log (session doc `app.suspensions`),
 * so it moves with the session to any microVM. The tool that created an item
 * waits on it; the host decides approvals and expires deadlines.
 */
export type ApprovalDecision =
  | { readonly status: "pending" }
  | {
      readonly status: "approved" | "rejected";
      readonly decidedAt: number;
      readonly decidedBy: "approver" | "timeout";
    };

export type Approval = {
  readonly kind: "approval";
  readonly id: string;
  readonly tool: string;
  readonly summary: string;
  readonly requestedAt: number;
  readonly deadline: number;
} & ApprovalDecision;

export type Timer = {
  readonly kind: "timer";
  readonly id: string;
  readonly tool: string;
  readonly wakeAt: number;
  readonly status: "waiting" | "fired";
};

export type Suspension = Approval | Timer;

export type SuspensionsState = { items: { [id: string]: Suspension } };

export const Suspensions = defineDoc<SuspensionsState>({
  kind: "app.suspensions",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
});

const APPROVAL_ID = /^apr_[0-9a-f]{32}$/;

/** Public handle of an approval. It names the approval; it does not authorize deciding it. */
export function approvalIdFor(idempotencyKey: string): string {
  return `apr_${createHash("sha256").update(`approval\0${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

export function timerIdFor(idempotencyKey: string): string {
  return `tmr_${createHash("sha256").update(`timer\0${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

export function isApprovalId(value: unknown): value is string {
  return typeof value === "string" && APPROVAL_ID.test(value);
}

export type DecisionInput = "approve" | "reject" | "timeout";

export type DecisionOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "decided"; readonly approval: Approval }
  | { readonly kind: "already_decided"; readonly approval: Approval };

/** First decision wins; later ones, including a timeout, see `already_decided`. */
export function decide(
  state: SuspensionsState,
  id: string,
  decision: DecisionInput,
  now: number,
): DecisionOutcome {
  const item = state.items[id];
  if (item?.kind !== "approval") return { kind: "not_found" };
  if (item.status !== "pending") return { kind: "already_decided", approval: item };
  const decided: Approval = {
    kind: "approval",
    id: item.id,
    tool: item.tool,
    summary: item.summary,
    requestedAt: item.requestedAt,
    deadline: item.deadline,
    status: decision === "approve" ? "approved" : "rejected",
    decidedAt: now,
    decidedBy: decision === "timeout" ? "timeout" : "approver",
  };
  state.items[id] = decided;
  return { kind: "decided", approval: decided };
}

/** Reject every pending approval whose deadline has passed. */
export function expireDue(state: SuspensionsState, now: number): Approval[] {
  const expired: Approval[] = [];
  for (const item of Object.values(state.items)) {
    if (item.kind === "approval" && item.status === "pending" && item.deadline <= now) {
      const outcome = decide(state, item.id, "timeout", now);
      if (outcome.kind === "decided") expired.push(outcome.approval);
    }
  }
  return expired;
}

/** What the run is parked on, earliest due first. */
export function activeSuspensions(state: SuspensionsState | undefined): Suspension[] {
  return Object.values(state?.items ?? {})
    .filter((item) => (item.kind === "approval" ? item.status === "pending" : item.status === "waiting"))
    .sort((a, b) => dueAt(a) - dueAt(b));
}

/**
 * What an invocation reports as pending: an undecided approval, or a timer
 * whose wake time is still ahead. A due timer is about to fire, not parked.
 */
export function parkedOn(
  state: SuspensionsState | undefined,
  now: number,
): Suspension | undefined {
  return activeSuspensions(state).find(
    (item) => item.kind === "approval" || item.wakeAt > now,
  );
}

export function dueAt(item: Suspension): number {
  return item.kind === "approval" ? item.deadline : item.wakeAt;
}

/** When the session next needs a resume invocation if nobody calls it. */
export type WakePlan =
  | { readonly reason: "none" }
  | { readonly reason: "in_flight" | "approval_deadline" | "timer"; readonly dueAt: number };

export function wakePlan(input: {
  readonly activeWork: boolean;
  readonly suspensions: SuspensionsState | undefined;
  readonly now: number;
  readonly graceMs: number;
}): WakePlan {
  const parked = activeSuspensions(input.suspensions)[0];
  if (parked !== undefined) {
    return {
      reason: parked.kind === "approval" ? "approval_deadline" : "timer",
      dueAt: dueAt(parked),
    };
  }
  if (input.activeWork) return { reason: "in_flight", dueAt: input.now + input.graceMs };
  return { reason: "none" };
}
