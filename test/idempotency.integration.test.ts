import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveToolIdempotencyKey,
  TOOL_IDEMPOTENCY_KEY_PATTERN,
} from "../dist/idempotency.js";
import {
  cleanupTemporary,
  events,
  invoke,
  sessionIdFor,
  startServer,
  type ServerHandle,
} from "./support.js";

const servers: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop("SIGKILL")));
  await cleanupTemporary();
});

describe("tool idempotency keys", () => {
  const base = {
    sessionId: "session-0123456789abcdef0123456789abcdef",
    conversationId: 1,
    taskId: 42,
    callId: "toolu_01",
    toolName: "durable_wait",
  };

  it("are deterministic, hashed, and differ per tool use", () => {
    const key = deriveToolIdempotencyKey(base);
    expect(key).toMatch(TOOL_IDEMPOTENCY_KEY_PATTERN);
    expect(deriveToolIdempotencyKey({ ...base })).toBe(key);
    // Same provider call id, another tool task: another key.
    expect(deriveToolIdempotencyKey({ ...base, taskId: 43 })).not.toBe(key);
    expect(deriveToolIdempotencyKey({ ...base, sessionId: `${base.sessionId}x` })).not.toBe(key);
    expect(key).not.toContain(base.sessionId);
    expect(key).not.toContain(createHash("sha256").update(base.sessionId).digest("hex"));
  });

  it("stay unique when the provider reuses a tool call id, and never expose the session id", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const sessionId = sessionIdFor("idem-reused-call-id");
    const server = await startServer({ SCRIPTED_TOOL_CALL_ID: "toolu_reused" });
    servers.push(server);
    for (const requestId of ["idem-1", "idem-2"]) {
      const result = await invoke(server, sessionId, { prompt: "Wait a bit.", requestId });
      expect(result.body.status).toBe("success");
    }
    const attempts = (await events(server, sessionId)).filter(
      (event) => event.kind === "tool_attempt",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.map((event) => event.detail.callId)).toEqual([
      "toolu_reused",
      "toolu_reused",
    ]);
    const keys = attempts.map((event) => String(event.detail.idempotencyKey));
    for (const key of keys) {
      expect(key).toMatch(TOOL_IDEMPOTENCY_KEY_PATTERN);
      expect(key).not.toContain(sessionId);
    }
    expect(new Set(keys).size).toBe(2);
    expect(new Set(attempts.map((event) => event.detail.taskId)).size).toBe(2);
    // The model never sees the raw session id through the key either.
    expect(server.output()).toContain("idem_v1_");
  }, 30_000);
});
