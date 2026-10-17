import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  count,
  events,
  ping,
  post,
  Scenario,
  sleepUntil,
  until,
  type ServerProcess,
} from "./support/processes.js";

const scenarios: Scenario[] = [];
afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});
function scenario(): Scenario {
  const created = new Scenario();
  scenarios.push(created);
  return created;
}

async function settled(server: ServerProcess, sessionId: string) {
  return until(
    async () => {
      const log = await events(server, sessionId);
      return count(log, "run_settled") > 0 ? log : undefined;
    },
    20_000,
    "run_settled",
  );
}

async function startLongRun(server: ServerProcess, sessionId: string) {
  void post(server, sessionId, { prompt: "Long tool.", requestId: "r-crash" }).catch(
    () => undefined,
  );
  await until(
    async () => count(await events(server, sessionId), "tool_call_started") > 0 || undefined,
    15_000,
    "tool_call_started",
  );
}

describe("automatic resume through the wake sweeper", () => {
  it("finishes a run whose process was SIGKILLed mid-tool, with no client request", async () => {
    const s = scenario();
    const sessionId = `crash-${randomUUID()}`;
    const first = await s.server({ SCRIPTED_TOOL_DELAY_MS: "10000" });
    await startLongRun(first, sessionId);

    expect((await s.sweep(first)).outcomes[sessionId]).toBe("live");
    expect(count(await events(first, sessionId), "resume_called")).toBe(1);

    await first.kill("SIGKILL");
    const second = await s.server({ SCRIPTED_TOOL_DELAY_MS: "50" });
    await until(
      async () => ((await s.sweep(second)).outcomes[sessionId] === "accepted" ? true : undefined),
      15_000,
      "the sweeper to resume the session once the dead lease lapses",
    );
    const log = await settled(second, sessionId);

    const attempts = log.filter((event) => event.kind === "tool_attempt");
    expect(attempts.map((event) => event.pid)).toEqual([first.pid, second.pid]);
    const [key, again] = attempts.map((event) => event.detail?.idempotencyKey);
    expect(key).toMatch(/^tk1_[0-9a-f]{64}$/);
    expect(again).toBe(key);
    expect((await s.sweep(second)).outcomes[sessionId]).toBeUndefined();

    const fetched = await post(second, sessionId, { prompt: "Long tool.", requestId: "r-crash" });
    expect(fetched.body).toMatchObject({
      status: "success",
      response: "Finished after the durable tool checkpoint was committed.",
    });
    expect(count(await events(second, sessionId), "tool_attempt")).toBe(2);
  });

  it("rejects an approval at its deadline through the sweeper while the original process is dead", async () => {
    const s = scenario();
    const sessionId = `timeout-${randomUUID()}`;
    const env = { APPROVER_USER_IDS: "alice", PI_APPROVAL_TIMEOUT_MS: "2000" };
    const first = await s.server(env);
    const pending = await post(first, sessionId, {
      prompt: "Publish the Q3 report [approval]",
      requestId: "r-timeout",
    });
    const [item] = pending.body.pending as Array<{ approvalId: string; deadline: string }>;
    expect((await s.sweep(first)).outcomes[sessionId]).toBeUndefined();

    await first.kill("SIGKILL");
    const second = await s.server(env);
    await sleepUntil(Date.parse(item!.deadline) + 50);
    expect((await s.sweep(second)).outcomes[sessionId]).toBe("accepted");
    const log = await settled(second, sessionId);

    expect(count(log, "approval_timed_out")).toBe(1);
    expect(count(log, "gated_action")).toBe(0);
    expect(count(log, "tool_attempt")).toBe(0);
    const fetched = await post(second, sessionId, {
      prompt: "Publish the Q3 report [approval]",
      requestId: "r-timeout",
    });
    expect(fetched.body.status).toBe("success");
    expect(String(fetched.body.response)).toContain("approval timed out");

    const late = await post(
      second,
      sessionId,
      { action: "decide", approvalId: item!.approvalId, decision: "approve" },
      { "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": "alice" },
    );
    expect(late.status).toBe(409);
    expect(late.body).toEqual({
      status: "error",
      reason: "expired",
      decision: "reject",
      decidedBy: "timeout",
    });
  });

  it("continues a timed wait once it is due, and a sweep before then does nothing", async () => {
    const s = scenario();
    const sessionId = `timer-${randomUUID()}`;
    const server = await s.server();
    const pending = await post(server, sessionId, {
      prompt: "Wait a moment [wait 2]",
      requestId: "r-timer",
    });
    expect(pending.body).toMatchObject({
      status: "pending",
      pending: [{ kind: "timer", tool: "wait_until", summary: 'wait_until {"seconds":2}' }],
    });
    const [item] = pending.body.pending as Array<Record<string, string>>;
    expect(item).not.toHaveProperty("approvalId");

    expect(await s.sweep(server)).toMatchObject({ outcomes: {} });
    expect(await ping(server)).toBe("Healthy");
    expect(count(await events(server, sessionId), "runtime_opened")).toBe(1);

    await sleepUntil(Date.parse(item!.deadline!) + 50);
    expect((await s.sweep(server)).outcomes[sessionId]).toBe("accepted");
    const log = await settled(server, sessionId);
    expect(count(log, "model_call")).toBe(2);
    expect(count(log, "tool_attempt")).toBe(1);

    const fetched = await post(server, sessionId, {
      prompt: "Wait a moment [wait 2]",
      requestId: "r-timer",
    });
    expect(fetched.body).toMatchObject({ status: "success", response: "Finished: waited 2s" });
  });

  it("lets exactly one of two racing resumers drive a crashed run", async () => {
    const s = scenario();
    const sessionId = `race-${randomUUID()}`;
    const first = await s.server({ SCRIPTED_TOOL_DELAY_MS: "10000" });
    await startLongRun(first, sessionId);
    await first.kill("SIGKILL");

    const env = { SCRIPTED_TOOL_DELAY_MS: "500", PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS: "6000" };
    const [left, right] = await Promise.all([s.server(env), s.server(env)]);
    const replies = await Promise.all(
      [left, right].map((server) => post(server, sessionId, { action: "resume" })),
    );
    const outcomes = replies.map((reply) => `${reply.status} ${String(reply.body.status)}`);
    expect(outcomes).toContain("202 accepted");
    expect(outcomes.filter((outcome) => outcome === "202 accepted")).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome === "409 busy" || outcome === "200 idle")).toBe(
      true,
    );

    const log = await settled(left, sessionId);
    const winner = replies[0]!.status === 202 ? left : right;
    expect(log.filter((event) => event.kind === "tool_attempt").map((event) => event.pid)).toEqual([
      first.pid,
      winner.pid,
    ]);
  });
});
