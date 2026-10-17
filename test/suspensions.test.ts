import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approverAuthorized, parseCommand } from "../dist/commands.js";
import {
  approvalIdFor,
  decide,
  expireDue,
  wakePlan,
  type SuspensionsState,
} from "../dist/suspensions.js";

function stateWithApproval(deadline: number): SuspensionsState {
  const id = approvalIdFor("k".repeat(64));
  return {
    items: {
      [id]: {
        kind: "approval",
        id,
        tool: "approved_action",
        summary: "approved_action: deploy",
        requestedAt: 0,
        deadline,
        status: "pending",
      },
    },
  };
}

describe("approval decisions", () => {
  it("lets the first decision win, including against a timeout", () => {
    const state = stateWithApproval(1_000);
    const id = Object.keys(state.items)[0]!;
    expect(decide(state, id, "approve", 10).kind).toBe("decided");
    expect(expireDue(state, 2_000)).toEqual([]);
    const late = decide(state, id, "reject", 20);
    expect(late).toMatchObject({ kind: "already_decided", approval: { status: "approved" } });
  });

  it("expires only pending approvals whose deadline passed", () => {
    const state = stateWithApproval(1_000);
    expect(expireDue(state, 999)).toEqual([]);
    const [expired] = expireDue(state, 1_000);
    expect(expired).toMatchObject({ status: "rejected", decidedBy: "timeout" });
    const id = Object.keys(state.items)[0]!;
    expect(decide(state, id, "approve", 1_001).kind).toBe("already_decided");
  });

  it("reports unknown approvals", () => {
    expect(decide({ items: {} }, approvalIdFor("x"), "approve", 0).kind).toBe("not_found");
  });
});

describe("wake plan", () => {
  it("follows live work: its earliest suspension, else in-flight grace; no work, no wake", () => {
    const parked = stateWithApproval(5_000);
    expect(wakePlan({ activeWork: true, suspensions: parked, now: 0, graceMs: 60_000 })).toEqual({
      reason: "approval_deadline",
      dueAt: 5_000,
    });
    expect(wakePlan({ activeWork: true, suspensions: { items: {} }, now: 100, graceMs: 60_000 })).toEqual({
      reason: "in_flight",
      dueAt: 60_100,
    });
    expect(wakePlan({ activeWork: false, suspensions: undefined, now: 0, graceMs: 1 })).toEqual({ reason: "none" });
    expect(wakePlan({ activeWork: false, suspensions: parked, now: 0, graceMs: 1 })).toEqual({ reason: "none" });
  });
});

describe("decide command boundary", () => {
  const approvalId = approvalIdFor("key");

  it("accepts only the exact strings approve and reject", () => {
    expect(parseCommand({ action: "decide", approvalId, decision: "approve" }).ok).toBe(true);
    expect(parseCommand({ action: "decide", approvalId, decision: "reject" }).ok).toBe(true);
    for (const decision of ["Approve", "APPROVE", "yes", "ok", " approve", true, 1, {}, undefined]) {
      expect(parseCommand({ action: "decide", approvalId, decision }).ok).toBe(false);
    }
    expect(parseCommand({ action: "decide", approvalId: "apr_x", decision: "approve" }).ok).toBe(false);
    expect(parseCommand({ action: "decide", approvalId, decision: "approve", approverToken: 1 }).ok).toBe(false);
  });

  it("authorizes only the configured approver token", () => {
    const digest = createHash("sha256").update("secret").digest("hex");
    expect(approverAuthorized("secret", digest)).toBe(true);
    expect(approverAuthorized("Secret", digest)).toBe(false);
    expect(approverAuthorized(undefined, digest)).toBe(false);
    expect(approverAuthorized("secret", undefined)).toBe(false);
    expect(approverAuthorized("secret", "")).toBe(false);
  });
});
