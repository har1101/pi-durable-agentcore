import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRetries } from "../dist/event-recorder.js";

const transient = () => Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
const conditionFailed = () =>
  Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });

/** An operation that throws the given errors in order, then succeeds. */
function flaky(errors: Array<() => Error>) {
  const operation = vi.fn(async () => {
    const next = errors.shift();
    if (next) throw next();
  });
  return operation;
}

describe("event log write retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("treats a ConditionalCheckFailed on a retry as the earlier attempt having landed", async () => {
    const operation = flaky([transient, conditionFailed]);
    const done = withRetries(operation);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("still fails a ConditionalCheckFailed on the first attempt, which is a real collision", async () => {
    await expect(withRetries(flaky([conditionFailed]))).rejects.toThrow(
      "The conditional request failed",
    );
  });

  it("gives up after 4 attempts without a signal", async () => {
    const operation = flaky([transient, transient, transient, transient]);
    const done = withRetries(operation);
    const outcome = expect(done).rejects.toThrow("socket hang up");
    await vi.runAllTimersAsync();
    await outcome;
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it("keeps retrying past 4 attempts while its signal is live", async () => {
    const operation = flaky(Array.from({ length: 8 }, () => transient));
    const done = withRetries(operation, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(9);
  });

  it("stops with the signal's reason once it aborts, never with the write's error", async () => {
    const controller = new AbortController();
    const reason = new Error("harness closed");
    const operation = vi.fn(async () => {
      throw transient();
    });
    const done = withRetries(operation, controller.signal);
    const outcome = expect(done).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort(reason);
    await outcome;
  });
});
