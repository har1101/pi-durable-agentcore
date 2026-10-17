import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { openDynamoDbStorage } from "../dist/storage/dynamodb.js";

const tableName = process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";

registerStorageConformance(
  { describe, expect, it },
  "DynamoDB Local Storage",
  async (use) => {
    const storage = await openDynamoDbStorage({
      tableName,
      sessionId: `conformance-${randomUUID()}`,
      leaseTtlMs: 30_000,
      acquireTimeoutMs: 5_000,
      ensureTable: true,
      endpoint: process.env.DYNAMODB_ENDPOINT,
      region: process.env.AWS_REGION,
    });
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
);
