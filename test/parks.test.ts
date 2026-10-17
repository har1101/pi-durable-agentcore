import { describe, expect, it } from "vitest";
import {
  authorizedApprover,
  parseApprovalTimeout,
  parseApprovers,
  parseInvocation,
} from "../dist/invocation.js";
import {
  approvalIdOf,
  decideStep,
  parkIdOf,
  parseApprovalId,
  toolKey,
  verdictOf,
  type ParkRecord,
} from "../dist/parks.js";

const id = parkIdOf(toolKey("session-a", 12));
const approval: ParkRecord = {
  id,
  kind: "approval",
  tool: "publish_report",
  summary: 'publish_report {"title":"Q3"}',
  requestedAt: 0,
  deadlineAt: 1_000,
  requestedBy: "carol",
};
const decided = (decision: "approve" | "reject", by: string): ParkRecord => ({
  ...approval,
  decided: { decision, by, at: 500 },
});
const timer: ParkRecord = { ...approval, kind: "timer", tool: "wait_until" };

describe("verdictOf", () => {
  it.each([
    ["undecided approval before the deadline", approval, 999, "pending"],
    ["undecided approval at the deadline", approval, 1_000, "timed_out"],
    ["approved before the deadline, read after it", decided("approve", "alice"), 5_000, "approved"],
    ["rejected by a human", decided("reject", "alice"), 10, "rejected"],
    ["rejected by the deadline", decided("reject", "timeout"), 5_000, "rejected"],
    ["timer before it is due", timer, 999, "pending"],
    ["timer once due", timer, 1_000, "elapsed"],
  ] as const)("%s -> %s", (_, park, now, verdict) => {
    expect(verdictOf(park, now)).toBe(verdict);
  });
});

describe("decideStep", () => {
  it.each([
    ["no such approval", undefined, "approve", "alice", 10, "unknown"],
    ["a timer cannot be decided", timer, "approve", "alice", 10, "unknown"],
    ["the requester cannot decide", approval, "approve", "carol", 10, "self_approval"],
    ["an undecided approval before the deadline", approval, "approve", "alice", 999, "write"],
    ["an undecided approval past the deadline", approval, "approve", "alice", 1_000, "expire"],
    ["the same decision again", decided("approve", "alice"), "approve", "bob", 10, "duplicate"],
    ["the other decision", decided("approve", "alice"), "reject", "bob", 10, "already_decided"],
    ["after the deadline decided", decided("reject", "timeout"), "approve", "alice", 5_000, "expired"],
    ["a human reject after the deadline decided", decided("reject", "timeout"), "reject", "alice", 5_000, "expired"],
  ] as const)("%s -> %s", (_, park, decision, approver, now, step) => {
    expect(decideStep(park, decision, approver, now).kind).toBe(step);
  });
});

describe("keys and approval ids", () => {
  it("derives one stable key per session and task, without the session id", () => {
    const key = toolKey("session-a", 12);
    expect(key).toMatch(/^tk1_[0-9a-f]{64}$/);
    expect(key).toBe(toolKey("session-a", 12));
    expect(key).not.toBe(toolKey("session-a", 13));
    expect(key).not.toBe(toolKey("session-b", 12));
    expect(key).not.toContain("session-a");
  });

  it("derives the approval id separately from the key", () => {
    const key = toolKey("session-a", 12);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain(id);
    expect(parseApprovalId(approvalIdOf(id))).toBe(id);
  });

  it.each([
    approvalIdOf(id).toUpperCase(),
    `apr_${id}0`,
    id,
    `apr-${id}`,
    42,
    undefined,
  ])("rejects malformed approval id %s", (value) => {
    expect(parseApprovalId(value)).toBeUndefined();
  });
});

describe("parseInvocation", () => {
  const approvalId = approvalIdOf(id);
  it.each([
    [{ prompt: "hi" }, { action: "invoke", prompt: "hi" }],
    [{ prompt: "hi", requestId: "r1" }, { action: "invoke", prompt: "hi", requestId: "r1" }],
    [{ action: "decide", approvalId, decision: "approve" }, { action: "decide", approval: id, decision: "approve" }],
    [{ action: "decide", approvalId, decision: "reject" }, { action: "decide", approval: id, decision: "reject" }],
    [{ action: "resume" }, { action: "resume" }],
  ])("accepts %j", (body, invocation) => {
    expect(parseInvocation(body)).toEqual({ ok: true, invocation });
  });

  it.each([
    [{}],
    [{ prompt: " " }],
    [{ prompt: "hi", requestId: 7 }],
    [{ action: "decide", approvalId, decision: "yes" }],
    [{ action: "decide", approvalId, decision: "APPROVE" }],
    [{ action: "decide", approvalId, decision: true }],
    [{ action: "decide", approvalId }],
    [{ action: "decide", approvalId: approvalId.toUpperCase(), decision: "approve" }],
    [{ action: "invoke", prompt: "hi" }],
    [["resume"]],
    [null],
  ])("rejects %j", (body) => {
    expect(parseInvocation(body).ok).toBe(false);
  });
});

describe("approvers", () => {
  it("allows only listed user ids and fails closed", () => {
    const approvers = parseApprovers(" alice, bob,,timeout ");
    expect([...approvers]).toEqual(["alice", "bob"]);
    expect(authorizedApprover("alice", approvers)).toBe("alice");
    expect(authorizedApprover("mallory", approvers)).toBeUndefined();
    expect(authorizedApprover(undefined, approvers)).toBeUndefined();
    expect(authorizedApprover("timeout", approvers)).toBeUndefined();
    expect(authorizedApprover("alice", parseApprovers(undefined))).toBeUndefined();
  });
});

describe("PI_APPROVAL_TIMEOUT_MS", () => {
  it("defaults to one day and accepts a positive integer", () => {
    expect(parseApprovalTimeout(undefined)).toBe(86_400_000);
    expect(parseApprovalTimeout("1500")).toBe(1500);
  });

  it("refuses anything that is not a positive integer of milliseconds", () => {
    for (const value of ["", "0", "-1", "1.5", "1e3", " 10", "abc", "9007199254740993"]) {
      expect(() => parseApprovalTimeout(value), JSON.stringify(value)).toThrow(
        /PI_APPROVAL_TIMEOUT_MS must be a positive integer/,
      );
    }
  });
});
