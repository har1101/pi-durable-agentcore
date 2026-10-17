import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDynamoDbDocumentClient,
  dynamoDbClientConfig,
  sessionPk,
} from "../dist/storage/dynamodb.js";
import {
  cleanupTemporaryDirectories,
  startServer,
  waitFor,
  type ServerProcess,
} from "./support/server.js";

const { sweep } = createRequire(import.meta.url)("../infra/resumer/index.cjs") as {
  sweep(options: {
    dynamodb: DynamoDBClient;
    tableName: string;
    invoke(sessionId: string, payload: unknown): Promise<unknown>;
    now?: number;
    claimMs?: number;
  }): Promise<Array<{ sk: string; status: string; response?: any; error?: string }>>;
};

afterEach(cleanupTemporaryDirectories);

const tableName = process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";
const dynamodb = new DynamoDBClient(
  dynamoDbClientConfig({ endpoint: process.env.DYNAMODB_ENDPOINT }),
);
const docs = createDynamoDbDocumentClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
const fastWake = { PI_WAKE_GRACE_MS: "3000" };

async function wakeItem(sessionId: string): Promise<Record<string, any> | undefined> {
  const result = await docs.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: "WAKE", sk: sessionPk(sessionId) },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

/** Plays AgentCore: InvokeAgentRuntime with the stored session id reaches `server`. */
function sweepInto(server: ServerProcess, sessionId: string, now = Date.now()) {
  return sweep({
    dynamodb,
    tableName,
    now,
    claimMs: 30_000,
    invoke: async (runtimeSessionId, payload) => {
      if (runtimeSessionId !== sessionId) return { skipped: true };
      return (await server.invoke(payload)).body;
    },
  }).then((results) => results.filter((result) => result.sk === sessionPk(sessionId)));
}

/** Runs the resumer once a second, as the schedule would, until it invokes the session. */
async function sweepUntilInvoked(server: ServerProcess, sessionId: string) {
  return waitFor(async () => {
    const [result] = await sweepInto(server, sessionId);
    if (result?.status === "invoked") return result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return undefined;
  }, `a due wake for ${sessionId}`, 30_000);
}

