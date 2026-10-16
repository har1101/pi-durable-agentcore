import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type StorageWrite } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DynamoDbStorage,
  ensureSessionTable,
} from "../src/storage/dynamodb.js";
import { FencedWriterError, LeaseContentionError } from "../src/storage/errors.js";

const context = BACKGROUND_CONTEXT;
const tableName = process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";

const rootWrite: StorageWrite = {
  type: "conversation",
  value: { id: ROOT_CONVERSATION_ID },
};

describe("DynamoDB lease contention", () => {
  beforeAll(async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    await ensureSessionTable(tableName, {
      endpoint: process.env.DYNAMODB_ENDPOINT,
      region: process.env.AWS_REGION,
    });
  });

  afterAll(async () => {
    // leases expire on their own; nothing to tear down
  });

  it("refuses a second live owner and fences the loser after steal", async () => {
    const sessionId = `lease-${randomUUID()}`;
    const holder = await DynamoDbStorage.open({
      tableName,
      sessionId,
      ownerId: "owner-a",
      leaseTtlMs: 30_000,
      acquireTimeoutMs: 1_000,
      acquireRetryMs: 50,
      ensureTable: true,
      endpoint: process.env.DYNAMODB_ENDPOINT,
    });

    try {
      await expect(
        DynamoDbStorage.open({
          tableName,
          sessionId,
          ownerId: "owner-b",
          leaseTtlMs: 30_000,
          acquireTimeoutMs: 400,
          acquireRetryMs: 50,
          endpoint: process.env.DYNAMODB_ENDPOINT,
        }),
      ).rejects.toBeInstanceOf(LeaseContentionError);

      const seq = await holder.commit([rootWrite], context);
      expect(seq).toBeGreaterThan(0);
    } finally {
      await holder.close(context);
    }

    const next = await DynamoDbStorage.open({
      tableName,
      sessionId,
      ownerId: "owner-b",
      leaseTtlMs: 5_000,
      acquireTimeoutMs: 2_000,
      endpoint: process.env.DYNAMODB_ENDPOINT,
    });
    try {
      const conversation = await next.conversation(ROOT_CONVERSATION_ID, context);
      expect(conversation?.id).toBe(ROOT_CONVERSATION_ID);
    } finally {
      await next.close(context);
    }
  });

  it("increments the fencing token on steal and rejects the former owner's commit", async () => {
    const sessionId = `fence-${randomUUID()}`;
    const first = await DynamoDbStorage.open({
      tableName,
      sessionId,
      ownerId: "former-owner",
      leaseTtlMs: 400,
      acquireTimeoutMs: 1_000,
      acquireRetryMs: 40,
      ensureTable: true,
      renewLease: false,
      endpoint: process.env.DYNAMODB_ENDPOINT,
    });
    const firstToken = first.fencingToken;
    expect(firstToken).toBeGreaterThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const stealer = await DynamoDbStorage.open({
      tableName,
      sessionId,
      ownerId: "new-owner",
      leaseTtlMs: 5_000,
      acquireTimeoutMs: 3_000,
      acquireRetryMs: 50,
      endpoint: process.env.DYNAMODB_ENDPOINT,
    });

    try {
      expect(stealer.fencingToken).toBeGreaterThan(firstToken);
      await expect(first.commit([rootWrite], context)).rejects.toBeInstanceOf(
        FencedWriterError,
      );
      const seq = await stealer.commit([rootWrite], context);
      expect(seq).toBeGreaterThan(0);
    } finally {
      await stealer.close(context);
      await first.close(context).catch(() => undefined);
    }
  });
});
