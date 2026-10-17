import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createDynamoDbDocumentClient,
  ensureSessionTable,
  sessionPk,
} from "./storage/dynamodb.js";
import { configuredStorageBackend, type StorageBackend } from "./storage/open.js";

export interface RecordedEvent {
  position: number;
  timestamp: string;
  pid: number;
  sessionId: string;
  kind: string;
  detail: unknown;
}

/**
 * Append-only observability log of one session (`/events`). Recording never
 * throws into the agent: a failed write is reported on stderr and skipped.
 */
export interface EventLog {
  readonly sessionId: string;
  readonly location: string;
  record(kind: string, detail: unknown): Promise<void>;
  flush(): Promise<void>;
  readAll(): Promise<RecordedEvent[]>;
}

const MAX_DETAIL_BYTES = 300_000;
const EVENT_PREFIX = "EVT#";
const COUNTER_SK = "EVTSEQ";

export function eventsPk(sessionId: string): string {
  return `${sessionPk(sessionId)}#events`;
}

function encodeDetail(detail: unknown): string {
  const json = JSON.stringify(detail ?? null);
  if (Buffer.byteLength(json, "utf8") <= MAX_DETAIL_BYTES) return json;
  return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(json) });
}

function printEvent(event: RecordedEvent): void {
  process.stdout.write(
    `[checkpoint ${event.position}] ${event.kind} ${JSON.stringify(event.detail)}\n`,
  );
}

/**
 * Event log in the session table, in its own partition (`s#<sha256>#events`)
 * so Pi commit-log recovery never reads it. Positions come from an atomic
 * counter, so they stay unique and increasing across processes and microVMs.
 */
export class DynamoDbEventLog implements EventLog {
  readonly sessionId: string;
  readonly location: string;
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #pk: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    sessionId: string;
    tableName: string;
    docs: DynamoDBDocumentClient;
  }) {
    this.sessionId = options.sessionId;
    this.#tableName = options.tableName;
    this.#docs = options.docs;
    this.#pk = eventsPk(options.sessionId);
    this.location = `dynamodb:${options.tableName}#${this.#pk}`;
  }

  record(kind: string, detail: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    const detailJson = encodeDetail(detail);
    this.#tail = this.#tail.then(async () => {
      try {
        const counter = await this.#docs.send(
          new UpdateCommand({
            TableName: this.#tableName,
            Key: { pk: this.#pk, sk: COUNTER_SK },
            UpdateExpression: "ADD #next :one",
            ExpressionAttributeNames: { "#next": "next" },
            ExpressionAttributeValues: { ":one": 1 },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        const position = Number(counter.Attributes?.next);
        await this.#docs.send(
          new PutCommand({
            TableName: this.#tableName,
            Item: {
              pk: this.#pk,
              sk: `${EVENT_PREFIX}${String(position).padStart(16, "0")}`,
              kind,
              position,
              timestamp,
              pid: process.pid,
              sessionId: this.sessionId,
              detail: detailJson,
            },
          }),
        );
        printEvent({
          position,
          timestamp,
          pid: process.pid,
          sessionId: this.sessionId,
          kind,
          detail: JSON.parse(detailJson) as unknown,
        });
      } catch (error) {
        process.stderr.write(
          `EVENT_LOG_WRITE_FAILED ${kind}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
    return this.#tail;
  }

  flush(): Promise<void> {
    return this.#tail;
  }

  readAll(): Promise<RecordedEvent[]> {
    return readDynamoDbEvents(this.#docs, this.#tableName, this.sessionId);
  }
}

export async function readDynamoDbEvents(
  docs: DynamoDBDocumentClient,
  tableName: string,
  sessionId: string,
): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await docs.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": eventsPk(sessionId),
          ":prefix": EVENT_PREFIX,
        },
        ConsistentRead: true,
        ...(start !== undefined ? { ExclusiveStartKey: start } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      events.push({
        position: Number(item.position),
        timestamp: String(item.timestamp),
        pid: Number(item.pid),
        sessionId: String(item.sessionId),
        kind: String(item.kind),
        detail: JSON.parse(String(item.detail ?? "null")) as unknown,
      });
    }
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start !== undefined);
  return events;
}

/** The pre-DynamoDB file log, kept for `STORAGE_BACKEND=sqlite`. */
export class JsonlEventLog implements EventLog {
  readonly sessionId: string;
  readonly location: string;
  #position = 0;
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, sessionId: string) {
    this.location = path;
    this.sessionId = sessionId;
  }

  static async open(path: string, sessionId: string): Promise<JsonlEventLog> {
    await mkdir(dirname(path), { recursive: true });
    const log = new JsonlEventLog(path, sessionId);
    const previous = (await log.readAll()).at(-1);
    if (previous) log.#position = previous.position;
    return log;
  }

  record(kind: string, detail: unknown): Promise<void> {
    const event: RecordedEvent = {
      position: ++this.#position,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      sessionId: this.sessionId,
      kind,
      detail,
    };
    this.#tail = this.#tail.then(async () => {
      try {
        await appendFile(this.location, `${JSON.stringify(event)}\n`, "utf8");
        printEvent(event);
      } catch (error) {
        process.stderr.write(
          `EVENT_LOG_WRITE_FAILED ${kind}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
    return this.#tail;
  }

  flush(): Promise<void> {
    return this.#tail;
  }

  async readAll(): Promise<RecordedEvent[]> {
    try {
      return (await readFile(this.location, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export function sessionTableName(): string {
  return process.env.DYNAMODB_TABLE ?? "pi-durable-agentcore-sessions";
}

let sharedDocs: DynamoDBDocumentClient | undefined;
let tableReady: Promise<void> | undefined;

/** One document client per process for the side tables (events, control). */
export async function sessionTableClient(): Promise<DynamoDBDocumentClient> {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const options = {
    ...(endpoint !== undefined && endpoint !== "" ? { endpoint } : {}),
    ...(region !== undefined && region !== "" ? { region } : {}),
  };
  sharedDocs ??= createDynamoDbDocumentClient(options);
  if (endpoint) {
    // DynamoDB Local only: AWS tables come from CloudFormation.
    tableReady ??= ensureSessionTable(sessionTableName(), options).catch(
      (error: unknown) => {
        tableReady = undefined;
        throw error;
      },
    );
    await tableReady;
  }
  return sharedDocs;
}

export async function openEventLog(options: {
  sessionId: string;
  sessionPath: string;
  backend?: StorageBackend;
}): Promise<EventLog> {
  const backend = options.backend ?? configuredStorageBackend();
  if (backend === "dynamodb") {
    return new DynamoDbEventLog({
      sessionId: options.sessionId,
      tableName: sessionTableName(),
      docs: await sessionTableClient(),
    });
  }
  return JsonlEventLog.open(
    join(options.sessionPath, "events.jsonl"),
    options.sessionId,
  );
}
