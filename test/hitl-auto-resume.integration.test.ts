import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlStore } from "../src/control-store.js";
import {
  approverToken,
  autoResumeLambdaSource,
  events,
  invoke,
  loadAutoResumeLambda,
  ofKind,
  sleep,
  startServer,
  status,
  sweep,
  waitFor,
  type RunningServer,
} from "./helpers.js";

const temporaryDirectories: string[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.kill()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function server(env: Record<string, string> = {}): Promise<RunningServer> {
  const state = await mkdtemp(join(tmpdir(), "pi-hitl-"));
  temporaryDirectories.push(state);
  const started = await startServer(state, env);
  servers.push(started);
  return started;
}

function completion(rows: Awaited<ReturnType<typeof events>>, requestId: string) {
  return ofKind(rows, "invocation_completed").filter(
    (row) => row.detail.requestId === requestId,
  );
}

describe("human in the loop that leaves the process", () => {
  it("returns a pending approval, then an approver resumes it on a new process", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const sessionId = `hitl-approve-${randomUUID()}`;
    const first = await server();

    const pending = await invoke(first, sessionId, {
      prompt: "[approval] Deploy the change.",
      requestId: "hitl-1",
    });
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      status: "pending_approval",
      requestId: "hitl-1",
      approval: { toolName: "guarded_action" },
    });
    const approvalId = (pending.body.approval as { approvalId: string }).approvalId;
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
    // The requester never receives anything that can approve the action.
    const token = approverToken(sessionId, approvalId);
    expect(pending.text).not.toContain(token);
    expect(pending.text).not.toMatch(/token/i);

    // The invocation returned and the process no longer holds the work.
    expect(await (await fetch(`${first.url}/ping`)).json()).toEqual({ status: "Healthy" });
    const parked = await status(first, sessionId);
    expect(parked.wake).toMatchObject({ armed: true, reason: "approval", approvalId });
    expect(parked.approvals).toMatchObject([{ approvalId, status: "pending" }]);

    // New prompts do not sneak past a pending approval.
    const blocked = await invoke(first, sessionId, { prompt: "Something else" });
    expect(blocked.body).toMatchObject({
      status: "pending_approval",
      reason: "session_suspended",
    });

    // The microVM is replaced: nothing in this process survives.
    await first.kill();
    const second = await server();

    const invalidAnswers: unknown[] = ["yes", "APPROVE", "approved", true, 1, null, ["approve"]];
    for (const decision of invalidAnswers) {
      const reply = await invoke(second, sessionId, {
        approval: { approvalId, decision, approverToken: token },
      });
      expect(reply.status, JSON.stringify(decision)).toBe(400);
    }
    const missingDecision = await invoke(second, sessionId, {
      approval: { approvalId, approverToken: token },
    });
    expect(missingDecision.status).toBe(400);
    const noToken = await invoke(second, sessionId, {
      approval: { approvalId, decision: "approve" },
    });
    expect(noToken.status).toBe(403);
    const otherSessionToken = await invoke(second, sessionId, {
      approval: {
        approvalId,
        decision: "approve",
        approverToken: approverToken(`${sessionId}-other`, approvalId),
      },
    });
    expect(otherSessionToken.status).toBe(403);
    expect((await status(second, sessionId)).approvals[0]?.status).toBe("pending");

    const approved = await invoke(second, sessionId, {
      approval: { approvalId, decision: "approve", approverToken: token },
    });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body).toMatchObject({
      status: "success",
      requestId: "hitl-1",
      decision: { approvalId, status: "approved" },
    });
    expect(approved.body.response).toContain('APPROVED and performed "deploy-change"');

    const rows = await events(second, sessionId);
    // Durable event log: the first (killed) process's events are still there.
    expect(new Set(rows.map((row) => row.pid)).size).toBeGreaterThanOrEqual(2);
    // The model call that asked for the tool ran once; resume made only the next one.
    expect(ofKind(rows, "model_response").map((row) => row.detail.toolCalls)).toEqual([
      ["guarded_action"],
      [],
    ]);
    const attempts = ofKind(rows, "tool_attempt");
    expect(attempts.map((row) => row.detail.phase)).toEqual([
      "approval_check",
      "approval_check",
    ]);
    expect(new Set(attempts.map((row) => row.detail.idempotencyKey)).size).toBe(1);
    expect(attempts[0]?.detail.idempotencyKey).toMatch(/^tk_[0-9a-f]{64}$/);
    expect(JSON.stringify(attempts.map((row) => row.detail))).not.toContain(sessionId);
    expect(ofKind(rows, "effect_performed")).toHaveLength(1);
    expect(completion(rows, "hitl-1")).toHaveLength(1);

    // A repeated approval is idempotent: nothing runs again.
    const again = await invoke(second, sessionId, {
      approval: { approvalId, decision: "approve", approverToken: token },
    });
    expect(again.body).toMatchObject({ status: "idle" });
    const reject = await invoke(second, sessionId, {
      approval: { approvalId, decision: "reject", approverToken: token },
    });
    expect(reject.status).toBe(409);
    expect(ofKind(await events(second, sessionId), "effect_performed")).toHaveLength(1);
    expect((await status(second, sessionId)).wake.armed).toBe(false);
  }, 60_000);

  it("a rejection continues the run without performing the action", async () => {
    const sessionId = `hitl-reject-${randomUUID()}`;
    const first = await server();
    const pending = await invoke(first, sessionId, {
      prompt: "[approval] Deploy the change.",
      requestId: "hitl-reject-1",
    });
    const approvalId = (pending.body.approval as { approvalId: string }).approvalId;
    const rejected = await invoke(first, sessionId, {
      approval: {
        approvalId,
        decision: "reject",
        approverToken: approverToken(sessionId, approvalId),
        reason: "change freeze",
      },
    });
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.body).toMatchObject({
      status: "success",
      decision: { status: "rejected" },
    });
    expect(rejected.body.response).toContain("REJECTED (approver: change freeze)");
    const rows = await events(first, sessionId);
    expect(ofKind(rows, "effect_performed")).toHaveLength(0);
    expect(ofKind(rows, "model_response")).toHaveLength(2);
  }, 60_000);
});

