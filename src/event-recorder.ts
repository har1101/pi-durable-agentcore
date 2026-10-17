import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { sessionHash } from "./storage/dynamodb.js";

export interface RecordedEvent {
  position: number;
  timestamp: string;
  pid: number;
  sessionId: string;
  kind: string;
  detail: unknown;
}

/**
 * Append-only observability log of one session: model/tool events, commit
 * batches, tool attempts. `record()` never rejects (a failed write is reported
 * on stderr) so observability cannot fail the agent; awaiting it means the
 * event and every earlier one were written.
 */
export interface EventRecorder {
  readonly sessionId: string;
  /** Where the log lives, for `runtime_opened`. */
  readonly location: string;
  record(kind: string, detail: unknown): Promise<void>;
  flush(): Promise<void>;
  /** Every event, in position order. */
  list(): Promise<RecordedEvent[]>;
}

/** DynamoDB items are capped at 400 KB; keep event payloads well below it. */
const MAX_DETAIL_BYTES = 300_000;

function boundedDetail(detail: unknown): string {
  const json = JSON.stringify(detail ?? null);
  if (Buffer.byteLength(json, "utf8") <= MAX_DETAIL_BYTES) return json;
  return JSON.stringify({
    truncated: true,
    bytes: Buffer.byteLength(json, "utf8"),
    sha256: createHash("sha256").update(json).digest("hex"),
    preview: json.slice(0, 2_000),
  });
}

function announce(event: RecordedEvent): void {
  process.stdout.write(
    `[checkpoint ${event.position}] ${event.kind} ${JSON.stringify(event.detail)}\n`,
  );
}

const EVENT_PREFIX = "EVENT#";
const EVENT_SEQ_SK = "EVENTSEQ";

/** Partition of a session's event log: same table, separate from its commit log. */
export function eventPartitionKey(sessionId: string): string {
  return `e#${sessionHash(sessionId)}`;
}

/**
 * Event log in the session table, in its own partition (`e#<sha256>`), so it
 * survives microVM replacement without slowing the commit-log replay that
 * reads the `s#<sha256>` partition. Positions come from an atomic counter, so
 * they stay monotonic across processes and microVMs.
 */
export class DynamoDbEventRecorder implements EventRecorder {
  readonly sessionId: string;
  readonly location: string;
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #pk: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(docs: DynamoDBDocumentClient, tableName: string, sessionId: string) {
    this.#docs = docs;
    this.#tableName = tableName;
    this.sessionId = sessionId;
    this.#pk = eventPartitionKey(sessionId);
    this.location = `dynamodb:${tableName}#${this.#pk}`;
  }

  record(kind: string, detail: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    const detailJson = boundedDetail(detail);
    this.#tail = this.#tail.then(async () => {
      try {
        const counter = await this.#docs.send(
          new UpdateCommand({
            TableName: this.#tableName,
            Key: { pk: this.#pk, sk: EVENT_SEQ_SK },
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
        announce({
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

  async list(): Promise<RecordedEvent[]> {
    const events: RecordedEvent[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.#docs.send(
        new QueryCommand({
          TableName: this.#tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": this.#pk, ":prefix": EVENT_PREFIX },
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
          detail: JSON.parse(String(item.detail)) as unknown,
        });
      }
      start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start !== undefined);
    return events;
  }
}

/** JSONL log next to a SQLite session (the optional `STORAGE_BACKEND=sqlite`). */
export class FileEventRecorder implements EventRecorder {
  readonly path: string;
  readonly sessionId: string;
  readonly location: string;
  #position = 0;
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, sessionId: string) {
    this.path = path;
    this.sessionId = sessionId;
    this.location = path;
  }

  static async open(path: string, sessionId: string): Promise<FileEventRecorder> {
    await mkdir(dirname(path), { recursive: true });
    const recorder = new FileEventRecorder(path, sessionId);
    const previous = (await recorder.list()).at(-1);
    if (previous) recorder.#position = previous.position;
    return recorder;
  }

  record(kind: string, detail: unknown): Promise<void> {
    const event: RecordedEvent = {
      position: ++this.#position,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      sessionId: this.sessionId,
      kind,
      detail: JSON.parse(boundedDetail(detail)) as unknown,
    };
    this.#tail = this.#tail.then(async () => {
      try {
        await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
        announce(event);
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

  async list(): Promise<RecordedEvent[]> {
    try {
      return (await readFile(this.path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
