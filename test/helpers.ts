import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export const APPROVAL_KEY = "local-test-approval-hmac-key-0123456789";

export interface RunningServer {
  readonly url: string;
  readonly child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

export async function startServer(
  state: string,
  env: Record<string, string> = {},
): Promise<RunningServer> {
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
      APPROVAL_HMAC_KEY: APPROVAL_KEY,
      PI_WAKE_HEARTBEAT_MS: "500",
      PI_WAKE_CRASH_GRACE_MS: "2500",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (output.includes("listening on")) break;
    if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
    await sleep(25);
  }
  if (!output.includes("listening on")) {
    child.kill("SIGKILL");
    throw new Error(`server did not start:\n${output}`);
  }
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}`,
    child,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

export async function invoke(
  server: { url: string },
  sessionId: string,
  payload: unknown,
): Promise<Reply> {
  const response = await fetch(`${server.url}/invocations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

export interface EventRow {
  position: number;
  pid: number;
  kind: string;
  detail: Record<string, unknown>;
}

export async function events(
  server: { url: string },
  sessionId: string,
): Promise<EventRow[]> {
  const response = await fetch(
    `${server.url}/events?sessionId=${encodeURIComponent(sessionId)}`,
  );
  const body = (await response.json()) as { events: EventRow[] };
  return body.events;
}

export async function status(
  server: { url: string },
  sessionId: string,
): Promise<{
  wake: { armed: boolean; reason?: string; dueAt?: number; approvalId?: string };
  approvals: { approvalId: string; status: string; decidedBy?: string }[];
}> {
  const response = await fetch(
    `${server.url}/status?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return (await response.json()) as never;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export function approverToken(sessionId: string, approvalId: string): string {
  return createHmac("sha256", APPROVAL_KEY)
    .update(`pi-durable-agentcore/approval/v1\0${sessionId}\0${approvalId}`)
    .digest("hex");
}

/** The exact `ZipFile` source of the auto-resume Lambda in the bootstrap template. */
export function autoResumeLambdaSource(): string {
  const lines = readFileSync("infra/github-oidc-bootstrap.yaml", "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s+ZipFile: \|\s*$/.test(line));
  if (start === -1) throw new Error("ZipFile block not found");
  const indent = (lines[start]?.search(/\S/) ?? 0) + 2;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return `${body.join("\n").trimEnd()}\n`;
}

export interface SweepResult {
  due: number;
  claimed: number;
  invoked: number;
  failed: number;
  dead: number;
}

type Sweep = (options: {
  ddb: DynamoDBClient;
  invoke: (sessionId: string, payload: unknown) => Promise<void>;
  table?: string;
  now?: number;
  retryMs?: number;
}) => Promise<SweepResult>;

/** Load the Lambda module as CommonJS, as the nodejs22.x runtime would. */
export function loadAutoResumeLambda(): { sweep: Sweep; handler: unknown } {
  const module = { exports: {} as { sweep: Sweep; handler: unknown } };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", autoResumeLambdaSource())(
    require,
    module,
    module.exports,
  );
  return module.exports;
}

let ddb: DynamoDBClient | undefined;

/**
 * Run the real sweeper against DynamoDB Local. `route` plays the part of
 * `InvokeAgentRuntime`: it sends the resume payload to a local server for the
 * sessions under test and ignores wakes left by other tests.
 */
export async function sweep(
  route: (sessionId: string) => { url: string } | undefined,
  calls: { sessionId: string; payload: unknown; status: number }[] = [],
): Promise<SweepResult> {
  ddb ??= new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: process.env.AWS_REGION ?? "ap-northeast-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const { sweep: run } = loadAutoResumeLambda();
  return run({
    ddb,
    table: process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions",
    invoke: async (sessionId, payload) => {
      const server = route(sessionId);
      if (server === undefined) return;
      const reply = await invoke(server, sessionId, payload);
      calls.push({ sessionId, payload, status: reply.status });
      if (reply.status !== 200) {
        throw new Error(`resume returned ${reply.status}: ${reply.text}`);
      }
    },
  });
}

export function ofKind(rows: EventRow[], kind: string): EventRow[] {
  return rows.filter((row) => row.kind === kind);
}
