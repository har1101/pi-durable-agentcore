import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { eventPk } from "./storage/dynamodb.js";
import {
  configuredStorageBackend,
  sessionTable,
  type StorageBackend,
} from "./storage/open.js";

export interface RecordedEvent {
  /** 1-based index in log order, derived when the log is read. */
  readonly position: number;
  readonly timestamp: string;
  readonly pid: number;
  readonly kind: string;
  readonly detail: unknown;
}

/** Append-only session event log. Each record resolves once it and every earlier record of this writer is stored. */
export interface EventLog {
  record(kind: string, detail: unknown): Promise<void>;
  list(): Promise<RecordedEvent[]>;
}

const MAX_DETAIL_BYTES = 64 * 1024;

export function openEventLog(options: {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly backend?: StorageBackend;
}): EventLog {
  return (options.backend ?? configuredStorageBackend()) === "dynamodb"
    ? new DynamoDbEventLog(options.sessionId)
    : new JsonlEventLog(join(options.sessionPath, "events.jsonl"));
}

function printEvent(position: number, kind: string, detail: unknown): void {
  process.stdout.write(
    `[checkpoint ${position}] ${kind} ${JSON.stringify(detail ?? null)}\n`,
  );
}

/**
 * Items `e#<sha256(sid)>` / `E#<13-digit ms>#<writer>#<6-digit seq>`: any process appends without coordination,
 * and the sort key orders one writer's events by seq and different writers by time.
 */
class DynamoDbEventLog implements EventLog {
  readonly #pk: string;
  readonly #writer = randomBytes(4).toString("hex");
  #seq = 0;
  #lastMs = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(sessionId: string) {
    this.#pk = eventPk(sessionId);
  }

  record(kind: string, detail: unknown): Promise<void> {
    const seq = ++this.#seq;
    const ms = Math.max(this.#lastMs, Date.now());
    this.#lastMs = ms;
    const json = JSON.stringify(detail ?? null);
    const truncated = Buffer.byteLength(json) > MAX_DETAIL_BYTES;
    const item = {
      pk: this.#pk,
      sk: `E#${String(ms).padStart(13, "0")}#${this.#writer}#${String(seq).padStart(6, "0")}`,
      kind,
      detail: truncated
        ? Buffer.from(json).subarray(0, MAX_DETAIL_BYTES).toString("utf8")
        : json,
      timestamp: new Date(ms).toISOString(),
      pid: process.pid,
      ...(truncated ? { truncated: true } : {}),
    };
    const write = async () => {
      const { docs, tableName } = await sessionTable();
      await withRetries(() =>
        docs.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(sk)",
          }),
        ),
      );
      printEvent(seq, kind, detail);
    };
    const run = this.#tail.catch(() => undefined).then(write);
    this.#tail = run;
    return run;
  }

  async list(): Promise<RecordedEvent[]> {
    const { docs, tableName } = await sessionTable();
    const events: RecordedEvent[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await docs.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": this.#pk },
          ConsistentRead: true,
          ...(start !== undefined ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        const text = String(item.detail);
        events.push({
          position: events.length + 1,
          timestamp: String(item.timestamp),
          pid: Number(item.pid),
          kind: String(item.kind),
          detail: item.truncated
            ? { truncated: true, preview: text }
            : (JSON.parse(text) as unknown),
        });
      }
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return events;
  }
}

async function withRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= 4 ||
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

/** The local log for STORAGE_BACKEND=sqlite, which has no shared table. */
class JsonlEventLog implements EventLog {
  readonly #path: string;
  #position: number | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  record(kind: string, detail: unknown): Promise<void> {
    const write = async () => {
      if (this.#position === undefined) {
        await mkdir(dirname(this.#path), { recursive: true });
        this.#position = (await this.list()).length;
      }
      const position = ++this.#position;
      const event: RecordedEvent = {
        position,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        kind,
        detail: detail ?? null,
      };
      await appendFile(this.#path, `${JSON.stringify(event)}\n`, "utf8");
      printEvent(position, kind, detail);
    };
    const run = this.#tail.catch(() => undefined).then(write);
    this.#tail = run;
    return run;
  }

  async list(): Promise<RecordedEvent[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecordedEvent);
  }
}
