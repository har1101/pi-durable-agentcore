import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { count, events, ping, post, Scenario, until } from "./support/processes.js";

const scenarios: Scenario[] = [];
afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});
function scenario(): Scenario {
  const created = new Scenario();
  scenarios.push(created);
  return created;
}

describe("server health", () => {
  it("answers /ping at once while a session open waits for its lease, and stays Healthy after it fails", async () => {
    const s = scenario();
    const sessionId = `ping-${randomUUID()}`;
    const holder = await s.server({ SCRIPTED_TOOL_DELAY_MS: "15000" });
    void post(holder, sessionId, { prompt: "Long tool." }).catch(() => undefined);
    await until(
      async () => count(await events(holder, sessionId), "tool_call_started") > 0 || undefined,
      15_000,
      "the holder's tool to start",
    );

    const waiter = await s.server({ PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS: "4000" });
    const blocked = post(waiter, sessionId, { prompt: "Long tool." });
    await until(
      async () => ((await ping(waiter)) === "HealthyBusy" ? true : undefined),
      2_000,
      "HealthyBusy while the open waits for the lease",
    );
    expect((await blocked).status).toBe(500);
    expect(await ping(waiter)).toBe("Healthy");
  });
});

describe("server startup", () => {
  it("refuses to start with an invalid PI_APPROVAL_TIMEOUT_MS", async () => {
    await expect(scenario().server({ PI_APPROVAL_TIMEOUT_MS: "0" })).rejects.toThrow(
      /PI_APPROVAL_TIMEOUT_MS must be a positive integer of milliseconds, got "0"/,
    );
  });
});
