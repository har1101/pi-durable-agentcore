import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

export interface RecordedEvent {
  position: number;
  timestamp: string;
  pid: number;
  sessionId: string;
  kind: string;
  detail: unknown;
}

/** Append-only, monotonically numbered observability log of one session. */
export interface EventLog {
  record(kind: string, detail: unknown): Promise<void>;
  flush(): Promise<void>;
  list(): Promise<RecordedEvent[]>;
}

const EVENT_PREFIX = "EVT#";
const MAX_EVENT_BYTES = 350_000;
const MAX_POSITION_RETRIES = 8;

export function eventPartition(sessionId: string): string {
  return `e#${createHash("sha256").update(sessionId).digest("hex")}`;
}

function eventSk(position: number): string {
  return `${EVENT_PREFIX}${String(position).padStart(16, "0")}`;
}

function serialize(event: RecordedEvent): string {
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body, "utf8") <= MAX_EVENT_BYTES) return body;
  return JSON.stringify({
    ...event,
    detail: { truncated: true, bytes: Buffer.byteLength(body, "utf8") },
  });
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/**
 * Serializes appends in one process and echoes each to stdout, so CloudWatch
 * keeps a copy. Positions come from the backing store.
 */
abstract class QueuedEventLog implements EventLog {
  readonly sessionId: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Never rejects: a failed append is reported on stderr, not to the run. */
  record(kind: string, detail: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    const write = this.#tail.then(async () => {
      const position = await this.append((position) => ({
        position,
        timestamp,
        pid: process.pid,
        sessionId: this.sessionId,
        kind,
        detail,
      }));
      process.stdout.write(
        `[checkpoint ${position}] ${kind} ${JSON.stringify(detail)}\n`,
      );
    });
    this.#tail = write.catch((error: unknown) => {
      process.stderr.write(
        `EventLogError ${kind}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    return this.#tail;
  }

  flush(): Promise<void> {
    return this.#tail;
  }

  abstract list(): Promise<RecordedEvent[]>;
  protected abstract append(
    build: (position: number) => RecordedEvent,
  ): Promise<number>;
}

/**
 * Events live in their own partition (`e#<sha256(sessionId)>`) of the session
 * table, so they survive microVM replacement without slowing checkpoint
 * recovery, which reads only the session partition.
 */
export class DynamoDbEventLog extends QueuedEventLog {
  readonly #docs: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #pk: string;
  #last: number | undefined;

  constructor(docs: DynamoDBDocumentClient, tableName: string, sessionId: string) {
    super(sessionId);
    this.#docs = docs;
    this.#tableName = tableName;
    this.#pk = eventPartition(sessionId);
  }

  protected async append(
    build: (position: number) => RecordedEvent,
  ): Promise<number> {
    for (let attempt = 0; attempt < MAX_POSITION_RETRIES; attempt++) {
      const position = (this.#last ?? (await this.#lastPosition())) + 1;
      try {
        await this.#docs.send(
          new PutCommand({
            TableName: this.#tableName,
            Item: {
              pk: this.#pk,
              sk: eventSk(position),
              kind: "event",
              body: serialize(build(position)),
            },
            ConditionExpression: "attribute_not_exists(sk)",
          }),
        );
        this.#last = position;
        return position;
      } catch (error) {
        if (!isConditionalCheckFailed(error)) throw error;
        this.#last = undefined;
      }
    }
    throw new Error("Could not allocate an event position");
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
        events.push(JSON.parse(String(item.body)) as RecordedEvent);
      }
      start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start !== undefined);
    return events;
  }

  async #lastPosition(): Promise<number> {
    const page = await this.#docs.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": this.#pk, ":prefix": EVENT_PREFIX },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }),
    );
    const sk = page.Items?.[0]?.sk;
    return typeof sk === "string" ? Number(sk.slice(EVENT_PREFIX.length)) : 0;
  }
}

/** Local JSONL log for the optional SQLite backend. */
export class FileEventLog extends QueuedEventLog {
  readonly path: string;
  #last: number | undefined;

  constructor(path: string, sessionId: string) {
    super(sessionId);
    this.path = path;
  }

  protected async append(
    build: (position: number) => RecordedEvent,
  ): Promise<number> {
    if (this.#last === undefined) {
      this.#last = (await this.list()).at(-1)?.position ?? 0;
    }
    const position = this.#last + 1;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${serialize(build(position))}\n`, "utf8");
    this.#last = position;
    return position;
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
