import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ddb from "@aws-sdk/client-dynamodb";

export const TABLE = process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";
export const SIGNING_KEY = "test-approver-signing-key-0123456789abcdef";

export interface ServerHandle {
  readonly port: number;
  /** The server's STATE_DIRECTORY (formerly held events.jsonl and tool-attempts.jsonl). */
  readonly state: string;
  readonly output: () => string;
  readonly child: ChildProcessWithoutNullStreams;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

const temporary: string[] = [];

export async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

export async function cleanupTemporary(): Promise<void> {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

/** Start `dist/server.js` on a random port against DynamoDB Local. */
export async function startServer(
  env: Record<string, string> = {},
): Promise<ServerHandle> {
  const state = await temporaryDirectory("pi-agentcore-server-");
  for (let attempt = 0; ; attempt++) {
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
        APPROVAL_SIGNING_KEY: SIGNING_KEY,
        INFLIGHT_GRACE_MS: "3000",
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
    for (let wait = 0; wait < 200; wait++) {
      if (output.includes("listening on") || child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (output.includes("listening on")) {
      return {
        port,
        state,
        child,
        output: () => output,
        stop: async (signal = "SIGTERM") => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill(signal);
          await exited;
        },
      };
    }
    child.kill("SIGKILL");
    if (attempt >= 3) throw new Error(`server did not start:\n${output}`);
  }
}

export async function invoke(
  server: ServerHandle,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/invocations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

export interface LoggedEvent {
  position: number;
  pid: number;
  kind: string;
  detail: Record<string, unknown>;
}

export async function events(
  server: ServerHandle,
  sessionId: string,
): Promise<LoggedEvent[]> {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/events?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return ((await response.json()) as { events: LoggedEvent[] }).events;
}

export function count(list: readonly LoggedEvent[], kind: string): number {
  return list.filter((event) => event.kind === kind).length;
}

export async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sessionIdFor(prefix: string): string {
  // AgentCore runtime session ids are 33-256 characters.
  return `${prefix}-${crypto.randomUUID()}-${crypto.randomUUID().slice(0, 8)}`;
}

export function lowLevelClient(): ddb.DynamoDBClient {
  return new ddb.DynamoDBClient({
    region: process.env.AWS_REGION ?? "ap-northeast-1",
    endpoint: process.env.DYNAMODB_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
    },
  });
}

export interface SweepResult {
  due: number;
  claimed: number;
  invoked: number;
  failed: number;
  skipped: number;
}

export type Sweep = (options: {
  ddb: typeof ddb;
  client: ddb.DynamoDBClient;
  table: string;
  index: string;
  now?: number;
  claimMs?: number;
  maxClaims?: number;
  invoke: (sessionId: string, payload: Record<string, unknown>) => Promise<void>;
}) => Promise<SweepResult>;

/** The Lambda's inline code, extracted verbatim from the CloudFormation template. */
export async function sweeperSource(): Promise<string> {
  const template = await readFile("infra/github-oidc-bootstrap.yaml", "utf8");
  const lines = template.split("\n");
  const start = lines.findIndex((line) => line.trim() === "ZipFile: |");
  if (start === -1) throw new Error("ZipFile not found in the template");
  const indent = (lines[start]!.match(/^ */)?.[0].length ?? 0) + 2;
  const code: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    code.push(line.slice(indent));
  }
  return `${code.join("\n").trimEnd()}\n`;
}

export async function loadSweeper(): Promise<{ sweep: Sweep; source: string }> {
  const source = await sweeperSource();
  const directory = await temporaryDirectory("resume-sweeper-");
  const file = join(directory, "index.js");
  await writeFile(file, source);
  const module = createRequire(file)(file) as { sweep: Sweep; handler: unknown };
  return { sweep: module.sweep, source };
}

/** Run the sweeper against DynamoDB Local; resumes go to `server` like InvokeAgentRuntime would. */
export async function runSweeper(
  sweep: Sweep,
  route: (sessionId: string) => ServerHandle,
  options: { now?: number; wait?: boolean; onlySession?: string } = {},
): Promise<SweepResult & { sessions: string[] }> {
  const sessions: string[] = [];
  const result = await sweep({
    ddb,
    client: lowLevelClient(),
    table: TABLE,
    index: "wake-index",
    ...(options.now !== undefined ? { now: options.now } : {}),
    invoke: async (sessionId, payload) => {
      sessions.push(sessionId);
      // DynamoDB Local is shared by the whole suite: ignore other tests' sessions.
      if (options.onlySession !== undefined && sessionId !== options.onlySession) return;
      const response = await invoke(route(sessionId), sessionId, {
        ...payload,
        ...(options.wait ? { wait: true } : {}),
      });
      if (response.status >= 300) {
        throw new Error(`resume failed: ${response.status} ${JSON.stringify(response.body)}`);
      }
    },
  });
  return { ...result, sessions };
}

export async function wakeItem(
  sessionId: string,
): Promise<Record<string, ddb.AttributeValue> | undefined> {
  const { createHash } = await import("node:crypto");
  const pk = `w#${createHash("sha256").update(sessionId).digest("hex")}`;
  const result = await lowLevelClient().send(
    new ddb.GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: pk }, sk: { S: "WAKE" } },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}
