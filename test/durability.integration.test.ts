import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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
