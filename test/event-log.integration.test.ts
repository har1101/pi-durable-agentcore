import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTemporary,
  count,
  events,
  invoke,
  lowLevelClient,
  sessionIdFor,
  startServer,
  TABLE,
  until,
  type ServerHandle,
} from "./support.js";

const servers: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop("SIGKILL")));
  await cleanupTemporary();
});

async function partitionCount(pk: string, prefix: string): Promise<number> {
  const result = await lowLevelClient().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: prefix } },
      Select: "COUNT",
    }),
  );
  return result.Count ?? 0;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe("durable event log", () => {
  it("survives the process that wrote it and is readable by any instance without the lease", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const sessionId = sessionIdFor("event-log");
    const first = await startServer({ SCRIPTED_TOOL_DELAY_MS: "8000" });
    servers.push(first);
    const reader = await startServer();
    servers.push(reader);

    void invoke(first, sessionId, { prompt: "Work.", requestId: "log-1" }).catch(
      () => undefined,
    );
    // While the first process owns the session, another instance reads its log.
    await until(async () =>
      count(await events(reader, sessionId), "tool_call_started") > 0 ? true : undefined,
    );
    await first.stop("SIGKILL");

    const survived = await events(reader, sessionId);
    expect(count(survived, "runtime_opened")).toBe(1);
    expect(count(survived, "tool_attempt")).toBe(1);
    expect(count(survived, "checkpoint_committed")).toBeGreaterThan(0);

    // The reader instance takes over (after the dead owner's lease) and appends.
    const resumed = await invoke(reader, sessionId, { prompt: "Work.", requestId: "log-1" });
    expect(resumed.body.status).toBe("success");
    const log = await events(reader, sessionId);
    expect(count(log, "tool_attempt")).toBe(2);
    expect(new Set(log.map((event) => event.pid)).size).toBe(2);
    const positions = log.map((event) => event.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(Math.min(...positions)).toBe(1);

    // Same table, own partition: the commit-log partition replayed on open holds no events.
    const digest = createHash("sha256").update(sessionId).digest("hex");
    expect(await partitionCount(`e#${digest}`, "EVENT#")).toBe(log.length);
    expect(await partitionCount(`s#${digest}`, "EVENT#")).toBe(0);
    expect(await partitionCount(`s#${digest}`, "COMMIT#")).toBeGreaterThan(0);

    // Nothing of the session lives in the instance's local state directory.
    for (const handle of [first, reader]) {
      const files = await listFiles(handle.state);
      expect(files.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    }
  }, 60_000);
});
