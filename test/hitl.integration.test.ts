import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  count,
  events,
  ping,
  post,
  Scenario,
  sleepUntil,
  type ServerProcess,
} from "./support/processes.js";

const scenarios: Scenario[] = [];
afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});

const APPROVERS = { APPROVER_USER_IDS: "alice,bob" };
const as = (user: string) => ({
  "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": user,
});

async function setup(extra: Record<string, string> = {}) {
  const scenario = new Scenario();
  scenarios.push(scenario);
  const server = await scenario.server({ ...APPROVERS, ...extra });
  return { scenario, server, sessionId: `hitl-${randomUUID()}` };
}

async function requestApproval(
  server: ServerProcess,
  sessionId: string,
  requester = "carol",
): Promise<string> {
  const reply = await post(
    server,
    sessionId,
    { prompt: "Publish the Q3 report [approval]", requestId: "r-approval" },
    as(requester),
  );
  expect(reply.status).toBe(200);
  expect(reply.body.status).toBe("pending");
  const pending = reply.body.pending as Array<{ approvalId: string }>;
  return pending[0]!.approvalId;
}

const decide = (
  server: ServerProcess,
  sessionId: string,
  approvalId: string,
  decision: unknown,
  user = "alice",
) => post(server, sessionId, { action: "decide", approvalId, decision }, as(user));

describe("human approval that leaves the process", () => {
  it("returns pending with an approval id and no secret, then approves on the same session", async () => {
    const { server, sessionId } = await setup();
    const reply = await post(
      server,
      sessionId,
      { prompt: "Publish the Q3 report [approval]", requestId: "r-approval" },
      as("carol"),
    );
    expect(reply.body).toEqual({
      response: "Waiting for approval",
      requestId: "r-approval",
      sessionId,
      status: "pending",
      pending: [
        {
          kind: "approval",
          tool: "publish_report",
          summary: 'publish_report {"title":"Q3"}',
          approvalId: expect.stringMatching(/^apr_[0-9a-f]{32}$/),
          deadline: expect.any(String),
        },
      ],
    });
    expect(await ping(server)).toBe("Healthy");

    const approvalId = (reply.body.pending as Array<{ approvalId: string }>)[0]!
      .approvalId;
    const approved = await decide(server, sessionId, approvalId, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: "success",
      requestId: "r-approval",
      response: "Finished: published Q3",
    });

    const duplicate = await decide(server, sessionId, approvalId, "approve", "bob");
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual(approved.body);
    const reversal = await decide(server, sessionId, approvalId, "reject", "bob");
    expect(reversal.status).toBe(409);
    expect(reversal.body).toEqual({
      status: "error",
      reason: "already_decided",
      decision: "approve",
      decidedBy: "alice",
    });

    const log = await events(server, sessionId);
    expect(count(log, "model_call")).toBe(2);
    expect(count(log, "tool_attempt")).toBe(1);
    expect(count(log, "gated_action")).toBe(1);
  });

  it("approves in a fresh process without re-running the committed model call", async () => {
    const { scenario, server: first, sessionId } = await setup();
    const approvalId = await requestApproval(first, sessionId);
    await first.kill("SIGKILL");

    const second = await scenario.server(APPROVERS);
    const approved = await decide(second, sessionId, approvalId, "approve");
    expect(approved.body).toMatchObject({
      status: "success",
      response: "Finished: published Q3",
    });

    const log = await events(second, sessionId);
    const calls = log.filter((event) => event.kind === "model_call");
    expect(calls.map((event) => event.pid)).toEqual([first.pid, second.pid]);
    expect(count(log, "tool_attempt")).toBe(1);
    expect(log.filter((event) => event.kind === "gated_action").map((e) => e.pid)).toEqual([
      second.pid,
    ]);
  });

  it("never runs the tool on reject", async () => {
    const { server, sessionId } = await setup();
    const approvalId = await requestApproval(server, sessionId);
    const rejected = await decide(server, sessionId, approvalId, "reject");
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("success");
    expect(String(rejected.body.response)).toContain("rejected by approver");

    const log = await events(server, sessionId);
    expect(count(log, "tool_attempt")).toBe(0);
    expect(count(log, "gated_action")).toBe(0);
    expect(count(log, "model_call")).toBe(2);
  });

  it("validates decisions strictly and writes nothing for a refused one", async () => {
    const { server, sessionId } = await setup();
    const approvalId = await requestApproval(server, sessionId);

    for (const decision of ["yes", "APPROVE", "approved", true, 1, null]) {
      const reply = await decide(server, sessionId, approvalId, decision);
      expect(reply.status, String(decision)).toBe(400);
    }
    const missing = await post(
      server,
      sessionId,
      { action: "decide", approvalId },
      as("alice"),
    );
    expect(missing.status).toBe(400);
    const shouting = await decide(server, sessionId, approvalId.toUpperCase(), "approve");
    expect(shouting.status).toBe(400);

    const anonymous = await post(server, sessionId, {
      action: "decide",
      approvalId,
      decision: "approve",
    });
    expect(anonymous.status).toBe(403);
    expect(anonymous.headers.get("x-amzn-errortype")).toBe("AccessDeniedException");
    const stranger = await decide(server, sessionId, approvalId, "approve", "mallory");
    expect(stranger.status).toBe(403);

    const unknown = await decide(server, sessionId, `apr_${"0".repeat(32)}`, "approve");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ status: "error", reason: "unknown_approval" });
    const foreign = await decide(server, `other-${randomUUID()}`, approvalId, "approve");
    expect(foreign.status).toBe(404);

    expect(count(await events(server, sessionId), "approval_decided")).toBe(0);
    const approved = await decide(server, sessionId, approvalId, "approve");
    expect(approved.body).toMatchObject({ status: "success" });
  });

  it("refuses self-approval by the user who started the run", async () => {
    const { server, sessionId } = await setup();
    const approvalId = await requestApproval(server, sessionId, "alice");
    const self = await decide(server, sessionId, approvalId, "approve", "alice");
    expect(self.status).toBe(403);
    expect(self.headers.get("x-amzn-errortype")).toBe("AccessDeniedException");
    const other = await decide(server, sessionId, approvalId, "approve", "bob");
    expect(other.body).toMatchObject({ status: "success" });
  });

  it("lets the deadline win over a late approval", async () => {
    const { server, sessionId } = await setup({ PI_APPROVAL_TIMEOUT_MS: "1500" });
    const reply = await post(
      server,
      sessionId,
      { prompt: "Publish the Q3 report [approval]" },
      as("carol"),
    );
    const [item] = reply.body.pending as Array<{ approvalId: string; deadline: string }>;
    await sleepUntil(Date.parse(item!.deadline) + 100);

    const late = await decide(server, sessionId, item!.approvalId, "approve");
    expect(late.status).toBe(409);
    expect(late.body).toEqual({
      status: "error",
      reason: "expired",
      decision: "reject",
      decidedBy: "timeout",
    });
    expect(count(await events(server, sessionId), "gated_action")).toBe(0);
  });

  it("lets exactly one of a racing approve and reject win", async () => {
    const { server, sessionId } = await setup();
    const approvalId = await requestApproval(server, sessionId);
    const [approve, reject] = await Promise.all([
      decide(server, sessionId, approvalId, "approve", "alice"),
      decide(server, sessionId, approvalId, "reject", "bob"),
    ]);
    expect([approve.status, reject.status].sort()).toEqual([200, 409]);
    const approveWon = approve.status === 200;
    expect(count(await events(server, sessionId), "gated_action")).toBe(approveWon ? 1 : 0);
  });
});
