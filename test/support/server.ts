import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ServerProcess {
  readonly port: number;
  readonly child: ChildProcessWithoutNullStreams;
  output(): string;
  invoke(body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  events(): Promise<Array<{ kind: string; pid: number; detail: any }>>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

const temporaryDirectories: string[] = [];

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

export async function startServer(
  sessionId: string,
  env: Record<string, string> = {},
): Promise<ServerProcess> {
  const state = await mkdtemp(join(tmpdir(), "pi-agentcore-server-"));
  temporaryDirectories.push(state);
  const port = 20_000 + Math.floor(Math.random() * 10_000);
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
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  for (let attempt = 0; attempt < 200 && !output.includes("listening on"); attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!output.includes("listening on")) throw new Error(`server did not start:\n${output}`);

  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    child,
    output: () => output,
    async invoke(body, headers = {}) {
      const response = await fetch(`${base}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
          ...headers,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async events() {
      const response = await fetch(`${base}/events?sessionId=${encodeURIComponent(sessionId)}`);
      return ((await response.json()) as { events: any[] }).events;
    },
    async kill(signal = "SIGKILL") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await exited;
    },
  };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
