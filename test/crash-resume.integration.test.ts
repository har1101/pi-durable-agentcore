import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTemporaryDirectories, startServer } from "./support/server.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await cleanupTemporaryDirectories();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("real process integration against DynamoDB Local", () => {
  it("SIGKILLs a live Pi tool task and resumes it from DynamoDB", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const state = await mkdtemp(join(tmpdir(), "pi-durable-integration-"));
    temporaryDirectories.push(state);
    const sessionId = `crash-resume-${randomUUID()}`;
    const { stdout, stderr } = await execFileAsync(
      "bash",
      ["scripts/demo-crash-resume.sh", state, "", sessionId],
      {
        cwd: process.cwd(),
        timeout: 45_000,
        maxBuffer: 2_000_000,
        env: process.env,
      },
    );

    expect(stderr.replace(/.*Killed.*\n?/g, "")).toBe("");
    expect(stdout).toContain("CRASHED pid=");
    expect(stdout).toContain("resume_called");
    expect(stdout).toContain("DEMO_RESULT");
    expect(stdout).toContain('"storage":"dynamodb"');
    expect(stdout).toContain("PASS crash->resume: attempts=2");

    const resumedLog = await readFile(
      join(state, "resumed-process.log"),
      "utf8",
    );
    expect(resumedLog).toContain("tool_call_completed");
    expect(resumedLog).toContain(
      "Finished after the durable tool checkpoint was committed.",
    );

    const listed = await execFileAsync(
      process.execPath,
      ["dist/demo-worker.js", "events", "--state-dir", state, "--session-id", sessionId],
      { cwd: process.cwd(), env: process.env, maxBuffer: 5_000_000 },
    );
    const events = listed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; pid: number; detail: any });
    const attempts = events.filter((event) => event.kind === "tool_attempt");
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((event) => event.pid)).size).toBe(2);
    expect(new Set(attempts.map((event) => event.detail.idempotencyKey)).size).toBe(1);
    expect(events.filter((event) => event.kind === "model_response")).toHaveLength(2);
  }, 50_000);

  it("serves the AgentCore HTTP contract with DynamoDB Local", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const sessionId = `http-${randomUUID()}`;
    const server = await startServer(sessionId);
    try {
      const ping = await fetch(`http://127.0.0.1:${server.port}/ping`);
      expect(ping.status).toBe(200);
      expect(await ping.json()).toEqual({ status: "Healthy" });

      const invocation = await server.invoke({
        prompt: "Exercise the HTTP contract.",
        requestId: "http-integration",
      });
      expect(invocation.status).toBe(200);
      expect(invocation.body).toMatchObject({
        response: "Finished after the durable tool checkpoint was committed.",
        requestId: "http-integration",
        sessionId,
        status: "success",
      });

      const events = await server.events();
      expect(events.some((event) => event.kind === "tool_call_started")).toBe(true);
      expect(events.some((event) => event.kind === "checkpoint_committed")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.kind === "runtime_opened" && event.detail?.storage === "dynamodb",
        ),
      ).toBe(true);
    } finally {
      await server.kill("SIGTERM");
    }
  });

  it("serves /events of a SIGKILLed process from a replacement process", async () => {
    const sessionId = `events-${randomUUID()}`;
    const first = await startServer(sessionId);
    await first.invoke({ prompt: "Leave durable events.", requestId: "events-1" });
    const firstPid = first.child.pid;
    await first.kill("SIGKILL");

    const replacement = await startServer(sessionId);
    try {
      const events = await replacement.events();
      const attempts = events.filter((event) => event.kind === "tool_attempt");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.pid).toBe(firstPid);
      const positions = events.map((event: any) => event.position as number);
      expect(positions).toEqual(positions.map((_, index) => index + 1));
      expect(events.every((event) => event.pid === firstPid)).toBe(true);
    } finally {
      await replacement.kill("SIGTERM");
    }
  });
});
