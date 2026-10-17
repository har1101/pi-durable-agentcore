import * as ddb from "@aws-sdk/client-dynamodb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { signApproval } from "../dist/approvals.js";
import {
  cleanupTemporary,
  count,
  events,
  invoke,
  loadSweeper,
  lowLevelClient,
  runSweeper,
  SIGNING_KEY,
  sessionIdFor,
  startServer,
  TABLE,
  until,
  wakeItem,
  type ServerHandle,
  type Sweep,
} from "./support.js";

const servers: ServerHandle[] = [];
let sweep: Sweep;
let sweeperCode: string;

beforeAll(async () => {
  ({ sweep, source: sweeperCode } = await loadSweeper());
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop("SIGKILL")));
  await cleanupTemporary();
});

async function server(env: Record<string, string> = {}): Promise<ServerHandle> {
  const handle = await startServer(env);
  servers.push(handle);
  return handle;
}

async function dueAt(sessionId: string): Promise<number> {
  const item = await wakeItem(sessionId);
  if (item?.wakeAt?.N === undefined) throw new Error("no wake scheduled");
  return Number(item.wakeAt.N);
}

async function waitUntilDue(sessionId: string): Promise<void> {
  const at = await dueAt(sessionId);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now() + 50)));
}

describe("resume sweeper (the Lambda's inline code)", () => {
  it("fits CloudFormation's inline ZipFile limit and exports sweep + handler", () => {
    expect(sweeperCode.length).toBeLessThan(4096);
    expect(sweeperCode).toContain("exports.sweep");
    expect(sweeperCode).toContain("exports.handler");
    expect(sweeperCode).toContain("InvokeAgentRuntimeCommand");
  });
});

