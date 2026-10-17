import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { toolIdempotencyKey } from "../dist/tools.js";
import { cleanupTemporaryDirectories, startServer } from "./support/server.js";

afterEach(cleanupTemporaryDirectories);

describe("tool idempotency key", () => {
  it("is a stable hash of the session and tool task, without the raw session id", () => {
    const sessionId = `idem-session-${randomUUID()}`;
    const key = toolIdempotencyKey(sessionId, 12 as never);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(toolIdempotencyKey(sessionId, 12 as never)).toBe(key);
    expect(toolIdempotencyKey(sessionId, 13 as never)).not.toBe(key);
    expect(toolIdempotencyKey(`${sessionId}-other`, 12 as never)).not.toBe(key);
    expect(key).not.toContain(sessionId);
    expect(key).not.toContain(Buffer.from(sessionId).toString("hex"));
  });

  it("differs per tool use even when the provider reuses the tool call id", async () => {
    const sessionId = `idem-${randomUUID()}`;
    const server = await startServer(sessionId);
    try {
      for (const requestId of ["idem-1", "idem-2"]) {
        const result = await server.invoke({ prompt: "Use a tool.", requestId });
        expect(result.body.status).toBe("success");
      }
      const attempts = (await server.events())
        .filter((event) => event.kind === "tool_attempt")
        .map((event) => event.detail);
      expect(attempts).toHaveLength(2);
      expect(attempts[0].callId).toBe(attempts[1].callId);
      expect(attempts[0].idempotencyKey).not.toBe(attempts[1].idempotencyKey);
      for (const attempt of attempts) {
        expect(attempt.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
        expect(attempt.idempotencyKey).not.toContain(sessionId);
      }
    } finally {
      await server.kill("SIGTERM");
    }
  });
});