describe("automatic resume without a client request", () => {
  it("auto-rejects an approval after its deadline and continues the run", async () => {
    const sessionId = `hitl-timeout-${randomUUID()}`;
    const first = await server({ PI_APPROVAL_TIMEOUT_MS: "1500" });
    const pending = await invoke(first, sessionId, {
      prompt: "[approval] Deploy the change.",
      requestId: "timeout-1",
    });
    expect(pending.body.status).toBe("pending_approval");
    const approvalId = (pending.body.approval as { approvalId: string }).approvalId;
    await first.kill();
    const second = await server({ PI_APPROVAL_TIMEOUT_MS: "1500" });
    const route = (id: string) => (id === sessionId ? second : undefined);

    const calls: { sessionId: string; payload: unknown; status: number }[] = [];
    await sweep(route, calls);
    expect(calls).toHaveLength(0); // not due yet

    const { wake } = await status(second, sessionId);
    await sleep(Math.max(0, (wake.dueAt ?? 0) - Date.now()) + 50);
    await sweep(route, calls);
    expect(calls).toEqual([
      { sessionId, payload: { action: "resume", reason: "approval" }, status: 200 },
    ]);

    const done = await waitFor(
      async () => completion(await events(second, sessionId), "timeout-1")[0],
      15_000,
      "timeout completion",
    );
    expect(done.detail.response).toContain("REJECTED (timeout: approval timed out)");
    const after = await status(second, sessionId);
    expect(after.approvals[0]).toMatchObject({ status: "rejected", decidedBy: "timeout" });
    expect(after.wake.armed).toBe(false);

    // Too late for a human: the deadline decided.
    const late = await invoke(second, sessionId, {
      approval: {
        approvalId,
        decision: "approve",
        approverToken: approverToken(sessionId, approvalId),
      },
    });
    expect(late.status).toBe(409);
    expect(ofKind(await events(second, sessionId), "effect_performed")).toHaveLength(0);
  }, 60_000);

  it("resumes a timed wait at its due time", async () => {
    const sessionId = `timer-${randomUUID()}`;
    const first = await server();
    const waiting = await invoke(first, sessionId, {
      prompt: "Follow up later [wait:2]",
      requestId: "timer-1",
    });
    expect(waiting.body).toMatchObject({ status: "waiting", requestId: "timer-1" });
    const resumeAt = Date.parse(String(waiting.body.resumeAt));
    expect(resumeAt).toBeGreaterThan(Date.now());

    const calls: { sessionId: string; payload: unknown; status: number }[] = [];
    const route = (id: string) => (id === sessionId ? first : undefined);
    await sweep(route, calls);
    expect(calls).toHaveLength(0);

    await sleep(resumeAt - Date.now() + 50);
    await sweep(route, calls);
    expect(calls).toHaveLength(1);
    const done = await waitFor(
      async () => completion(await events(first, sessionId), "timer-1")[0],
      15_000,
      "timer completion",
    );
    expect(done.detail.response).toMatch(/^Finished: Resumed at /);
    const rows = await events(first, sessionId);
    expect(ofKind(rows, "tool_attempt").map((row) => row.detail.due)).toEqual([false, true]);
    expect(ofKind(rows, "model_response")).toHaveLength(2);
  }, 60_000);

  it("recovers a crashed run when the original caller is gone", async () => {
    const sessionId = `orphan-${randomUUID()}`;
    const first = await server({ SCRIPTED_TOOL_DELAY_MS: "20000" });
    // The caller fires and disappears; nobody will retry this request.
    void invoke(first, sessionId, {
      prompt: "Long work with nobody waiting.",
      requestId: "orphan-1",
    }).catch(() => undefined);
    await waitFor(
      async () =>
        ofKind(await events(first, sessionId), "tool_call_started")[0],
      15_000,
      "tool start",
    );
    const running = await status(first, sessionId);
    expect(running.wake).toMatchObject({ armed: true, reason: "running" });
    await first.kill();

    const second = await server();
    const route = (id: string) => (id === sessionId ? second : undefined);
    const calls: { sessionId: string; payload: unknown; status: number }[] = [];
    // The heartbeat stopped with the process; the wake comes due after the grace.
    await waitFor(
      async () => {
        await sweep(route, calls);
        return calls.length > 0 ? true : undefined;
      },
      15_000,
      "crash wake to come due",
    );
    expect(calls[0]).toMatchObject({ payload: { action: "resume", reason: "running" }, status: 200 });

    const done = await waitFor(
      async () => completion(await events(second, sessionId), "orphan-1")[0],
      20_000,
      "orphan completion",
    );
    expect(done.detail.response).toBe(
      "Finished after the durable tool checkpoint was committed.",
    );
    const rows = await events(second, sessionId);
    const attempts = ofKind(rows, "tool_attempt");
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((row) => row.detail.idempotencyKey)).size).toBe(1);
    expect(ofKind(rows, "model_response")).toHaveLength(2);
    expect((await status(second, sessionId)).wake.armed).toBe(false);
  }, 60_000);

  it("lets exactly one of two racing resume invocations do the work", async () => {
    const sessionId = `race-${randomUUID()}`;
    const first = await server();
    const waiting = await invoke(first, sessionId, {
      prompt: "Race me [wait:1]",
      requestId: "race-1",
    });
    expect(waiting.body.status).toBe("waiting");
    await sleep(Date.parse(String(waiting.body.resumeAt)) - Date.now() + 50);

    // Two resumers on two processes (two microVMs) at once: the DynamoDB lease
    // admits one; the other is told the session is owned.
    const second = await server({ PI_RESUME_ACQUIRE_TIMEOUT_MS: "1500" });
    const third = await server({ PI_RESUME_ACQUIRE_TIMEOUT_MS: "1500" });
    const replies = await Promise.all([
      invoke(second, sessionId, { action: "resume", wait: true }),
      invoke(third, sessionId, { action: "resume", wait: true }),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const winner = replies.find((reply) => reply.status === 200);
    expect(winner?.body).toMatchObject({ status: "success", requestId: "race-1" });

    const rows = await events(second, sessionId);
    expect(completion(rows, "race-1")).toHaveLength(1);
    expect(ofKind(rows, "tool_attempt").filter((row) => row.detail.due === true)).toHaveLength(1);
    expect(ofKind(rows, "model_response")).toHaveLength(2);
  }, 60_000);

  it("claims a due wake once when sweeps race", async () => {
    const sessionId = `race-sweep-${randomUUID()}`;
    const first = await server();
    const waiting = await invoke(first, sessionId, {
      prompt: "Race the sweepers [wait:1]",
      requestId: "race-sweep-1",
    });
    await sleep(Date.parse(String(waiting.body.resumeAt)) - Date.now() + 50);
    const calls: { sessionId: string; payload: unknown; status: number }[] = [];
    const route = (id: string) => (id === sessionId ? first : undefined);
    await Promise.all([sweep(route, calls), sweep(route, calls), sweep(route, calls)]);
    expect(calls).toHaveLength(1);
    await waitFor(
      async () => completion(await events(first, sessionId), "race-sweep-1")[0],
      15_000,
      "completion",
    );
    expect(ofKind(await events(first, sessionId), "model_response")).toHaveLength(2);
  }, 60_000);
});

