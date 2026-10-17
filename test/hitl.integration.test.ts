import { afterEach, describe, expect, it } from "vitest";
import { signApproval } from "../dist/approvals.js";
import {
  cleanupTemporary,
  count,
  events,
  invoke,
  SIGNING_KEY,
  sessionIdFor,
  startServer,
  wakeItem,
  type ServerHandle,
} from "./support.js";

const servers: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop("SIGKILL")));
  await cleanupTemporary();
});

async function server(env: Record<string, string> = {}): Promise<ServerHandle> {
  const handle = await startServer(env);
  servers.push(handle);
  return handle;
}

interface PendingBody {
  status: string;
  requestId: string;
  approvals: Array<{ approvalId: string; tool: string; action: string; deadline: string }>;
}

describe("human-in-the-loop approval that leaves the process", () => {
  it("parks, survives the instance, validates answers strictly, and resumes from DynamoDB", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const sessionId = sessionIdFor("hitl-approve");
    const first = await server();

    const asked = await invoke(first, sessionId, {
      prompt: "Please do it [approval:rotate-demo-credentials]",
      requestId: "hitl-1",
    });
    expect(asked.status).toBe(200);
    const pending = asked.body as unknown as PendingBody;
    expect(pending).toMatchObject({ status: "pending_approval", requestId: "hitl-1" });
    expect(pending.approvals).toHaveLength(1);
    const approvalId = pending.approvals[0]!.approvalId;
    expect(approvalId).toMatch(/^apr_[0-9a-f]{32}$/);
    expect(pending.approvals[0]).toMatchObject({
      tool: "perform_sensitive_action",
      action: "rotate-demo-credentials",
    });
    // The requester gets an id, never something that can approve.
    const raw = JSON.stringify(asked.body);
    expect(raw).not.toContain(signApproval(SIGNING_KEY, approvalId, "approve"));
    expect(raw).not.toContain(SIGNING_KEY);
    expect(raw.toLowerCase()).not.toContain("signature");

    // The invocation returned, the runtime closed, and the process is idle.
    const ping = await fetch(`http://127.0.0.1:${first.port}/ping`);
    expect(await ping.json()).toEqual({ status: "Healthy" });
    const wake = await wakeItem(sessionId);
    expect(wake?.reason?.S).toBe("approval_deadline");
    expect(Number(wake?.wakeAt?.N)).toBe(Date.parse(pending.approvals[0]!.deadline));
    expect(Number(wake?.wakeAt?.N) - Date.now()).toBeGreaterThan(8 * 3600 * 1000);

    // The microVM goes away; the answer arrives at a brand-new instance.
    await first.stop("SIGKILL");
    const second = await server();

    const sign = (decision: "approve" | "reject") =>
      signApproval(SIGNING_KEY, approvalId, decision);
    const invalid: Array<[Record<string, unknown>, number]> = [
      [{ decision: "yes", signature: sign("approve") }, 400],
      [{ decision: "APPROVE", signature: sign("approve") }, 400],
      [{ decision: "approved", signature: sign("approve") }, 400],
      [{ decision: true, signature: sign("approve") }, 400],
      [{ decision: 1, signature: sign("approve") }, 400],
      [{ decision: " approve", signature: sign("approve") }, 400],
      [{ signature: sign("approve") }, 400],
      [{ decision: "approve" }, 400],
      [{ decision: "approve", signature: sign("approve"), approve: true }, 400],
      // A signature for "reject" cannot approve, and the requester's own guess cannot either.
      [{ decision: "approve", signature: sign("reject") }, 403],
      [{ decision: "approve", signature: "0".repeat(64) }, 403],
      [
        {
          decision: "approve",
          signature: signApproval("someone-elses-key-0123456789abcdef", approvalId, "approve"),
        },
        403,
      ],
    ];
    for (const [fields, status] of invalid) {
      const answer = await invoke(second, sessionId, {
        type: "approval",
        approvalId,
        ...fields,
      });
      expect({ fields, status: answer.status }).toEqual({ fields, status });
    }
    const unknown = await invoke(second, sessionId, {
      type: "approval",
      approvalId: `apr_${"1".repeat(32)}`,
      decision: "approve",
      signature: signApproval(SIGNING_KEY, `apr_${"1".repeat(32)}`, "approve"),
    });
    expect(unknown.status).toBe(404);
    let log = await events(second, sessionId);
    expect(count(log, "approval_decided")).toBe(0);
    expect(count(log, "side_effect")).toBe(0);

    const approved = await invoke(second, sessionId, {
      type: "approval",
      approvalId,
      decision: "approve",
      signature: sign("approve"),
      reason: "looks fine",
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: "success",
      requestId: "hitl-1",
      sessionId,
      approval: { approvalId, status: "approved", decidedBy: "approver" },
    });
    expect(String(approved.body.response)).toContain(
      "Approved by a human approver; executed rotate-demo-credentials.",
    );

    log = await events(second, sessionId);
    // One model call asked for the tool before the instance died, one answered after.
    expect(count(log, "model_call")).toBe(2);
    const attempts = log.filter((event) => event.kind === "tool_attempt");
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((event) => event.pid)).size).toBe(2);
    expect(new Set(attempts.map((event) => event.detail.idempotencyKey)).size).toBe(1);
    const effects = log.filter((event) => event.kind === "side_effect");
    expect(effects).toHaveLength(1);
    expect(effects[0]!.detail).toMatchObject({
      applied: true,
      idempotencyKey: attempts[0]!.detail.idempotencyKey,
    });
    const positions = log.map((event) => event.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect((await wakeItem(sessionId))?.wakeAt).toBeUndefined();

    // Same answer again: idempotent. A contradicting answer: conflict.
    const again = await invoke(second, sessionId, {
      type: "approval",
      approvalId,
      decision: "approve",
      signature: sign("approve"),
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "success", requestId: "hitl-1" });
    const contradict = await invoke(second, sessionId, {
      type: "approval",
      approvalId,
      decision: "reject",
      signature: sign("reject"),
    });
    expect(contradict.status).toBe(409);
    expect(contradict.body).toMatchObject({ approval: { status: "approved" } });

    // The original request id replays the stored answer without new model calls.
    const replay = await invoke(second, sessionId, {
      prompt: "Please do it [approval:rotate-demo-credentials]",
      requestId: "hitl-1",
    });
    expect(replay.body).toMatchObject({ status: "success", response: approved.body.response });
    log = await events(second, sessionId);
    expect(count(log, "model_call")).toBe(2);
    expect(count(log, "side_effect")).toBe(1);
  }, 60_000);

  it("continues with a rejection without executing the action", async () => {
    const sessionId = sessionIdFor("hitl-reject");
    const handle = await server();
    const asked = await invoke(handle, sessionId, {
      prompt: "[approval:delete-demo-bucket]",
      requestId: "hitl-reject-1",
    });
    const { approvalId } = (asked.body as unknown as PendingBody).approvals[0]!;
    const rejected = await invoke(handle, sessionId, {
      type: "approval",
      approvalId,
      decision: "reject",
      signature: signApproval(SIGNING_KEY, approvalId, "reject"),
      reason: "not today",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      status: "success",
      approval: { approvalId, status: "rejected", decidedBy: "approver" },
    });
    expect(String(rejected.body.response)).toContain(
      "Not executed: delete-demo-bucket was not performed because the approver rejected it (not today).",
    );
    const log = await events(handle, sessionId);
    expect(count(log, "side_effect")).toBe(0);
    expect(count(log, "model_call")).toBe(2);
    // Approve after reject is a conflict, never an approval.
    const late = await invoke(handle, sessionId, {
      type: "approval",
      approvalId,
      decision: "approve",
      signature: signApproval(SIGNING_KEY, approvalId, "approve"),
    });
    expect(late.status).toBe(409);
  }, 30_000);

  it("refuses every approval when no approver key is configured", async () => {
    const sessionId = sessionIdFor("hitl-nokey");
    const handle = await server({ APPROVAL_SIGNING_KEY: "" });
    const asked = await invoke(handle, sessionId, { prompt: "[approval]" });
    const { approvalId } = (asked.body as unknown as PendingBody).approvals[0]!;
    const answer = await invoke(handle, sessionId, {
      type: "approval",
      approvalId,
      decision: "approve",
      signature: signApproval(SIGNING_KEY, approvalId, "approve"),
    });
    expect(answer.status).toBe(403);
    const log = await events(handle, sessionId);
    expect(count(log, "approval_decided")).toBe(0);
  }, 30_000);
});
