import { createHash, randomUUID } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { effectPartition } from "../dist/effects.js";
import { createDynamoDbDocumentClient } from "../dist/storage/dynamodb.js";
import { cleanupTemporaryDirectories, startServer } from "./support/server.js";

afterEach(cleanupTemporaryDirectories);

const approverToken = `approver-${randomUUID()}`;
const approverEnv = {
  APPROVER_TOKEN_SHA256: createHash("sha256").update(approverToken).digest("hex"),
};
const asApprover = { approverToken };

async function effectCount(idempotencyKey: string): Promise<number> {
  const docs = createDynamoDbDocumentClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
  const page = await docs.send(
    new QueryCommand({
      TableName: process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": effectPartition(idempotencyKey) },
      ConsistentRead: true,
    }),
  );
  return page.Items?.length ?? 0;
}

describe("human approval that leaves the process", () => {
  it("returns pending, survives SIGKILL, and resumes on a new process after an explicit approval", async () => {
    const sessionId = `approval-${randomUUID()}`;
    const first = await startServer(sessionId, approverEnv);
    const pending = await first.invoke({
      prompt: "[approval] deploy the release",
      requestId: "approval-1",
    });
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      status: "pending",
      reason: "approval_required",
      requestId: "approval-1",
      sessionId,
    });
    expect(pending.body.approvalId).toMatch(/^apr_[0-9a-f]{32}$/);
    expect(Object.keys(pending.body).sort()).toEqual(
      ["approvalId", "expiresAt", "reason", "requestId", "response", "sessionId", "status"].sort(),
    );
    expect(JSON.stringify(pending.body)).not.toContain(approverToken);
    const approvalId: string = pending.body.approvalId;

    const firstAttempt = (await first.events()).find((event) => event.kind === "tool_attempt");
    const key: string = firstAttempt?.detail.idempotencyKey;
    expect(await effectCount(key)).toBe(0);
    await first.kill("SIGKILL");

    const second = await startServer(sessionId, approverEnv);
    try {
      const decide = (decision: unknown, credentials: Record<string, unknown> = asApprover) =>
        second.invoke({ action: "decide", approvalId, decision, ...credentials });

      expect((await decide("approve", {})).status).toBe(403);
      expect(
        (
          await decide("approve", { approverToken: approvalId })
        ).status,
      ).toBe(403);
      for (const ambiguous of ["yes", "APPROVE", "approved", true, 1, null]) {
        expect((await decide(ambiguous)).status).toBe(400);
      }
      expect(
        (await second.invoke({ action: "decide", approvalId: "apr_" + "0".repeat(32), decision: "approve", ...asApprover }))
          .status,
      ).toBe(404);
      expect(await effectCount(key)).toBe(0);

      const approved = await decide("approve");
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({
        outcome: "decided",
        approval: { id: approvalId, status: "approved", decidedBy: "approver" },
        result: {
          status: "success",
          requestId: "approval-1",
          response: "Finished: Action deploy applied (applied).",
        },
      });
      expect(await effectCount(key)).toBe(1);

      const repeated = await decide("approve");
      expect(repeated.status).toBe(200);
      expect(repeated.body.outcome).toBe("already_decided");
      const conflicting = await decide("reject");
      expect(conflicting.status).toBe(409);

      const retried = await second.invoke({
        prompt: "[approval] deploy the release",
        requestId: "approval-1",
      });
      expect(retried.body).toMatchObject({
        status: "success",
        response: "Finished: Action deploy applied (applied).",
      });

      const events = await second.events();
      const attempts = events.filter((event) => event.kind === "tool_attempt");
      expect(attempts.map((event) => event.detail.idempotencyKey)).toEqual([key, key]);
      expect(new Set(attempts.map((event) => event.pid)).size).toBe(2);
      expect(events.filter((event) => event.kind === "model_response")).toHaveLength(2);
      expect(events.filter((event) => event.kind === "side_effect")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(approverToken);
    } finally {
      await second.kill("SIGTERM");
    }
  });

  it("continues in the same process after a rejection without running the action", async () => {
    const sessionId = `reject-${randomUUID()}`;
    const server = await startServer(sessionId, approverEnv);
    try {
      const pending = await server.invoke({ prompt: "[approval] drop the table", requestId: "reject-1" });
      expect(pending.body.status).toBe("pending");
      const rejected = await server.invoke(
        { action: "decide", approvalId: pending.body.approvalId, decision: "reject", ...asApprover },
      );
      expect(rejected.body).toMatchObject({
        outcome: "decided",
        approval: { status: "rejected", decidedBy: "approver" },
        result: { status: "success", requestId: "reject-1" },
      });
      expect(rejected.body.result.response).toContain("was rejected (approver); approved_action did not run.");
      const events = await server.events();
      expect(events.filter((event) => event.kind === "side_effect")).toHaveLength(0);
      expect(events.filter((event) => event.kind === "tool_attempt")).toHaveLength(1);
    } finally {
      await server.kill("SIGTERM");
    }
  });

  it("refuses every decision when no approver token digest is configured", async () => {
    const sessionId = `no-approver-${randomUUID()}`;
    const server = await startServer(sessionId, { APPROVER_TOKEN_SHA256: "" });
    try {
      const pending = await server.invoke({ prompt: "[approval] deploy", requestId: "noauth-1" });
      const attempt = await server.invoke(
        { action: "decide", approvalId: pending.body.approvalId, decision: "approve", ...asApprover },
      );
      expect(attempt.status).toBe(403);
    } finally {
      await server.kill("SIGTERM");
    }
  });
});
