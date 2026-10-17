import { describe, expect, it } from "vitest";
import { toolIdempotencyKey } from "../src/idempotency.js";

describe("toolIdempotencyKey", () => {
  const base = { sessionId: "agentcore-session-0123456789abcdef0123", conversationId: 1, taskId: 12 };

  it("is stable for the same tool task (retry, replay, resume)", () => {
    expect(toolIdempotencyKey(base)).toBe(toolIdempotencyKey({ ...base }));
    expect(toolIdempotencyKey(base)).toBe(
      toolIdempotencyKey({ ...base, conversationId: "1", taskId: "12" }),
    );
  });

  it("is unique per tool task, conversation and session", () => {
    const keys = new Set([
      toolIdempotencyKey(base),
      toolIdempotencyKey({ ...base, taskId: 13 }),
      toolIdempotencyKey({ ...base, conversationId: 2 }),
      toolIdempotencyKey({ ...base, sessionId: `${base.sessionId}x` }),
      // Field boundaries are separated, so shifting digits does not collide.
      toolIdempotencyKey({ ...base, conversationId: 11, taskId: 2 }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("hashes the session id instead of exposing it", () => {
    const key = toolIdempotencyKey(base);
    expect(key).toMatch(/^tk_[0-9a-f]{64}$/);
    expect(key).not.toContain(base.sessionId);
    expect(key).not.toContain(Buffer.from(base.sessionId).toString("hex"));
  });
});