describe("automatic resume without a client request", () => {
  it("recovers mid-flight work after SIGKILL when the caller is gone", async () => {
    const sessionId = `auto-crash-${randomUUID()}`;
    const first = await startServer(sessionId, { ...fastWake, SCRIPTED_TOOL_DELAY_MS: "20000" });
    const abandoned = first.invoke({ prompt: "Do slow work.", requestId: "crash-1" }).catch(() => undefined);
    await waitFor(
      async () => (await first.events()).some((event) => event.kind === "tool_call_started"),
      "the tool to start",
    );
    const inFlight = await waitFor(async () => {
      const item = await wakeItem(sessionId);
      return item?.reason === "in_flight" ? item : undefined;
    }, "an in_flight wake item");
    expect(inFlight.runtimeSessionId).toBe(sessionId);
    await first.kill("SIGKILL");
    await abandoned;

    const replacement = await startServer(sessionId, { ...fastWake, SCRIPTED_TOOL_DELAY_MS: "50" });
    try {
      expect(await sweepInto(replacement, sessionId)).toEqual([]);
      const lastPlan = await wakeItem(sessionId);
      expect(lastPlan).toMatchObject({ reason: "in_flight" });
      await waitFor(
        async () => Date.now() > lastPlan!.dueAt,
        "the in_flight grace to pass",
      );
      const now = Date.now();
      const raced = await Promise.all([
        sweepInto(replacement, sessionId, now),
        sweepInto(replacement, sessionId, now),
      ]);
      const invoked = raced.flat().filter((result) => result.status === "invoked");
      expect(invoked).toHaveLength(1);
      expect(invoked[0]?.response).toMatchObject({
        status: "success",
        requestId: "crash-1",
        response: "Finished after the durable tool checkpoint was committed.",
      });
      expect(await wakeItem(sessionId)).toBeUndefined();

      const events = await replacement.events();
      const attempts = events.filter((event) => event.kind === "tool_attempt");
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map((event) => event.detail.idempotencyKey)).size).toBe(1);
      expect(events.filter((event) => event.kind === "model_response")).toHaveLength(2);
      expect(events.some((event) => event.kind === "resume_invoked")).toBe(true);
    } finally {
      await replacement.kill("SIGTERM");
    }
  }, 60_000);

  it("auto-rejects an approval at its deadline and continues the run", async () => {
    const sessionId = `auto-timeout-${randomUUID()}`;
    const token = `approver-${randomUUID()}`;
    const env = {
      ...fastWake,
      APPROVAL_TIMEOUT_MS: "3000",
      APPROVER_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
    };
    const first = await startServer(sessionId, env);
    const pending = await first.invoke({ prompt: "[approval] deploy", requestId: "timeout-1" });
    expect(pending.body).toMatchObject({ status: "pending", reason: "approval_required" });
    const deadline = Date.parse(pending.body.expiresAt);
    expect(await wakeItem(sessionId)).toMatchObject({ reason: "approval_deadline", dueAt: deadline });
    await first.kill("SIGKILL");

    const replacement = await startServer(sessionId, env);
    try {
      expect(await sweepInto(replacement, sessionId, deadline - 1)).toEqual([]);
      const result = await sweepUntilInvoked(replacement, sessionId);
      expect(Date.now()).toBeGreaterThanOrEqual(deadline);
      expect(result.response).toMatchObject({ status: "success", requestId: "timeout-1" });
      expect(result.response.response).toContain("was rejected (timeout); approved_action did not run.");
      expect(await wakeItem(sessionId)).toBeUndefined();

      const late = await replacement.invoke(
        { action: "decide", approvalId: pending.body.approvalId, decision: "approve", approverToken: token },
      );
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({
        outcome: "already_decided",
        approval: { status: "rejected", decidedBy: "timeout" },
      });
      const events = await replacement.events();
      expect(events.filter((event) => event.kind === "side_effect")).toHaveLength(0);
      expect(events.filter((event) => event.kind === "model_response")).toHaveLength(2);
    } finally {
      await replacement.kill("SIGTERM");
    }
  }, 60_000);

  it("resumes a timed wait at its wake time on a new process", async () => {
    const sessionId = `auto-timer-${randomUUID()}`;
    const env = { ...fastWake, SCRIPTED_WAIT_SECONDS: "4" };
    const first = await startServer(sessionId, env);
    const pending = await first.invoke({ prompt: "[timer] wait a bit", requestId: "timer-1" });
    expect(pending.body).toMatchObject({ status: "pending", reason: "timer" });
    const wakeAt = Date.parse(pending.body.wakeAt);
    expect(await wakeItem(sessionId)).toMatchObject({ reason: "timer", dueAt: wakeAt });
    await first.kill("SIGKILL");

    const replacement = await startServer(sessionId, env);
    try {
      expect(await sweepInto(replacement, sessionId, wakeAt - 1)).toEqual([]);
      const result = await sweepUntilInvoked(replacement, sessionId);
      expect(Date.now()).toBeGreaterThanOrEqual(wakeAt);
      expect(result.response).toMatchObject({
        status: "success",
        requestId: "timer-1",
        response: `Finished: Waited until ${new Date(wakeAt).toISOString()}.`,
      });
      expect(await wakeItem(sessionId)).toBeUndefined();
      const events = await replacement.events();
      expect(events.filter((event) => event.kind === "timer_scheduled")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "timer_fired")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "model_response")).toHaveLength(2);
    } finally {
      await replacement.kill("SIGTERM");
    }
  }, 60_000);

  it("keeps racing resumers idempotent within and across processes", async () => {
    const sessionId = `auto-race-${randomUUID()}`;
    const env = { ...fastWake, SCRIPTED_TOOL_DELAY_MS: "1500" };
    const owner = await startServer(sessionId, env);
    const rival = await startServer(sessionId, { ...env, PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS: "500" });
    try {
      const abandoned = owner.invoke({ prompt: "Do work.", requestId: "race-1" });
      await waitFor(
        async () => (await owner.events()).some((event) => event.kind === "tool_call_started"),
        "the tool to start",
      );
      const [a, b, c] = await Promise.all([
        owner.invoke({ action: "resume" }),
        owner.invoke({ action: "resume" }),
        rival.invoke({ action: "resume" }),
      ]);
      expect(a.body).toMatchObject({ status: "success", requestId: "race-1" });
      expect(b.body).toEqual(a.body);
      expect(c.status).toBe(409);
      expect((await abandoned).body).toEqual(a.body);
      const idle = await owner.invoke({ action: "resume" });
      expect(idle.body).toMatchObject({ status: "idle", sessionId });
      const attempts = (await owner.events()).filter((event) => event.kind === "tool_attempt");
      expect(attempts).toHaveLength(1);
    } finally {
      await owner.kill("SIGTERM");
      await rival.kill("SIGTERM");
    }
  }, 60_000);
});
