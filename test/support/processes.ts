import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RecordedEvent {
  readonly position: number;
  readonly pid: number;
  readonly kind: string;
  readonly detail: Record<string, unknown> | null;
}

export interface ServerProcess {
  readonly base: string;
  readonly pid: number;
  output(): string;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

/** One scenario: its own state directory and DynamoDB Local table, and every process it started. */
export class Scenario {
  readonly table = `test-${randomUUID()}`;
  readonly #children: ChildProcess[] = [];
  readonly #directories: string[] = [];

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      STORAGE_BACKEND: "dynamodb",
      DYNAMODB_TABLE: this.table,
      MODEL_PROVIDER: "scripted",
      PI_SESSION_LEASE_ACQUIRE_TIMEOUT_MS: "3000",
      ...extra,
    };
  }

  async server(extra: Record<string, string> = {}): Promise<ServerProcess> {
    const port = await freePort();
    const state = await mkdtemp(join(tmpdir(), "pi-scenario-"));
    this.#directories.push(state);
    const child = spawn(process.execPath, ["dist/server.js"], {
      cwd: process.cwd(),
      env: this.env({
        HOST: "127.0.0.1",
        PORT: String(port),
        STATE_DIRECTORY: state,
        SCRIPTED_TOOL_DELAY_MS: "10",
        ...extra,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#children.push(child);
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await until(
      async () => {
        if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
        return output.includes("listening on") || undefined;
      },
      10_000,
      "server listening",
    );
    return {
      base: `http://127.0.0.1:${port}`,
      pid: child.pid!,
      output: () => output,
      kill: async (signal = "SIGKILL") => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        await exited;
      },
    };
  }

  /** Runs one sweep of the wake sweeper CLI against `target`, as the Lambda would against AgentCore. */
  async sweep(target: ServerProcess): Promise<SweepResult> {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["dist/wake-sweep-cli.js", "--target", target.base],
      { cwd: process.cwd(), env: this.env(), timeout: 30_000 },
    );
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as SweepResult;
  }

  async dispose(): Promise<void> {
    for (const child of this.#children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(
      this.#directories.map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}

export interface SweepResult {
  readonly due: number;
  readonly outcomes: Record<string, string>;
}

export async function post(
  server: ServerProcess,
  sessionId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${server.base}/invocations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export async function events(
  server: ServerProcess,
  sessionId: string,
): Promise<RecordedEvent[]> {
  const response = await fetch(
    `${server.base}/events?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (response.status !== 200) {
    throw new Error(`/events ${response.status}: ${await response.text()}`);
  }
  return ((await response.json()) as { events: RecordedEvent[] }).events;
}

export function count(list: readonly RecordedEvent[], kind: string): number {
  return list.filter((event) => event.kind === kind).length;
}

export async function ping(server: ServerProcess): Promise<string> {
  const response = await fetch(`${server.base}/ping`);
  return ((await response.json()) as { status: string }).status;
}

/** Polls `probe` until it returns a value, failing after `timeoutMs`. */
export async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function sleepUntil(epochMs: number): Promise<void> {
  const remaining = epochMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}
