import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { dynamoDbClientConfig, ensureSessionTable } from "../dist/storage/dynamodb.js";
import {
  count,
  events,
  ping,
  post,
  Scenario,
  until,
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

describe("durable event log", () => {
  it("serves /events from DynamoDB without opening the runtime, including a killed process's events", async () => {
    const s = scenario();
    const sessionId = `events-${randomUUID()}`;
    const writer = await s.server({ SCRIPTED_TOOL_DELAY_MS: "10000" });
    const reader = await s.server();

    void post(writer, sessionId, { prompt: "Run the long tool." }).catch(
      () => undefined,
    );
    await until(
      async () =>
        (await events(reader, sessionId)).some(
          (event) => event.kind === "tool_attempt" && event.pid === writer.pid,
        ) || undefined,
      15_000,
      "the writer's tool_attempt via the reader",
    );
    expect(await ping(reader)).toBe("Healthy");

    await writer.kill("SIGKILL");
    const afterKill = await events(reader, sessionId);
    expect(afterKill.every((event) => event.pid === writer.pid)).toBe(true);
    expect(count(afterKill, "tool_attempt")).toBe(1);
    expect(
      afterKill.some(
        (event) =>
          event.kind === "runtime_opened" && event.detail?.storage === "dynamodb",
      ),
    ).toBe(true);
    expect(afterKill.map((event) => event.position)).toEqual(
      afterKill.map((_, index) => index + 1),
    );
  });
});

describe("tool idempotency keys", () => {
  it("gives each tool use its own key even when the provider reuses call id durable-wait-1 across processes", async () => {
    const s = scenario();
    const sessionId = `keys-${randomUUID()}`;
    const first = await s.server();
    expect(
      (await post(first, sessionId, { prompt: "One.", requestId: "r1" })).body,
    ).toMatchObject({ status: "success" });
    await first.kill("SIGTERM");
    const second = await s.server();
    expect(
      (await post(second, sessionId, { prompt: "Two.", requestId: "r2" })).body,
    ).toMatchObject({ status: "success" });

    const attempts = (await events(second, sessionId)).filter(
      (event) => event.kind === "tool_attempt",
    );
    expect(attempts.map((event) => event.pid)).toEqual([first.pid, second.pid]);
    expect(attempts.map((event) => event.detail?.callId)).toEqual([
      "durable-wait-1",
      "durable-wait-1",
    ]);
    const keys = attempts.map((event) => String(event.detail?.idempotencyKey));
    for (const key of keys) {
      expect(key).toMatch(/^tk1_[0-9a-f]{64}$/);
      expect(key).not.toContain(sessionId);
    }
    expect(new Set(keys).size).toBe(2);
    expect(second.output()).toContain(`"idempotencyKey":"${keys[1]}"`);
  });
});

describe("session table on DynamoDB Local", () => {
  it("adds WakeIndex to an existing table that lacks it", async () => {
    const tableName = `legacy-${randomUUID()}`;
    const client = new DynamoDBClient(dynamoDbClientConfig());
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
    await ensureSessionTable(tableName);
    const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
    expect(Table?.GlobalSecondaryIndexes?.map((index) => index.IndexName)).toEqual([
      "WakeIndex",
    ]);
  });
});
