import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
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
  }, 50_000);

  it("serves the AgentCore HTTP contract with DynamoDB Local", async () => {
    expect(process.env.DYNAMODB_ENDPOINT).toMatch(/^http:\/\//);
    const state = await mkdtemp(join(tmpdir(), "pi-agentcore-http-"));
    temporaryDirectories.push(state);
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const sessionId = `http-${randomUUID()}`;
    const child = spawn(process.execPath, ["dist/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        STATE_DIRECTORY: state,
        MODEL_PROVIDER: "scripted",
        SCRIPTED_TOOL_DELAY_MS: "10",
        STORAGE_BACKEND: "dynamodb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (output.includes("listening on")) break;
        if (child.exitCode !== null)
          throw new Error(`server exited:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const ping = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(ping.status).toBe(200);
      expect(await ping.json()).toEqual({ status: "Healthy" });

      const invocation = await fetch(`http://127.0.0.1:${port}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
        },
        body: JSON.stringify({
          prompt: "Exercise the HTTP contract.",
          requestId: "http-integration",
        }),
      });
      expect(invocation.status).toBe(200);
      expect(await invocation.json()).toMatchObject({
        response: "Finished after the durable tool checkpoint was committed.",
        requestId: "http-integration",
        sessionId,
        status: "success",
      });

      const events = await fetch(
        `http://127.0.0.1:${port}/events?sessionId=${sessionId}`,
      );
      const eventBody = (await events.json()) as {
        events: Array<{ kind: string; detail?: { storage?: string } }>;
      };
      expect(
        eventBody.events.some((event) => event.kind === "tool_call_started"),
      ).toBe(true);
      expect(
        eventBody.events.some((event) => event.kind === "checkpoint_committed"),
      ).toBe(true);
      expect(
        eventBody.events.some(
          (event) =>
            event.kind === "runtime_opened" &&
            event.detail?.storage === "dynamodb",
        ),
      ).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
});