describe("stuck-state recovery", () => {
  it("resumes via the sweeper when a recorded decision never resumed the run", async () => {
    const sessionId = `decided-${randomUUID()}`;
    const first = await server();
    const pending = await invoke(first, sessionId, {
      prompt: "[approval] Deploy the change.",
      requestId: "decided-1",
    });
    const approvalId = (pending.body.approval as { approvalId: string }).approvalId;
    await first.kill();
    // The approver request recorded the decision and died before resuming.
    const control = await ControlStore.open(sessionId);
    expect((await control.decide(approvalId, "approve", { now: Date.now() })).outcome).toBe(
      "recorded",
    );
    await control.expediteWake(Date.now());

    const second = await server();
    const calls: { sessionId: string; payload: unknown; status: number }[] = [];
    await sweep((id) => (id === sessionId ? second : undefined), calls);
    expect(calls).toHaveLength(1);
    const done = await waitFor(
      async () => completion(await events(second, sessionId), "decided-1")[0],
      15_000,
      "completion",
    );
    expect(done.detail.response).toContain("APPROVED and performed");
  }, 60_000);

  it("dead-letters a wake whose resume keeps failing", async () => {
    const sessionId = `poison-${randomUUID()}`;
    const control = await ControlStore.open(sessionId);
    const start = Date.now();
    await control.armWake({ reason: "running", dueAt: start - 1, fencingToken: 1 });
    const route = (id: string) => (id === sessionId ? { url: "http://127.0.0.1:9" } : undefined);
    const options = { retryMs: 1_000, maxAttempts: 2 };
    await sweep(route, [], { ...options, now: start });
    // A crash heartbeat from the resumed process re-arms but keeps the count.
    await control.armWake({ reason: "running", dueAt: start + 500, fencingToken: 2 });
    expect((await control.getWake()).attempts).toBe(1);
    await sweep(route, [], { ...options, now: start + 1_000 });
    expect((await control.getWake()).attempts).toBe(2);
    await sweep(route, [], { ...options, now: start + 3_000 });
    const wake = await control.getWake();
    expect(wake).toMatchObject({ armed: false, deadLetter: true, attempts: 3 });
  });
});

describe("tool idempotency keys", () => {
  it("differ per tool use even when the provider reuses a call id", async () => {
    const sessionId = `reuse-${randomUUID()}`;
    const first = await server();
    const reply = await invoke(first, sessionId, {
      prompt: "[reuse-call-id] twice",
      requestId: "reuse-1",
    });
    expect(reply.body).toMatchObject({ status: "success" });
    const attempts = ofKind(await events(first, sessionId), "tool_attempt");
    expect(attempts.map((row) => row.detail.callId)).toEqual([
      "reused-call-id",
      "reused-call-id",
    ]);
    const keys = attempts.map((row) => String(row.detail.idempotencyKey));
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).toMatch(/^tk_[0-9a-f]{64}$/);
      expect(key).not.toContain(sessionId);
    }
  }, 30_000);
});

describe("auto-resume Lambda source", () => {
  it("fits the inline ZipFile limit and exports the handler", () => {
    expect(Buffer.byteLength(autoResumeLambdaSource(), "utf8")).toBeLessThan(4096);
    const lambda = loadAutoResumeLambda();
    expect(typeof lambda.handler).toBe("function");
    expect(typeof lambda.sweep).toBe("function");
  });
});