describe("automatic resume without a client request", () => {
  it("(a) recovers work whose process died while nobody retries", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const sessionId = sessionIdFor("auto-crash");
    const first = await server({ SCRIPTED_TOOL_DELAY_MS: "8000", INFLIGHT_GRACE_MS: "2000" });
    // The caller fires the request and goes away.
    const abandoned = invoke(first, sessionId, {
      prompt: "Do slow durable work.",
      requestId: "auto-crash-1",
    }).catch(() => undefined);
    await until(async () =>
      count(await events(first, sessionId), "tool_call_started") > 0 ? true : undefined,
    );
    expect((await wakeItem(sessionId))?.reason?.S).toBe("inflight");
    await first.stop("SIGKILL");
    await abandoned;

    // A new instance exists, but nothing calls it. Not yet due: no resume.
    const second = await server({ INFLIGHT_GRACE_MS: "2000" });
    const early = await runSweeper(sweep, () => second, { wait: true, onlySession: sessionId });
    expect(early.sessions).not.toContain(sessionId);

    await waitUntilDue(sessionId);
    const swept = await runSweeper(sweep, () => second, { wait: true, onlySession: sessionId });
    expect(swept.sessions.filter((id) => id === sessionId)).toHaveLength(1);

    const log = await events(second, sessionId);
    expect(count(log, "resume_invoked")).toBe(1);
    expect(count(log, "tool_attempt")).toBe(2);
    expect(count(log, "model_call")).toBe(2);
    expect(count(log, "tool_call_completed")).toBe(1);
    expect((await wakeItem(sessionId))?.wakeAt).toBeUndefined();

    // The answer was produced without the caller; asking again just reads it.
    const later = await invoke(second, sessionId, {
      prompt: "Do slow durable work.",
      requestId: "auto-crash-1",
    });
    expect(later.body).toMatchObject({
      status: "success",
      response: "Finished after the durable tool checkpoint was committed.",
    });
    expect(count(await events(second, sessionId), "model_call")).toBe(2);
  }, 60_000);

  it("(b) auto-rejects an approval at its deadline and continues", async () => {
    const sessionId = sessionIdFor("auto-approval-timeout");
    const env = { APPROVAL_TIMEOUT_MS: "2500" };
    const first = await server(env);
    const asked = await invoke(first, sessionId, {
      prompt: "[approval:wire-demo-funds]",
      requestId: "auto-approval-1",
    });
    expect(asked.body.status).toBe("pending_approval");
    const { approvalId, deadline } = (
      asked.body as { approvals: Array<{ approvalId: string; deadline: string }> }
    ).approvals[0]!;
    const wake = await wakeItem(sessionId);
    expect(wake?.reason?.S).toBe("approval_deadline");
    expect(Number(wake?.wakeAt?.N)).toBe(Date.parse(deadline));
    await first.stop("SIGTERM");

    const second = await server(env);
    const early = await runSweeper(sweep, () => second, { onlySession: sessionId });
    expect(early.sessions).not.toContain(sessionId);

    await waitUntilDue(sessionId);
    // Like the deployed Lambda: the runtime answers 202 and works in the background.
    const swept = await runSweeper(sweep, () => second, { onlySession: sessionId });
    expect(swept.sessions).toContain(sessionId);
    await until(async () => {
      const log = await events(second, sessionId);
      return log.some(
        (event) => event.kind === "wake_synced" && event.detail.state === "idle",
      ) && count(log, "resume_invoked") === 1
        ? true
        : undefined;
    });

    const log = await events(second, sessionId);
    expect(count(log, "side_effect")).toBe(0);
    expect(count(log, "model_call")).toBe(2);
    expect(log.find((event) => event.kind === "approval_denied")?.detail).toMatchObject({
      approvalId,
      status: "expired",
      decidedBy: "timeout",
    });
    const result = await invoke(second, sessionId, {
      prompt: "[approval:wire-demo-funds]",
      requestId: "auto-approval-1",
    });
    expect(result.body.status).toBe("success");
    expect(String(result.body.response)).toContain(
      "Not executed: wire-demo-funds was not performed because the approval deadline passed without a decision, so it was auto-rejected.",
    );
    // A late approval cannot revive it.
    const late = await invoke(second, sessionId, {
      type: "approval",
      approvalId,
      decision: "approve",
      signature: signApproval(SIGNING_KEY, approvalId, "approve"),
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ approval: { status: "expired" } });
    expect(count(await events(second, sessionId), "model_call")).toBe(2);
  }, 60_000);

  it("(c) resumes a timed wait at its time", async () => {
    const sessionId = sessionIdFor("auto-timer");
    const handle = await server({ INLINE_WAIT_MAX_MS: "500" });
    const started = Date.now();
    const parked = await invoke(handle, sessionId, {
      prompt: "Check again later [wait:3]",
      requestId: "auto-timer-1",
    });
    expect(parked.body.status).toBe("waiting");
    const resumeAt = Date.parse(String(parked.body.resumeAt));
    expect(resumeAt).toBeGreaterThanOrEqual(started + 3000);
    expect(resumeAt).toBeLessThan(started + 6000);
    expect(Date.now()).toBeLessThan(resumeAt);
    const wake = await wakeItem(sessionId);
    expect(wake?.reason?.S).toBe("timer");
    expect(Number(wake?.wakeAt?.N)).toBe(resumeAt);
    expect(await (await fetch(`http://127.0.0.1:${handle.port}/ping`)).json()).toEqual({
      status: "Healthy",
    });

    const early = await runSweeper(sweep, () => handle, { wait: true, onlySession: sessionId });
    expect(early.sessions).not.toContain(sessionId);
    await waitUntilDue(sessionId);
    const swept = await runSweeper(sweep, () => handle, { wait: true, onlySession: sessionId });
    expect(swept.sessions).toContain(sessionId);

    const log = await events(handle, sessionId);
    const fired = log.find((event) => event.kind === "timer_fired");
    expect(fired).toBeDefined();
    expect(Number(fired!.detail.lateMs)).toBeGreaterThanOrEqual(0);
    expect(count(log, "model_call")).toBe(2);
    const result = await invoke(handle, sessionId, {
      prompt: "Check again later [wait:3]",
      requestId: "auto-timer-1",
    });
    expect(result.body).toMatchObject({ status: "success" });
    expect(String(result.body.response)).toContain("Resumed after the timed wait.");
    expect((await wakeItem(sessionId))?.wakeAt).toBeUndefined();
  }, 60_000);

  it("keeps short timed waits in-process without parking", async () => {
    const sessionId = sessionIdFor("inline-timer");
    const handle = await server();
    const result = await invoke(handle, sessionId, { prompt: "[wait:1]" });
    expect(result.body.status).toBe("success");
    expect(String(result.body.response)).toContain("Resumed after the timed wait.");
    expect((await wakeItem(sessionId))?.wakeAt).toBeUndefined();
  }, 30_000);

  it("is idempotent when resumers race", async () => {
    const sessionId = sessionIdFor("auto-race");
    const first = await server({ SCRIPTED_TOOL_DELAY_MS: "8000", INFLIGHT_GRACE_MS: "1500" });
    void invoke(first, sessionId, { prompt: "Race me.", requestId: "race-1" }).catch(
      () => undefined,
    );
    await until(async () =>
      count(await events(first, sessionId), "tool_call_started") > 0 ? true : undefined,
    );
    await first.stop("SIGKILL");
    await waitUntilDue(sessionId);

    // Two sweeps at once claim the session once.
    const invoked: string[] = [];
    const now = Date.now();
    const sweeps = await Promise.all(
      [0, 1].map(() =>
        sweep({
          ddb,
          client: lowLevelClient(),
          table: TABLE,
          index: "wake-index",
          now,
          invoke: async (id) => {
            if (id === sessionId) invoked.push(id);
          },
        }),
      ),
    );
    expect(invoked).toHaveLength(1);
    expect(sweeps.reduce((sum, result) => sum + result.claimed, 0)).toBeGreaterThanOrEqual(1);

    // Two instances get a resume at the same time: the lease admits one owner
    // at a time, and the work runs once.
    const env = { PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS: "4000" };
    const [b, c] = await Promise.all([server(env), server(env)]);
    const answers = await Promise.all(
      [b, c].map((handle) =>
        invoke(handle, sessionId, { type: "resume", reason: "race", wait: true }),
      ),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(["resumed", "busy"]).toContain(answer.body.status);
    }
    expect(answers.some((answer) => answer.body.status === "resumed")).toBe(true);
    const log = await events(b, sessionId);
    expect(count(log, "tool_attempt")).toBe(2);
    expect(count(log, "tool_call_completed")).toBe(1);
    expect(count(log, "model_call")).toBe(2);
    const keys = new Set(
      log.filter((event) => event.kind === "tool_attempt").map((event) => event.detail.idempotencyKey),
    );
    expect(keys.size).toBe(1);
  }, 60_000);

  it("schedules an immediate resume when an instance shuts down mid-work", async () => {
    const sessionId = sessionIdFor("auto-sigterm");
    const handle = await server({ SCRIPTED_TOOL_DELAY_MS: "8000" });
    void invoke(handle, sessionId, { prompt: "Long work." }).catch(() => undefined);
    await until(async () =>
      count(await events(handle, sessionId), "tool_call_started") > 0 ? true : undefined,
    );
    const before = Date.now();
    await handle.stop("SIGTERM");
    const wake = await wakeItem(sessionId);
    expect(wake?.reason?.S).toBe("interrupted");
    expect(Number(wake?.wakeAt?.N)).toBeLessThanOrEqual(Date.now());
    expect(Number(wake?.wakeAt?.N)).toBeGreaterThanOrEqual(before - 1000);
  }, 30_000);
});
